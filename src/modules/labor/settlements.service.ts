/**
 * B4 — weekly wage settlement. Generate (or regenerate a DRAFT / RETURNED one) from hazri:
 *   daysWorked = full + ½ × half
 *   gross      = daysWorked × rate + OT hours × rate / hoursPerDay × OT multiplier
 *   peshgi     = outstanding advances, oldest first, up to gross (or the office's override)
 *   net        = gross − peshgi
 * Submit → approve (locks the week's hazri and the peshgi it cut) → pay (site cash leaves the
 * cash book). Return (with a comment) unlocks it again while nothing is paid.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import { Prisma } from '../../core/db/prisma.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { SettlementStatus } from '../../generated/prisma/client.js';
import { assertCash, cashMethodOf, lockAccount, payingAccount, postEntry } from '../cashbook/cash.js';
import { projectScope } from '../projects/access.js';
import type { LineInput, PayInput, SettlementsQuery } from './labor.schema.js';
import { actor, addDays, assertOffice, assertWeekStart, audit, laborSettings, num, projectFor, times, today, type Actor, type LaborSettings } from './labor.shared.js';

const EDITABLE: SettlementStatus[] = ['DRAFT', 'RETURNED'];

const lineInclude = {
  worker: { select: { id: true, name: true, type: true } },
  advances: { select: { advanceId: true, amountPaisa: true, advance: { select: { date: true, amountPaisa: true } } }, orderBy: { advance: { date: 'asc' } } },
} as const;
const include = {
  project: { select: { id: true, code: true, name: true } },
  lines: { include: lineInclude, orderBy: { worker: { name: 'asc' } } },
} as const;
type Row = Prisma.WageSettlementGetPayload<{ include: typeof include }>;
type LineRow = Row['lines'][number];

async function names(tx: Tx, tenantId: string, ids: Array<string | null>) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const users = wanted.length ? await tx.user.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true, name: true } }) : [];
  return (id: string | null) => (id ? (users.find((u) => u.id === id) ?? { id, name: 'Unknown' }) : null);
}

function lineDto(l: LineRow) {
  return {
    id: l.id,
    worker: l.worker,
    fullDays: l.fullDays,
    halfDays: l.halfDays,
    daysWorked: num(l.daysWorked)!,
    dailyRatePaisa: l.dailyRatePaisa.toString(),
    overtimeHours: num(l.overtimeHours)!,
    overtimePaisa: l.overtimePaisa.toString(),
    grossPaisa: l.grossPaisa.toString(),
    advanceAdjustedPaisa: l.advanceAdjustedPaisa.toString(),
    advanceOverride: l.advanceOverride,
    overrideNote: l.overrideNote,
    netPaisa: l.netPaisa.toString(),
    paymentStatus: l.paymentStatus,
    paidFrom: l.paidFrom,
    paidAt: l.paidAt?.toISOString() ?? null,
    cashEntryId: l.cashEntryId,
    advances: l.advances.map((x) => ({ advanceId: x.advanceId, date: formatDateOnly(x.advance.date), amountPaisa: x.amountPaisa.toString() })),
  };
}

async function toDto(tx: Tx, a: Actor, s: Row, withLines = true) {
  const who = await names(tx, a.tenantId, [s.createdById, s.submittedById, s.approvedById]);
  const unpaid = s.lines.filter((l) => l.paymentStatus === 'UNPAID').reduce((sum, l) => sum + l.netPaisa, 0n);
  return {
    id: s.id,
    project: s.project,
    weekStart: formatDateOnly(s.weekStart),
    weekEnd: formatDateOnly(s.weekEnd),
    status: s.status,
    workers: s.lines.length,
    daysWorked: s.lines.reduce((sum, l) => sum + Number(l.daysWorked), 0),
    grossPaisa: s.grossPaisa.toString(),
    advancePaisa: s.advancePaisa.toString(),
    netPaisa: s.netPaisa.toString(),
    paidPaisa: s.paidPaisa.toString(),
    unpaidPaisa: s.status === 'APPROVED' ? unpaid.toString() : s.netPaisa.toString(),
    fullyPaid: s.status === 'APPROVED' && s.lines.every((l) => l.paymentStatus === 'PAID'),
    createdBy: who(s.createdById),
    createdAt: s.createdAt.toISOString(),
    submittedBy: who(s.submittedById),
    submittedAt: s.submittedAt?.toISOString() ?? null,
    approvedBy: who(s.approvedById),
    approvedAt: s.approvedAt?.toISOString() ?? null,
    returnComment: s.returnComment,
    ...(withLines ? { lines: s.lines.map(lineDto) } : {}),
  };
}

async function find(tx: Tx, a: Actor, id: string): Promise<Row> {
  const s = await tx.wageSettlement.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!s) throw new NotFound('SETTLEMENT_NOT_FOUND', 'Settlement not found');
  await projectFor(tx, a, s.projectId).catch(() => {
    throw new NotFound('SETTLEMENT_NOT_FOUND', 'Settlement not found');
  });
  return s;
}

const load = (tx: Tx, id: string) => tx.wageSettlement.findUniqueOrThrow({ where: { id }, include });

// ─── Maths ──────────────────────────────────────────────────────────────────

export function overtimePay(hours: Prisma.Decimal, ratePaisa: bigint, s: Pick<LaborSettings, 'hoursPerDay' | 'overtimeMultiplier'>): bigint {
  if (hours.lte(0)) return 0n;
  return BigInt(hours.mul(ratePaisa.toString()).div(s.hoursPerDay).mul(s.overtimeMultiplier).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

/** Worker advances on the project up to `until`, with what is still free (not cut by another settlement). */
async function freeAdvances(tx: Tx, tenantId: string, projectId: string, workerId: string, until: Date, settlementId: string | null) {
  const advances = await tx.advance.findMany({
    where: { tenantId, projectId, workerId, payeeType: 'WORKER', date: { lte: until } },
    include: { allocations: { select: { amountPaisa: true, line: { select: { settlementId: true } } } } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  return advances
    .map((adv) => ({
      id: adv.id,
      free: adv.amountPaisa - adv.allocations.filter((x) => x.line.settlementId !== settlementId).reduce((s, x) => s + x.amountPaisa, 0n),
    }))
    .filter((x) => x.free > 0n);
}

function allocate(free: Array<{ id: string; free: bigint }>, target: bigint) {
  const out: Array<{ advanceId: string; amountPaisa: bigint }> = [];
  let left = target;
  for (const f of free) {
    if (left <= 0n) break;
    const take = f.free < left ? f.free : left;
    out.push({ advanceId: f.id, amountPaisa: take });
    left -= take;
  }
  return out;
}

async function writeLines(tx: Tx, a: Actor, settlementId: string, projectId: string, weekStart: string, weekEnd: string, s: LaborSettings) {
  const previous = await tx.wageSettlementLine.findMany({ where: { tenantId: a.tenantId, settlementId } });
  const overrides = new Map(previous.filter((l) => l.advanceOverride).map((l) => [l.workerId, l]));
  await tx.wageSettlementLine.deleteMany({ where: { tenantId: a.tenantId, settlementId } });

  const marks = await tx.attendance.findMany({ where: { tenantId: a.tenantId, projectId, date: { gte: dateOnly(weekStart), lte: dateOnly(weekEnd) } } });
  const workerIds = [...new Set(marks.map((m) => m.workerId))];
  const rates = new Map(
    (await tx.projectWorker.findMany({ where: { tenantId: a.tenantId, projectId, workerId: { in: workerIds } }, include: { worker: { select: { dailyRatePaisa: true } } } })).map(
      (pw) => [pw.workerId, pw.dailyRatePaisa],
    ),
  );
  let gross = 0n;
  let advance = 0n;
  for (const workerId of workerIds) {
    const mine = marks.filter((m) => m.workerId === workerId);
    const fullDays = mine.filter((m) => m.status === 'FULL').length;
    const halfDays = mine.filter((m) => m.status === 'HALF').length;
    const otHours = mine.reduce((sum, m) => sum.add(m.overtimeHours), new Prisma.Decimal(0));
    if (fullDays === 0 && halfDays === 0 && otHours.lte(0)) continue;
    const rate = rates.get(workerId) ?? (await tx.worker.findUniqueOrThrow({ where: { id: workerId } })).dailyRatePaisa;
    const daysWorked = new Prisma.Decimal(fullDays).add(new Prisma.Decimal(halfDays).mul(0.5));
    const ot = overtimePay(otHours, rate, s);
    const lineGross = times(daysWorked, rate) + ot;
    const free = await freeAdvances(tx, a.tenantId, projectId, workerId, dateOnly(weekEnd), settlementId);
    const available = free.reduce((sum, f) => sum + f.free, 0n);
    const override = overrides.get(workerId);
    let target = override ? override.advanceAdjustedPaisa : available;
    if (target > available) target = available;
    if (target > lineGross) target = lineGross;
    const allocations = allocate(free, target);
    const cut = allocations.reduce((sum, x) => sum + x.amountPaisa, 0n);
    const created = await tx.wageSettlementLine.create({
      data: {
        tenantId: a.tenantId,
        settlementId,
        workerId,
        fullDays,
        halfDays,
        daysWorked,
        dailyRatePaisa: rate,
        overtimeHours: otHours,
        overtimePaisa: ot,
        grossPaisa: lineGross,
        advanceAdjustedPaisa: cut,
        advanceOverride: !!override,
        overrideNote: override?.overrideNote ?? null,
        netPaisa: lineGross - cut,
      },
    });
    if (allocations.length) {
      await tx.settlementAdvance.createMany({ data: allocations.map((x) => ({ tenantId: a.tenantId, lineId: created.id, advanceId: x.advanceId, amountPaisa: x.amountPaisa })) });
    }
    gross += lineGross;
    advance += cut;
  }
  await tx.wageSettlement.update({ where: { id: settlementId }, data: { grossPaisa: gross, advancePaisa: advance, netPaisa: gross - advance } });
}

async function retotal(tx: Tx, settlementId: string) {
  const lines = await tx.wageSettlementLine.findMany({ where: { settlementId } });
  const gross = lines.reduce((s, l) => s + l.grossPaisa, 0n);
  const advance = lines.reduce((s, l) => s + l.advanceAdjustedPaisa, 0n);
  const paid = lines.filter((l) => l.paymentStatus === 'PAID').reduce((s, l) => s + l.netPaisa, 0n);
  await tx.wageSettlement.update({ where: { id: settlementId }, data: { grossPaisa: gross, advancePaisa: advance, netPaisa: gross - advance, paidPaisa: paid } });
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

export async function generateTx(tx: Tx, a: Actor, projectId: string, weekStart: string, opts: { at?: Date } = {}) {
  const project = await projectFor(tx, a, projectId, true);
  const s = await laborSettings(tx, a.tenantId);
  assertWeekStart(weekStart, s.weekStart);
  if (weekStart > today()) throw new BadRequest('FUTURE_WEEK', "This week hasn't started yet");
  const weekEnd = addDays(weekStart, 6);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`settlement:${project.id}:${weekStart}`}))`;

  const existing = await tx.wageSettlement.findUnique({ where: { projectId_weekStart: { projectId: project.id, weekStart: dateOnly(weekStart) } } });
  if (existing && !EDITABLE.includes(existing.status)) {
    throw new Conflict('SETTLEMENT_LOCKED', `This week is already ${existing.status.toLowerCase()}`, { settlementId: existing.id, status: existing.status });
  }
  const settlement =
    existing ??
    (await tx.wageSettlement.create({
      data: {
        tenantId: a.tenantId,
        projectId: project.id,
        weekStart: dateOnly(weekStart),
        weekEnd: dateOnly(weekEnd),
        createdById: a.userId,
        ...(opts.at ? { createdAt: opts.at } : {}),
      },
    }));
  await writeLines(tx, a, settlement.id, project.id, weekStart, weekEnd, s);
  if (existing?.status === 'RETURNED') await tx.wageSettlement.update({ where: { id: settlement.id }, data: { status: 'DRAFT' } });
  const row = await load(tx, settlement.id);
  await audit(tx, a, existing ? 'settlement.regenerate' : 'settlement.generate', 'WageSettlement', settlement.id, {
    weekStart,
    workers: row.lines.length,
    grossPaisa: row.grossPaisa.toString(),
    advancePaisa: row.advancePaisa.toString(),
  });
  return toDto(tx, a, row);
}

export async function generate(projectId: string, weekStart: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => generateTx(tx, a, projectId, weekStart));
}

export async function listSettlements(projectId: string | null, query: SettlementsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    if (projectId) await projectFor(tx, a, projectId);
    const where: Prisma.WageSettlementWhereInput = {
      tenantId: a.tenantId,
      ...(projectId ? { projectId } : { project: projectScope(a) }),
      ...(query.status ? { status: query.status } : {}),
    };
    const rows = await tx.wageSettlement.findMany({ where, include, orderBy: { weekStart: 'desc' }, ...skipTake(query) });
    const total = await tx.wageSettlement.count({ where });
    const data = [];
    for (const r of rows) data.push(await toDto(tx, a, r, false));
    return { data, meta: pageMeta(query, total) };
  });
}

export async function getSettlement(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => toDto(tx, a, await find(tx, a, id)));
}

export async function adjustLine(id: string, lineId: string, input: LineInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const s = await find(tx, a, id);
    if (!EDITABLE.includes(s.status)) throw new Conflict('SETTLEMENT_LOCKED', `This week is already ${s.status.toLowerCase()}`, { status: s.status });
    const line = s.lines.find((l) => l.id === lineId);
    if (!line) throw new NotFound('LINE_NOT_FOUND', 'Line not found');
    const free = await freeAdvances(tx, a.tenantId, s.projectId, line.workerId, s.weekEnd, s.id);
    const available = free.reduce((sum, f) => sum + f.free, 0n);
    const max = available < line.grossPaisa ? available : line.grossPaisa;
    if (input.advanceAdjustedPaisa > max) {
      throw new BadRequest('ADVANCE_TOO_HIGH', 'That is more than the peshgi outstanding (or the wages)', { maxPaisa: max.toString(), outstandingPaisa: available.toString() });
    }
    await tx.settlementAdvance.deleteMany({ where: { tenantId: a.tenantId, lineId } });
    const allocations = allocate(free, input.advanceAdjustedPaisa);
    if (allocations.length) await tx.settlementAdvance.createMany({ data: allocations.map((x) => ({ tenantId: a.tenantId, lineId, advanceId: x.advanceId, amountPaisa: x.amountPaisa })) });
    await tx.wageSettlementLine.update({
      where: { id: lineId },
      data: { advanceAdjustedPaisa: input.advanceAdjustedPaisa, advanceOverride: true, overrideNote: input.note, netPaisa: line.grossPaisa - input.advanceAdjustedPaisa },
    });
    await retotal(tx, s.id);
    await audit(tx, a, 'settlement.line_adjust', 'WageSettlement', s.id, {
      worker: line.worker.name,
      before: line.advanceAdjustedPaisa.toString(),
      after: input.advanceAdjustedPaisa.toString(),
      note: input.note,
    });
    return toDto(tx, a, await load(tx, s.id));
  });
}

export async function submitTx(tx: Tx, a: Actor, id: string, opts: { at?: Date } = {}) {
  const s = await find(tx, a, id);
  if (!EDITABLE.includes(s.status)) throw new Conflict('SETTLEMENT_LOCKED', `This week is already ${s.status.toLowerCase()}`, { status: s.status });
  if (!s.lines.length) throw new BadRequest('EMPTY_SETTLEMENT', 'Nobody worked this week — nothing to submit');
  await tx.wageSettlement.update({ where: { id }, data: { status: 'SUBMITTED', submittedById: a.userId, submittedAt: opts.at ?? new Date(), returnComment: null } });
  await audit(tx, a, 'settlement.submit', 'WageSettlement', id, { netPaisa: s.netPaisa.toString() });
  return toDto(tx, a, await load(tx, id));
}

export async function submit(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => submitTx(tx, a, id));
}

export async function approveTx(tx: Tx, a: Actor, id: string, opts: { at?: Date } = {}) {
  assertOffice(a, 'Only the owner or a project manager can approve wages');
  const s = await find(tx, a, id);
  if (s.status !== 'SUBMITTED') throw new Conflict('SETTLEMENT_NOT_SUBMITTED', `Only a submitted week can be approved (this one is ${s.status.toLowerCase()})`, { status: s.status });
  await tx.wageSettlement.update({ where: { id }, data: { status: 'APPROVED', approvedById: a.userId, approvedAt: opts.at ?? new Date() } });
  await audit(tx, a, 'settlement.approve', 'WageSettlement', id, { netPaisa: s.netPaisa.toString() });
  return toDto(tx, a, await load(tx, id));
}

export async function approve(id: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => approveTx(tx, a, id));
}

export async function returnSettlement(id: string, comment: string) {
  const a = actor();
  assertOffice(a, 'Only the owner or a project manager can return wages');
  return withTenant(a.tenantId, async (tx) => {
    const s = await find(tx, a, id);
    if (s.status !== 'SUBMITTED' && s.status !== 'APPROVED') throw new Conflict('SETTLEMENT_NOT_SUBMITTED', 'Only a submitted or approved week can be returned', { status: s.status });
    if (s.lines.some((l) => l.paymentStatus === 'PAID')) throw new Conflict('SETTLEMENT_PAID', 'Some wages are already paid — this week can no longer be returned');
    await tx.wageSettlement.update({ where: { id }, data: { status: 'RETURNED', returnComment: comment, approvedById: null, approvedAt: null } });
    await audit(tx, a, 'settlement.return', 'WageSettlement', id, { from: s.status, comment });
    return toDto(tx, a, await load(tx, id));
  });
}

export async function payTx(tx: Tx, a: Actor, id: string, input: PayInput, opts: { at?: Date } = {}) {
  const s = await find(tx, a, id);
  if (s.status !== 'APPROVED') throw new Conflict('SETTLEMENT_NOT_APPROVED', 'Wages can be paid only after approval', { status: s.status });
  if (a.role === 'MUNSHI' && input.paidFrom !== 'SITE_CASH') throw new Forbidden('PAID_FROM_NOT_ALLOWED', 'A munshi pays wages from site cash only');
  const lines = input.lineIds.map((lineId) => s.lines.find((l) => l.id === lineId));
  const missing = input.lineIds.filter((_, i) => !lines[i]);
  if (missing.length) throw new BadRequest('LINE_NOT_FOUND', 'Some lines are not on this settlement', { lineIds: missing });
  const paid = lines.filter((l) => l!.paymentStatus === 'PAID').map((l) => l!.id);
  if (paid.length) throw new Conflict('ALREADY_PAID', 'Some workers are already paid', { lineIds: paid });

  const at = opts.at ?? new Date();
  const total = lines.reduce((sum, l) => sum + l!.netPaisa, 0n);
  const account = input.paidFrom === 'SITE_CASH' ? await payingAccount(tx, a, input.cashAccountId) : null;
  if (account) {
    await lockAccount(tx, account.id);
    await assertCash(tx, a.tenantId, account.id, total);
  }
  const week = `${formatDateOnly(s.weekStart)} – ${formatDateOnly(s.weekEnd)}`;
  for (const l of lines) {
    let cashEntryId: string | null = null;
    if (account && l!.netPaisa > 0n) {
      const entry = await postEntry(tx, a.tenantId, {
        accountId: account.id,
        projectId: s.projectId,
        type: 'WAGE_PAYMENT',
        amountPaisa: -l!.netPaisa,
        description: `Wages ${week} — ${l!.worker.name}`,
        status: 'POSTED',
        costBucket: 'LABOR',
        reference: input.reference ?? null,
        refType: 'SETTLEMENT_LINE',
        refId: l!.id,
        occurredAt: at,
        createdAt: opts.at,
        createdById: a.userId,
      });
      cashEntryId = entry.id;
    }
    await tx.wageSettlementLine.update({ where: { id: l!.id }, data: { paymentStatus: 'PAID', paidFrom: input.paidFrom, paidAt: at, paidById: a.userId, cashEntryId } });
  }
  await retotal(tx, s.id);
  await audit(tx, a, 'settlement.pay', 'WageSettlement', s.id, {
    lines: lines.length,
    amountPaisa: total.toString(),
    paidFrom: input.paidFrom,
    method: cashMethodOf(input.paidFrom),
    cashAccountId: account?.id ?? null,
  });
  return toDto(tx, a, await load(tx, s.id));
}

export async function pay(id: string, input: PayInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => payTx(tx, a, id, input));
}
