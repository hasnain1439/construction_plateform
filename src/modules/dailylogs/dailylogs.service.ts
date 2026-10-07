/**
 * Daily logs (site diary). One per person per project per day; the author may change it the
 * same (Karachi) day, after that it is locked (409 LOG_LOCKED). Hazri, material usage and
 * kharcha of the day are read live for the detail view — never stored on the log.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { signedUrlFor } from '../attachments/attachments.service.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { qn } from '../inventory/stock.js';
import { actor, addDays, audit, projectFor, today, type Actor, type Created } from '../labor/labor.shared.js';
import type { DailyLogInput, DailyLogsQuery, UpdateDailyLogInput } from './dailylogs.schema.js';
import { isLateSync, LATE_SYNC_MS } from '../sync/lateSync.js';

/** How far back a missed day's log may still be written. */
export const BACKDATE_DAYS = 7;
export { isLateSync, LATE_SYNC_MS };

const include = {
  project: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true, role: true } },
} as const;
type Row = Prisma.DailyLogGetPayload<{ include: typeof include }>;

async function attachmentsOf(tx: Tx, tenantId: string, ids: string[], thumbs: boolean) {
  if (!ids.length) return [];
  const rows = await tx.attachment.findMany({ where: { tenantId, id: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      id: r.id,
      mimeType: r.mimeType,
      url: (await signedUrlFor(r)).url,
      ...(thumbs ? { thumbUrl: (await signedUrlFor(r, { thumbnailWidth: 320 })).url } : {}),
    });
  }
  return out;
}

async function toDto(tx: Tx, a: Actor, r: Row) {
  const day = formatDateOnly(r.logDate);
  return {
    id: r.id,
    project: r.project,
    logDate: day,
    note: r.note,
    conditions: r.conditions,
    workDone: r.workDone,
    author: r.createdBy,
    photos: await attachmentsOf(tx, a.tenantId, r.photoAttachmentIds, true),
    voiceNotes: await attachmentsOf(tx, a.tenantId, r.voiceAttachmentIds, false),
    editable: r.createdById === a.userId && day === today(),
    lateSync: isLateSync(r.deviceCreatedAt, r.createdAt),
    clientId: r.clientId,
    deviceCreatedAt: r.deviceCreatedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function assertAttachments(tx: Tx, tenantId: string, ids: string[] | undefined, kinds: string[], label: string) {
  if (!ids?.length) return;
  const found = await tx.attachment.count({ where: { tenantId, id: { in: ids }, kind: { in: kinds as never } } });
  if (found !== new Set(ids).size) throw new BadRequest('INVALID_ATTACHMENT', `A ${label} was not found — upload it again`);
}

/** Create, or update today's own log (same day only). A repeated clientId returns the saved log. */
export async function upsertTx(tx: Tx, a: Actor, projectId: string, input: DailyLogInput, opts: { at?: Date } = {}): Promise<Created<Awaited<ReturnType<typeof toDto>>>> {
  if (input.clientId) {
    const dup = await tx.dailyLog.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: input.clientId } }, include });
    if (dup) return { created: false, data: await toDto(tx, a, dup) };
  }
  const project = await projectFor(tx, a, projectId, true);
  const day = input.logDate ?? today();
  if (day > today()) throw new BadRequest('FUTURE_DATE', "A log can't be for a future day");
  if (day < addDays(today(), -BACKDATE_DAYS)) throw new BadRequest('DATE_TOO_OLD', `Logs can be written up to ${BACKDATE_DAYS} days back`);
  await assertAttachments(tx, a.tenantId, input.photoAttachmentIds, ['SITE_PHOTO', 'DOCUMENT'], 'photo');
  await assertAttachments(tx, a.tenantId, input.voiceAttachmentIds, ['VOICE_NOTE'], 'voice note');

  const existing = await tx.dailyLog.findUnique({ where: { projectId_logDate_createdById: { projectId: project.id, logDate: dateOnly(day), createdById: a.userId } } });
  const fields = {
    ...(input.note !== undefined ? { note: input.note || null } : {}),
    ...(input.conditions !== undefined ? { conditions: [...new Set(input.conditions)] } : {}),
    ...(input.workDone !== undefined ? { workDone: input.workDone || null } : {}),
    ...(input.photoAttachmentIds !== undefined ? { photoAttachmentIds: input.photoAttachmentIds } : {}),
    ...(input.voiceAttachmentIds !== undefined ? { voiceAttachmentIds: input.voiceAttachmentIds } : {}),
  };
  if (existing) {
    if (day !== today()) throw new Conflict('LOG_LOCKED', 'Only today’s log can be changed', { logDate: day });
    const updated = await tx.dailyLog.update({ where: { id: existing.id }, data: fields, include });
    await audit(tx, a, 'daily_log.update', 'DailyLog', existing.id, { logDate: day });
    return { created: false, data: await toDto(tx, a, updated) };
  }
  const row = await tx.dailyLog.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      logDate: dateOnly(day),
      createdById: a.userId,
      clientId: input.clientId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      ...fields,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
    include,
  });
  await audit(tx, a, 'daily_log.create', 'DailyLog', row.id, { logDate: day, conditions: row.conditions });
  return { created: true, data: await toDto(tx, a, row) };
}

