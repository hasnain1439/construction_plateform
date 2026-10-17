/**
 * Stoppage days: logged from site (REST or sync STOPPAGE_LOG, photo required except HOLIDAY),
 * approved / rejected in the office. Approved days become non-working days of the project, so the
 * not-done milestones (and their successors) are pushed and the plan gets a new version.
 *
 * Permissions: schedule.stoppage.create (log) · schedule.stoppage.approve (approve / reject) ·
 * schedule.plan.view (read). Every write is audited.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { DelayCategory, Prisma, StoppageReason } from '../../generated/prisma/client.js';
import { caller, type Caller } from '../projects/access.js';
import { addDays, daysOf, type WorkCalendar } from './calendar.js';
import type { ApproveStoppageInput, StoppageInput } from './schedule.schema.js';
import { stoppageApprovedNote } from './planNotes.js';
import { audit, day, loadCalendar, photosOf, projectFor, recomputePlan, SITE_STATUSES, today } from './schedule.shared.js';

type C = Pick<Caller, 'tenantId' | 'userId' | 'role'>;

export const stoppageInclude = { reportedBy: { select: { id: true, name: true } }, decidedBy: { select: { id: true, name: true } } } as const satisfies Prisma.StoppageDayInclude;
type Row = Prisma.StoppageDayGetPayload<{ include: typeof stoppageInclude }>;

export const DEFAULT_CATEGORY: Record<StoppageReason, DelayCategory> = {
  RAIN: 'EXCUSABLE',
  SMOG_BAN: 'EXCUSABLE',
  HOLIDAY: 'EXCUSABLE',
  OWNER_HOLD: 'OWNER',
  MATERIAL_SHORT: 'CONTRACTOR',
  LABOUR_SHORT: 'CONTRACTOR',
  OTHER: 'CONTRACTOR',
};

const notFound = () => new NotFound('STOPPAGE_NOT_FOUND', 'Stoppage not found');

/** Working days among the dates (company calendar; the stoppage itself not counted as off). */
export const stoppageDays = (dates: string[], cal: WorkCalendar) => dates.filter((d) => cal.isWorking(d, { ignoreStoppages: true })).length;

export async function stoppageDtos(tx: Tx, tenantId: string, rows: Row[], cal: WorkCalendar) {
  const out = [];
  for (const r of rows) {
    const dates = r.dates.map((d) => day(d)!).sort();
    const days = stoppageDays(dates, cal);
    out.push({
      id: r.id,
      projectId: r.projectId,
      dates,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      days,
      /** QA-B-22: NO_WORKING_DAYS = every date is an off day (Sunday / holiday) — accepted, but it delays nothing. */
      warning: days === 0 ? ('NO_WORKING_DAYS' as const) : null,
      reason: r.reason,
      category: r.category,
      status: r.status,
      note: r.note,
      photos: await photosOf(tx, tenantId, r.photoAttachmentIds),
      clientId: r.clientId,
      reportedBy: r.reportedBy,
      reportedAt: r.createdAt.toISOString(),
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
    });
  }
  return out;
}

async function one(tx: Tx, tenantId: string, id: string) {
  const r = await tx.stoppageDay.findUniqueOrThrow({ where: { id }, include: stoppageInclude });
  const { cal } = await loadCalendar(tx, tenantId);
  return (await stoppageDtos(tx, tenantId, [r], cal))[0]!;
}

async function findStoppage(tx: Tx, c: C, id: string, perm: string) {
  const r = await tx.stoppageDay.findFirst({ where: { tenantId: c.tenantId, id } });
  if (!r) throw notFound();
  try {
    await projectFor(tx, c as Caller, r.projectId, perm);
  } catch (err) {
    if (err instanceof NotFound) throw notFound();
    throw err;
  }
  return r;
}

// ─── Log ────────────────────────────────────────────────────────────────────

export async function createStoppageTx(tx: Tx, c: C, projectId: string, input: StoppageInput): Promise<{ created: boolean; stoppage: Awaited<ReturnType<typeof one>> }> {
  const project = await projectFor(tx, c as Caller, projectId, 'schedule.stoppage.create', SITE_STATUSES);
  if (input.clientId) {
    const again = await tx.stoppageDay.findFirst({ where: { tenantId: c.tenantId, clientId: input.clientId } });
    if (again) return { created: false, stoppage: await one(tx, c.tenantId, again.id) };
  }
  const dates = input.dates?.length ? [...new Set(input.dates)].sort() : daysOf(input.from!, input.to ?? input.from!);
  if (dates.length > 31) throw new BadRequest('VALIDATION_ERROR', 'At most 31 days in one stoppage', [{ path: 'to', message: 'At most 31 days' }]);
  if (dates.at(-1)! > addDays(today(), 60)) throw new BadRequest('DATE_TOO_FAR', 'Stoppage days can be logged up to 60 days ahead');
  if (input.reason === 'OTHER' && !input.note) throw new BadRequest('NOTE_REQUIRED', 'Write what stopped the work');
  const photos = input.photoAttachmentIds ?? [];
  if (input.reason !== 'HOLIDAY' && !photos.length) throw new BadRequest('PHOTO_REQUIRED', 'Add a photo of the site');
  if (photos.length) {
    const found = await tx.attachment.count({ where: { tenantId: c.tenantId, id: { in: photos }, kind: 'SITE_PHOTO' } });
    if (found !== new Set(photos).size) throw new BadRequest('INVALID_ATTACHMENT', 'A photo was not found — upload it again');
  }
  const clash = await tx.stoppageDay.findFirst({ where: { tenantId: c.tenantId, projectId: project.id, status: { in: ['PENDING', 'APPROVED'] }, dates: { hasSome: dates.map(dateOnly) } } });
  if (clash) {
    const taken = clash.dates.map((d) => day(d)!).filter((d) => dates.includes(d));
    throw new Conflict('STOPPAGE_OVERLAP', 'A stoppage is already logged for these days', { dates: taken, stoppageId: clash.id });
  }
  const r = await tx.stoppageDay.create({
    data: {
      tenantId: c.tenantId,
      projectId: project.id,
      dates: dates.map(dateOnly),
      reason: input.reason,
      category: DEFAULT_CATEGORY[input.reason],
      note: input.note ?? null,
      photoAttachmentIds: photos,
      clientId: input.clientId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      reportedById: c.userId,
    },
  });
  await audit(tx, c, 'stoppage.create', 'StoppageDay', r.id, { projectId: project.id, dates, reason: input.reason, photos: photos.length });
  return { created: true, stoppage: await one(tx, c.tenantId, r.id) };
}

