/**
 * Idle-rent detection (Step 16 part 2). Rented units sitting at a site whose project shows no milestone
 * activity for N days (TenantSettings.equipmentIdleDays, default 5) are idle: rent is being paid for
 * nothing.
 *
 *   activity of a project = the latest of
 *     PROGRESS          — a milestone progress / status update (MilestoneUpdate.date)
 *     USAGE             — a material-usage entry linked to a milestone (MaterialUsage.usageDate)
 *     MILESTONE_ACTIVE  — today, while a structure milestone (foundation … mumty) is IN_PROGRESS, or
 *                         CURING inside its curing lag (the slab is still propped)
 *   since    = max(last activity, the day the rented units arrived at the site)
 *   idleDays = today − since; idle when idleDays ≥ threshold
 *
 * Projects without a schedule have no activity: they count from the arrival (hasSchedule false).
 * Used by GET /equipment/idle, POST /equipment/idle/check and the daily `equipment-idle` job
 * (src/jobs/equipmentIdle.ts). Every query filters by tenantId (the job runs cross-tenant, outside RLS).
 */
import { loadAccess } from '../../core/auth/accessLoader.js';
import type { Tx } from '../../core/db/withTenant.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import { equipmentIdle } from '../notifications/alerts.js';
import { addDays, daysBetween } from './shuttering.js';
import { dayOf, D, equipmentRef, qn, valueOf, type Dec } from './equipment.shared.js';

export const DEFAULT_IDLE_DAYS = 5;
/** Stages whose IN_PROGRESS / CURING milestones count as work going on at the site. */
export const STRUCTURE_STAGES = ['FOUNDATION_PLINTH', 'GF_STRUCTURE', 'F1_STRUCTURE', 'F2_STRUCTURE', 'F3_STRUCTURE', 'MUMTY_ROOF'];

export type ActivityKind = 'PROGRESS' | 'USAGE' | 'MILESTONE_ACTIVE';

export interface IdleItem {
  equipment: ReturnType<typeof equipmentRef>;
  qty: number;
  ratePaisaPerDay: bigint;
  dailyCostPaisa: bigint;
}

export interface IdleRow {
  rental: { id: string; number: string; status: string; startDate: string; expectedEndDate: string | null; supplier: { id: string; name: string } };
  project: { id: string; code: string; name: string };
  location: { id: string; type: 'STORE' | 'TRANSIT' | 'SITE'; name: string; projectId: string | null };
  items: IdleItem[];
  qty: number;
  since: string;
  lastActivity: { kind: ActivityKind; date: string } | null;
  hasSchedule: boolean;
  idleDays: number;
  thresholdDays: number;
  idle: boolean;
  dailyCostPaisa: bigint;
}

export async function idleThreshold(tx: Tx, tenantId: string): Promise<number> {
  const s = await tx.tenantSettings.findUnique({ where: { tenantId }, select: { equipmentIdleDays: true } });
  return s?.equipmentIdleDays ?? DEFAULT_IDLE_DAYS;
}

/** Latest activity per project (see the header). */
export async function projectActivity(tx: Tx, tenantId: string, projectIds: string[], today: string): Promise<Map<string, { kind: ActivityKind; date: string }>> {
  const out = new Map<string, { kind: ActivityKind; date: string }>();
  if (!projectIds.length) return out;
  const better = (p: string, kind: ActivityKind, date: string) => {
    const cur = out.get(p);
    if (!cur || date > cur.date) out.set(p, { kind, date });
  };
  const updates = await tx.milestoneUpdate.groupBy({ by: ['projectId'], where: { tenantId, projectId: { in: projectIds } }, _max: { date: true } });
  for (const u of updates) if (u._max.date) better(u.projectId, 'PROGRESS', formatDateOnly(u._max.date));
  const usage = await tx.materialUsage.groupBy({ by: ['projectId'], where: { tenantId, projectId: { in: projectIds }, milestoneId: { not: null } }, _max: { usageDate: true } });
  for (const u of usage) if (u._max.usageDate) better(u.projectId, 'USAGE', formatDateOnly(u._max.usageDate));
  const running = await tx.milestone.findMany({
    where: { tenantId, projectId: { in: projectIds }, status: { in: ['IN_PROGRESS', 'CURING'] }, stage: { stageKey: { in: STRUCTURE_STAGES } } },
    select: { projectId: true, status: true, plannedEnd: true, actualEnd: true, curingDays: true },
  });
  for (const m of running) {
    const curingUntil = addDays(formatDateOnly(m.actualEnd ?? m.plannedEnd), m.curingDays);
    if (m.status === 'IN_PROGRESS' || curingUntil >= today) out.set(m.projectId, { kind: 'MILESTONE_ACTIVE', date: today });
  }
  return out;
}