export async function upsert(projectId: string, input: DailyLogInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => upsertTx(tx, a, projectId, input));
}

async function find(tx: Tx, a: Actor, id: string): Promise<Row> {
  const r = await tx.dailyLog.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!r) throw new NotFound('DAILY_LOG_NOT_FOUND', 'Daily log not found');
  await projectFor(tx, a, r.projectId).catch(() => {
    throw new NotFound('DAILY_LOG_NOT_FOUND', 'Daily log not found');
  });
  return r;
}

export async function update(id: string, input: UpdateDailyLogInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const r = await find(tx, a, id);
    if (r.createdById !== a.userId) throw new Conflict('LOG_LOCKED', 'Only the person who wrote the log can change it');
    return (await upsertTx(tx, a, r.projectId, { ...input, logDate: formatDateOnly(r.logDate) })).data;
  });
}

export async function list(projectId: string, query: DailyLogsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await projectFor(tx, a, projectId);
    const where: Prisma.DailyLogWhereInput = {
      tenantId: a.tenantId,
      projectId,
      ...(query.author ? { createdById: query.author } : {}),
      ...(query.from || query.to ? { logDate: { ...(query.from ? { gte: dateOnly(query.from) } : {}), ...(query.to ? { lte: dateOnly(query.to) } : {}) } } : {}),
    };
    const rows = await tx.dailyLog.findMany({ where, include, orderBy: [{ logDate: 'desc' }, { createdAt: 'desc' }], ...skipTake(query) });
    const total = await tx.dailyLog.count({ where });
    const data = [];
    for (const r of rows) data.push(await toDto(tx, a, r));
    return { data, meta: pageMeta(query, total) };
  });
}

/** The day around a log: who was on site, material used and kharcha (a MUNSHI sees only his own). */
async function daySummary(tx: Tx, a: Actor, projectId: string, day: string) {
  const marks = await tx.attendance.groupBy({ by: ['status'], where: { tenantId: a.tenantId, projectId, date: dateOnly(day) }, _count: true });
  const count = (s: string) => marks.find((m) => m.status === s)?._count ?? 0;
  const usage = await tx.materialUsageItem.findMany({
    where: { tenantId: a.tenantId, usage: { projectId, usageDate: dateOnly(day) } },
    select: { qty: true, material: { select: { id: true, name: true, unit: true } } },
  });
  const byMaterial = new Map<string, { material: { id: string; name: string; unit: string }; quantity: number }>();
  for (const u of usage) {
    const m = byMaterial.get(u.material.id) ?? { material: u.material, quantity: 0 };
    m.quantity = Math.round((m.quantity + qn(u.qty)) * 1000) / 1000;
    byMaterial.set(u.material.id, m);
  }
  const mine = a.role === 'MUNSHI';
  const kharcha = await tx.cashEntry.aggregate({
    where: {
      tenantId: a.tenantId,
      projectId,
      type: 'EXPENSE',
      occurredAt: { gte: pktDayStart(day), lt: pktDayEnd(day) },
      ...(mine ? { account: { holderUserId: a.userId } } : {}),
    },
    _sum: { amountPaisa: true },
    _count: true,
  });
  return {
    hazri: { full: count('FULL'), half: count('HALF'), absent: count('ABSENT'), present: count('FULL') + count('HALF') },
    usage: [...byMaterial.values()],
    kharcha: { scope: mine ? ('MINE' as const) : ('PROJECT' as const), entries: kharcha._count, totalPaisa: (-(kharcha._sum.amountPaisa ?? 0n)).toString() },
  };
}

export async function get(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const r = await find(tx, a, id);
    return { ...(await toDto(tx, a, r)), summary: await daySummary(tx, a, r.projectId, formatDateOnly(r.logDate)) };
  });
}
