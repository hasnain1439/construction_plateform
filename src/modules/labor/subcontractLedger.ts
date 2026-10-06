/**
 * Sub-contractor running account (append-only). Signed: + owed to them (work value),
 * − paid / deducted (advance, running payment, deduction, retention release).
 *
 *   value        = Σ WORK_VALUE + Σ ADJUSTMENT
 *   retention    = value × retention% (held until released)
 *   paid         = advances + running payments
 *   balanceDue   = value − retention − paid − deductions   (< 0 → overpaid)
 */
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import type { SubcontractEntryType } from '../../generated/prisma/client.js';
import type { Actor } from './labor.shared.js';

export interface SubLedgerInput {
  assignmentId: string;
  type: SubcontractEntryType;
  /** Signed as stored */
  amountPaisa: bigint;
  refType?: string | null;
  refId?: string | null;
  occurredAt: Date;
  note?: string | null;
}

export function postSubLedger(tx: Tx, a: Pick<Actor, 'tenantId' | 'userId'>, e: SubLedgerInput) {
  return tx.subcontractLedgerEntry.create({
    data: {
      tenantId: a.tenantId,
      assignmentId: e.assignmentId,
      type: e.type,
      amountPaisa: e.amountPaisa,
      refType: e.refType ?? null,
      refId: e.refId ?? null,
      occurredAt: e.occurredAt,
      note: e.note ?? null,
      createdById: a.userId,
    },
  });
}

export interface SubAccount {
  valuePaisa: bigint;
  retentionPaisa: bigint;
  retentionReleasedPaisa: bigint;
  retentionHeldPaisa: bigint;
  advancesPaisa: bigint;
  paidPaisa: bigint;
  deductionsPaisa: bigint;
  balanceDuePaisa: bigint;
  overpaid: boolean;
}

export function retentionOn(value: bigint, percent: Prisma.Decimal | number) {
  if (value <= 0n) return 0n;
  return BigInt(new Prisma.Decimal(value.toString()).mul(percent).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

export function accountFrom(sums: Partial<Record<SubcontractEntryType, bigint>>, retentionPercent: Prisma.Decimal | number): SubAccount {
  const value = (sums.WORK_VALUE ?? 0n) + (sums.ADJUSTMENT ?? 0n);
  const retention = retentionOn(value, retentionPercent);
  const released = -(sums.RETENTION_RELEASE ?? 0n);
  const advances = -(sums.ADVANCE ?? 0n);
  const paid = advances - (sums.RUNNING_PAYMENT ?? 0n);
  const deductions = -(sums.DEDUCTION ?? 0n);
  const balanceDue = value - retention - paid - deductions;
  return {
    valuePaisa: value,
    retentionPaisa: retention,
    retentionReleasedPaisa: released,
    retentionHeldPaisa: retention - released,
    advancesPaisa: advances,
    paidPaisa: paid,
    deductionsPaisa: deductions,
    balanceDuePaisa: balanceDue,
    overpaid: balanceDue < 0n,
  };
}

/** Accounts for several assignments (one grouped query). */
export async function subAccounts(tx: Tx, tenantId: string, assignments: Array<{ id: string; retentionPercent: Prisma.Decimal }>): Promise<Map<string, SubAccount>> {
  const groups = assignments.length
    ? await tx.subcontractLedgerEntry.groupBy({
        by: ['assignmentId', 'type'],
        where: { tenantId, assignmentId: { in: assignments.map((x) => x.id) } },
        _sum: { amountPaisa: true },
      })
    : [];
  return new Map(
    assignments.map((s) => {
      const sums: Partial<Record<SubcontractEntryType, bigint>> = {};
      for (const g of groups.filter((x) => x.assignmentId === s.id)) sums[g.type] = g._sum.amountPaisa ?? 0n;
      return [s.id, accountFrom(sums, s.retentionPercent)];
    }),
  );
}

export const accountDto = (x: SubAccount) => ({
  valuePaisa: x.valuePaisa.toString(),
  retentionPaisa: x.retentionPaisa.toString(),
  retentionReleasedPaisa: x.retentionReleasedPaisa.toString(),
  retentionHeldPaisa: x.retentionHeldPaisa.toString(),
  advancesPaisa: x.advancesPaisa.toString(),
  paidPaisa: x.paidPaisa.toString(),
  deductionsPaisa: x.deductionsPaisa.toString(),
  balanceDuePaisa: x.balanceDuePaisa.toString(),
  overpaid: x.overpaid,
  overpaidPaisa: x.overpaid ? (-x.balanceDuePaisa).toString() : '0',
});
