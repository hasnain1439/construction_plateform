/** B5 — sub-contractor accounts: value of verified work, retention, payments, deductions. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Forbidden } from '../../core/errors/AppError.js';
import { Prisma } from '../../core/db/prisma.js';
import { cashMethodOf, payingAccount, rupees, spend } from '../cashbook/cash.js';
import { occurredAtFor } from '../inventory/stock.js';
import { findAssignment, toAssignmentDto, UNIT_OF } from './assignments.service.js';
import type { DeductionInput, ProgressInput, SubcontractPaymentInput } from './labor.schema.js';
import { actor, assertOffice, audit, laborSettings, num, projectFor, today, type Actor } from './labor.shared.js';
import { accountDto, postSubLedger, subAccounts } from './subcontractLedger.js';

const OFFICE_ONLY = 'Only the owner or a project manager can see sub-contract accounts';

export async function listAccounts(projectId: string) {
  const a = actor();
  assertOffice(a, OFFICE_ONLY);
  return withTenant(a.tenantId, async (tx) => {
    await projectFor(tx, a, projectId);
    const rows = await tx.subcontractAssignment.findMany({
      where: { tenantId: a.tenantId, projectId },
      include: { subcontractor: { select: { id: true, name: true, trade: true, phone: true } } },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
    const accounts = await subAccounts(tx, a.tenantId, rows);
    const measured = await tx.workMeasurement.groupBy({
      by: ['assignmentId'],
      where: { tenantId: a.tenantId, projectId, status: 'VERIFIED' },
      _sum: { quantity: true },
    });
    const pending = await tx.workMeasurement.groupBy({ by: ['assignmentId'], where: { tenantId: a.tenantId, projectId, status: 'RECORDED' }, _count: true });
    const items = rows.map((r) => ({
      ...toAssignmentDto(r, a),
      verifiedQty: r.rateType === 'LUMPSUM' ? null : num(measured.find((m) => m.assignmentId === r.id)?._sum.quantity ?? new Prisma.Decimal(0)),
      pendingMeasurements: pending.find((p) => p.assignmentId === r.id)?._count ?? 0,
      account: accountDto(accounts.get(r.id)!),
    }));
    const sum = (k: 'valuePaisa' | 'paidPaisa' | 'retentionHeldPaisa' | 'balanceDuePaisa') =>
      [...accounts.values()].reduce((s, x) => s + (k === 'balanceDuePaisa' ? (x.balanceDuePaisa > 0n ? x.balanceDuePaisa : 0n) : x[k]), 0n).toString();
    return {
      items,
      totals: {
        valuePaisa: sum('valuePaisa'),
        paidPaisa: sum('paidPaisa'),
        retentionHeldPaisa: sum('retentionHeldPaisa'),
        balanceDuePaisa: sum('balanceDuePaisa'),
        overpaidCount: [...accounts.values()].filter((x) => x.overpaid).length,
      },
    };
  });
}

export async function ledger(id: string) {
  const a = actor();
  assertOffice(a, OFFICE_ONLY);
  return withTenant(a.tenantId, async (tx) => {
    const s = await findAssignment(tx, a, id);
    const entries = await tx.subcontractLedgerEntry.findMany({ where: { tenantId: a.tenantId, assignmentId: s.id }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] });
    let running = 0n;
    const rows = entries.map((e) => {
      running += e.amountPaisa;
      return {
        id: e.id,
        type: e.type,
        amountPaisa: e.amountPaisa.toString(),
        runningPaisa: running.toString(),
        refType: e.refType,
        refId: e.refId,
        occurredAt: e.occurredAt.toISOString(),
        note: e.note,
        createdById: e.createdById,
      };
    });
    const account = (await subAccounts(tx, a.tenantId, [s])).get(s.id)!;
    return { assignment: toAssignmentDto(s, a), account: accountDto(account), entries: rows.reverse() };
  });
}

export async function progressTx(tx: Tx, a: Actor, id: string, input: ProgressInput, opts: { at?: Date } = {}) {
  assertOffice(a, 'Only the owner or a project manager can post progress');
  const s = await findAssignment(tx, a, id);
  await projectFor(tx, a, s.projectId, true);
  if (s.rateType !== 'LUMPSUM') throw new BadRequest('NOT_LUMPSUM', `This contract is paid per ${UNIT_OF[s.rateType]} — record a measurement instead`);
  const before = new Prisma.Decimal(s.progressPercent);
  const after = new Prisma.Decimal(input.percent);
  if (after.lte(before)) throw new BadRequest('PROGRESS_NOT_AHEAD', `Progress is already ${num(before)}% — enter the new total, e.g. ${Math.min(100, Number(before) + 10)}`, { currentPercent: num(before) });
  const date = input.date ?? today();
  const cumulative = (p: Prisma.Decimal) => BigInt(p.mul(s.contractValuePaisa!.toString()).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
  const value = cumulative(after) - cumulative(before);
  await tx.subcontractAssignment.update({ where: { id: s.id }, data: { progressPercent: after } });
  await postSubLedger(tx, a, {
    assignmentId: s.id,
    type: 'WORK_VALUE',
    amountPaisa: value,
    refType: 'PROGRESS',
    occurredAt: opts.at ?? occurredAtFor(date),
    note: input.note ?? `Progress ${num(before)}% → ${num(after)}%`,
  });
  await audit(tx, a, 'subcontract.progress', 'SubcontractAssignment', s.id, { from: num(before), to: num(after), valuePaisa: value.toString() });
  return ledgerOf(tx, a, s.id);
}

export async function progress(id: string, input: ProgressInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => progressTx(tx, a, id, input));
}

async function ledgerOf(tx: Tx, a: Actor, id: string) {
  const s = await findAssignment(tx, a, id);
  return { assignment: toAssignmentDto(s, a), account: accountDto((await subAccounts(tx, a.tenantId, [s])).get(s.id)!) };
}

const PAYMENT_ENTRY = { RUNNING: 'RUNNING_PAYMENT', FINAL: 'RUNNING_PAYMENT', RETENTION_RELEASE: 'RETENTION_RELEASE' } as const;

export async function payTx(tx: Tx, a: Actor, id: string, input: SubcontractPaymentInput, opts: { at?: Date } = {}) {
  if (a.role === 'MUNSHI') throw new Forbidden('FORBIDDEN', 'Only the owner can pay sub-contractors');
  if (a.role === 'PM' && !(await laborSettings(tx, a.tenantId)).subcontractPaymentsByPm) {
    throw new Forbidden('FORBIDDEN', 'Only the owner can pay sub-contractors (the company setting does not allow project managers)');
  }
  const s = await findAssignment(tx, a, id);
  await projectFor(tx, a, s.projectId, true);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subcontract:${s.id}`}))`;
  const acc = (await subAccounts(tx, a.tenantId, [s])).get(s.id)!;
  if (input.type === 'RETENTION_RELEASE') {
    if (input.amountPaisa > acc.retentionHeldPaisa) {
      throw new BadRequest('EXCEEDS_RETENTION', `Only ${rupees(acc.retentionHeldPaisa)} of retention is held`, { retentionHeldPaisa: acc.retentionHeldPaisa.toString() });
    }
  } else if (input.amountPaisa > acc.balanceDuePaisa && !input.allowAdvance) {
    throw new BadRequest('EXCEEDS_BALANCE', `Only ${rupees(acc.balanceDuePaisa > 0n ? acc.balanceDuePaisa : 0n)} is due — tick "pay as advance" to pay more`, {
      balanceDuePaisa: acc.balanceDuePaisa.toString(),
    });
  }
  const date = input.date ?? today();
  const at = opts.at ?? occurredAtFor(date);
  const label = input.type === 'RETENTION_RELEASE' ? 'Retention release' : input.type === 'FINAL' ? 'Final payment' : 'Running payment';
  const entry = await postSubLedger(tx, a, {
    assignmentId: s.id,
    type: PAYMENT_ENTRY[input.type],
    amountPaisa: -input.amountPaisa,
    refType: 'PAYMENT',
    occurredAt: at,
    note: [label, input.paidFrom.replace('_', ' ').toLowerCase(), input.reference, input.note].filter(Boolean).join(' · '),
  });
  if (input.paidFrom === 'SITE_CASH') {
    const account = await payingAccount(tx, a, input.cashAccountId);
    await spend(tx, a.tenantId, {
      accountId: account.id,
      projectId: s.projectId,
      type: 'SUBCONTRACT_PAYMENT',
      amountPaisa: input.amountPaisa,
      description: `${label} — ${s.subcontractor.name}`,
      status: 'POSTED',
      costBucket: 'LABOR',
      reference: input.reference ?? null,
      refType: 'SUBCONTRACT_ENTRY',
      refId: entry.id,
      occurredAt: at,
      createdAt: opts.at,
      createdById: a.userId,
    });
  }
  if (input.type === 'FINAL') await tx.subcontractAssignment.update({ where: { id: s.id }, data: { isActive: false } });
  await audit(tx, a, 'subcontract.payment', 'SubcontractAssignment', s.id, {
    type: input.type,
    amountPaisa: input.amountPaisa.toString(),
    paidFrom: input.paidFrom,
    method: cashMethodOf(input.paidFrom),
    advance: input.amountPaisa > acc.balanceDuePaisa && input.type !== 'RETENTION_RELEASE',
  });
  return ledgerOf(tx, a, s.id);
}

export async function pay(id: string, input: SubcontractPaymentInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => payTx(tx, a, id, input));
}

export async function deductTx(tx: Tx, a: Actor, id: string, input: DeductionInput & { refType?: string; refId?: string }, opts: { at?: Date } = {}) {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', 'Only the owner can deduct from a sub-contractor');
  const s = await findAssignment(tx, a, id);
  const entry = await postSubLedger(tx, a, {
    assignmentId: s.id,
    type: 'DEDUCTION',
    amountPaisa: -input.amountPaisa,
    refType: input.refType ?? 'DEDUCTION',
    refId: input.refId ?? null,
    occurredAt: opts.at ?? occurredAtFor(input.date ?? today()),
    note: input.reason,
  });
  await audit(tx, a, 'subcontract.deduction', 'SubcontractAssignment', s.id, { amountPaisa: input.amountPaisa.toString(), reason: input.reason, entryId: entry.id });
  return ledgerOf(tx, a, s.id);
}

export async function deduct(id: string, input: DeductionInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => deductTx(tx, a, id, input));
}

/**
 * Step 6 hook: a shortage the sub-contractor is responsible for (e.g. damaged material)
 * is charged to their account as a DEDUCTION.
 */
export async function chargeShortageToAssignment(tx: Tx, a: Actor, input: { assignmentId: string; projectId: string | null; shortageId: string; amountPaisa: bigint; note: string }) {
  const s = await findAssignment(tx, a, input.assignmentId);
  if (input.projectId && s.projectId !== input.projectId) throw new BadRequest('INVALID_ASSIGNMENT', 'This sub-contract is on another project');
  if (input.amountPaisa <= 0n) throw new BadRequest('NOTHING_TO_CHARGE', 'This shortage has no value to charge');
  await postSubLedger(tx, a, {
    assignmentId: s.id,
    type: 'DEDUCTION',
    amountPaisa: -input.amountPaisa,
    refType: 'SHORTAGE',
    refId: input.shortageId,
    occurredAt: new Date(),
    note: input.note,
  });
  return s;
}