/**
 * Every ACTIVE rental's units on hand at a SITE, with how long the site has been idle.
 * `locationIds` limits to the caller's locations (null = all); `projectId` to one project.
 */
export async function idleRentals(tx: Tx, tenantId: string, today: string, opts: { locationIds?: string[] | null; projectId?: string; threshold?: number } = {}): Promise<IdleRow[]> {
  const threshold = opts.threshold ?? (await idleThreshold(tx, tenantId));
  const rentals = await tx.equipmentRental.findMany({
    where: { tenantId, status: 'ACTIVE' },
    include: { supplier: { select: { id: true, name: true } }, items: { include: { equipment: true } } },
  });
  if (!rentals.length) return [];
  const byId = new Map(rentals.map((r) => [r.id, r]));
  const rows = await tx.equipmentMovement.groupBy({
    by: ['locationId', 'equipmentId', 'rentalId'],
    where: { tenantId, rentalId: { in: [...byId.keys()] }, ...(opts.locationIds ? { locationId: { in: opts.locationIds } } : {}) },
    _sum: { quantity: true },
  });
  const held = rows.filter((r) => r.rentalId && (r._sum.quantity ?? D(0)).gt(0));
  const sites = await tx.stockLocation.findMany({
    where: { tenantId, type: 'SITE', id: { in: [...new Set(held.map((r) => r.locationId))] }, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
    select: { id: true, type: true, name: true, projectId: true, project: { select: { id: true, code: true, name: true } } },
  });
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const onSite = held.filter((r) => siteById.has(r.locationId) && siteById.get(r.locationId)!.project);
  if (!onSite.length) return [];
  const projectIds = [...new Set(sites.map((s) => s.projectId!).filter(Boolean))];
  const activity = await projectActivity(tx, tenantId, projectIds, today);
  const scheduled = new Set((await tx.schedule.findMany({ where: { tenantId, projectId: { in: projectIds } }, select: { projectId: true } })).map((s) => s.projectId));
  const arrivals = await tx.equipmentMovement.groupBy({
    by: ['locationId', 'rentalId'],
    where: { tenantId, rentalId: { in: [...new Set(onSite.map((r) => r.rentalId!))] }, locationId: { in: [...new Set(onSite.map((r) => r.locationId))] }, quantity: { gt: 0 } },
    _max: { occurredAt: true },
  });
  const arrivedOn = new Map(arrivals.map((a) => [`${a.locationId}:${a.rentalId}`, a._max.occurredAt ? dayOf(a._max.occurredAt) : today]));

  const groups = new Map<string, typeof onSite>();
  for (const r of onSite) {
    const key = `${r.rentalId}:${r.locationId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: IdleRow[] = [];
  for (const [key, list] of groups) {
    const [rentalId, locationId] = key.split(':') as [string, string];
    const rental = byId.get(rentalId)!;
    const site = siteById.get(locationId)!;
    const project = site.project!;
    const items: IdleItem[] = list
      .map((r) => {
        const item = rental.items.find((i) => i.equipmentId === r.equipmentId);
        const qty: Dec = r._sum.quantity!;
        const rate = item?.ratePaisaPerDay ?? 0n;
        return { equipment: equipmentRef(item?.equipment ?? { id: r.equipmentId, name: '', code: null, unit: 'nos', kind: 'BULK', category: 'OTHER' }), qty: qn(qty), ratePaisaPerDay: rate, dailyCostPaisa: valueOf(qty, rate) };
      })
      .sort((a, b) => a.equipment.name.localeCompare(b.equipment.name));
    const last = activity.get(project.id) ?? null;
    const arrived = arrivedOn.get(`${locationId}:${rentalId}`) ?? formatDateOnly(rental.startDate);
    const since = last && last.date > arrived ? last.date : arrived;
    const idleDays = Math.max(0, daysBetween(since, today));
    out.push({
      rental: {
        id: rental.id,
        number: rental.number,
        status: rental.status,
        startDate: formatDateOnly(rental.startDate),
        expectedEndDate: rental.expectedEndDate ? formatDateOnly(rental.expectedEndDate) : null,
        supplier: rental.supplier,
      },
      project,
      location: { id: site.id, type: site.type, name: site.name, projectId: site.projectId },
      items,
      qty: items.reduce((s, i) => s + i.qty, 0),
      since,
      lastActivity: last,
      hasSchedule: scheduled.has(project.id),
      idleDays,
      thresholdDays: threshold,
      idle: idleDays >= threshold,
      dailyCostPaisa: items.reduce((s, i) => s + i.dailyCostPaisa, 0n),
    });
  }
  return out.sort((a, b) => b.idleDays - a.idleDays || a.rental.number.localeCompare(b.rental.number));
}

// ─── Alert ──────────────────────────────────────────────────────────────────

export interface IdleCheckResult {
  date: string;
  thresholdDays: number;
  checked: number;
  idle: number;
  notified: Array<{ rentalId: string; number: string; users: number }>;
}

/**
 * Sends EQUIPMENT_IDLE for every idle rental (one per rental, its sites together) to the active users
 * holding equipment.rental.manage for the project (owner, ALL_PROJECTS, or assigned) and the project's
 * PMs — with the daily rent for users with fields.rates. Deduped per rental per 7 days (notify).
 */
export async function runIdleCheckTx(tx: Tx, tenantId: string, now = new Date()): Promise<IdleCheckResult> {
  const today = dayOf(now);
  const thresholdDays = await idleThreshold(tx, tenantId);
  const rows = await idleRentals(tx, tenantId, today, { threshold: thresholdDays });
  const idle = rows.filter((r) => r.idle);
  const result: IdleCheckResult = { date: today, thresholdDays, checked: rows.length, idle: 0, notified: [] };
  if (!idle.length) return result;

  const users = await tx.user.findMany({
    where: { tenantId, status: 'ACTIVE', role: { in: ['THEKEDAR', 'PM', 'MUNSHI'] } },
    select: { id: true, tenantId: true, role: true, roleId: true, canSeeFinancials: true },
  });
  const access = new Map<string, Awaited<ReturnType<typeof loadAccess>>>();
  for (const u of users) access.set(u.id, await loadAccess(tx, { ...u, role: u.role as 'THEKEDAR' | 'PM' | 'MUNSHI' }));
  const assigned = await tx.userProjectAccess.findMany({ where: { tenantId, projectId: { in: [...new Set(idle.map((r) => r.project.id))] } }, select: { userId: true, projectId: true } });
  const team = (projectId: string) => new Set(assigned.filter((x) => x.projectId === projectId).map((x) => x.userId));

  const byRental = new Map<string, IdleRow[]>();
  for (const r of idle) byRental.set(r.rental.id, [...(byRental.get(r.rental.id) ?? []), r]);
  result.idle = byRental.size;
  for (const [rentalId, list] of byRental) {
    const first = list[0]!;
    const projectId = first.project.id;
    const members = team(projectId);
    const recipients = users.filter((u) => {
      const a = access.get(u.id)!;
      const holds = a.has.has('equipment.rental.manage') && (a.owner || a.scopes['equipment.rental.manage'] === 'ALL_PROJECTS' || members.has(u.id));
      return holds || (u.role === 'PM' && members.has(u.id));
    });
    const withCost = recipients.filter((u) => access.get(u.id)!.fieldAccess.rates).map((u) => u.id);
    const without = recipients.filter((u) => !access.get(u.id)!.fieldAccess.rates).map((u) => u.id);
    const counts = new Map<string, { name: string; qty: number }>();
    for (const r of list) for (const i of r.items) counts.set(i.equipment.id, { name: i.equipment.name, qty: (counts.get(i.equipment.id)?.qty ?? 0) + i.qty });
    const base = {
      tenantId,
      projectId,
      projectName: first.project.name,
      rentalId,
      number: first.rental.number,
      items: [...counts.values()].map((c) => `${c.qty} × ${c.name}`).join(', '),
      days: Math.max(...list.map((r) => r.idleDays)),
      dailyCostPaisa: list.reduce((s, r) => s + r.dailyCostPaisa, 0n),
      at: now,
    };
    let sent = 0;
    if (withCost.length) sent += (await equipmentIdle(tx, { ...base, userIds: withCost, withCost: true })).length;
    if (without.length) sent += (await equipmentIdle(tx, { ...base, userIds: without, withCost: false })).length;
    if (sent) result.notified.push({ rentalId, number: first.rental.number, users: sent });
  }
  return result;
}