export async function createStoppage(projectId: string, input: StoppageInput) {
  const c = caller();
  return withTenant(c.tenantId, (tx) => createStoppageTx(tx, c, projectId, input));
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function listStoppages(projectId: string, query: { status?: 'PENDING' | 'APPROVED' | 'REJECTED' | undefined }) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await projectFor(tx, c, projectId, 'schedule.plan.view');
    const rows = await tx.stoppageDay.findMany({ where: { tenantId: c.tenantId, projectId: project.id, ...(query.status ? { status: query.status } : {}) }, include: stoppageInclude, orderBy: { createdAt: 'desc' } });
    const { cal } = await loadCalendar(tx, c.tenantId);
    const items = await stoppageDtos(tx, c.tenantId, rows, cal);
    const all = query.status ? await tx.stoppageDay.findMany({ where: { tenantId: c.tenantId, projectId: project.id }, include: stoppageInclude }) : rows;
    const approvedDays = { OWNER: 0, EXCUSABLE: 0, CONTRACTOR: 0 };
    for (const r of all.filter((x) => x.status === 'APPROVED')) approvedDays[r.category] += stoppageDays(r.dates.map((d) => day(d)!), cal);
    return { items, summary: { pending: all.filter((x) => x.status === 'PENDING').length, approvedDays } };
  });
}

export async function getStoppage(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const r = await findStoppage(tx, c, id, 'schedule.plan.view');
    return one(tx, c.tenantId, r.id);
  });
}

// ─── Decide ─────────────────────────────────────────────────────────────────

export async function approveStoppageTx(tx: Tx, c: C, id: string, input: ApproveStoppageInput, opts: { at?: Date } = {}) {
  const r = await findStoppage(tx, c, id, 'schedule.stoppage.approve');
  if (r.status !== 'PENDING') throw new Conflict('STOPPAGE_NOT_PENDING', `This stoppage is already ${r.status.toLowerCase()}`, { status: r.status });
  const category = input.category ?? r.category;
  await tx.stoppageDay.update({ where: { id: r.id }, data: { status: 'APPROVED', category, decidedById: c.userId, decidedAt: opts.at ?? new Date(), decisionNote: input.note ?? null } });
  const schedule = await tx.schedule.findFirst({ where: { projectId: r.projectId }, select: { id: true } });
  const dates = r.dates.map((d) => day(d)!);
  const plan = schedule
    ? await recomputePlan(tx, c, schedule.id, { reason: 'STOPPAGE_APPROVED', note: stoppageApprovedNote(r.reason, dates) })
    : { shifted: [], plannedEnd: null };
  await audit(tx, c, 'stoppage.approve', 'StoppageDay', r.id, { projectId: r.projectId, dates, reason: r.reason, category, shifted: plan.shifted.length, plannedEnd: plan.plannedEnd } as Prisma.InputJsonValue);
  return { stoppage: await one(tx, c.tenantId, r.id), shifted: plan.shifted, plannedEnd: plan.plannedEnd };
}

export async function approveStoppage(id: string, input: ApproveStoppageInput) {
  const c = caller();
  return withTenant(c.tenantId, (tx) => approveStoppageTx(tx, c, id, input), { timeout: 30_000 });
}

export async function rejectStoppage(id: string, input: { note: string }) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const r = await findStoppage(tx, c, id, 'schedule.stoppage.approve');
    if (r.status !== 'PENDING') throw new Conflict('STOPPAGE_NOT_PENDING', `This stoppage is already ${r.status.toLowerCase()}`, { status: r.status });
    await tx.stoppageDay.update({ where: { id: r.id }, data: { status: 'REJECTED', decidedById: c.userId, decidedAt: new Date(), decisionNote: input.note } });
    await audit(tx, c, 'stoppage.reject', 'StoppageDay', r.id, { projectId: r.projectId, note: input.note });
    return one(tx, c.tenantId, r.id);
  });
}
