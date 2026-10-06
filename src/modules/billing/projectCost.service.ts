/**
 * What a project has cost the contractor so far (cash basis). One place for the rule — the
 * receivables "own money invested" uses it now, project P&L will in Step 9.
 *
 *   material   contractor stock that reached the site (RECEIPT_IN from the store + direct
 *              PURCHASE_IN, less returns) at the value it carried — owner-supplied stock is 0
 *   wages      weekly settlement lines paid
 *   advances   peshgi given (workers and sub-contractors)
 *   subcontract running payments + retention released to sub-contractors
 *   kharcha    site cash expenses, except owner-recoverable and rejected ones
 *   losses     shortages written off (ACCEPT_LOSS)
 */
import type { Tx } from '../../core/db/withTenant.js';

export interface ProjectCost {
  materialPaisa: bigint;
  wagesPaisa: bigint;
  advancesPaisa: bigint;
  subcontractPaisa: bigint;
  kharchaPaisa: bigint;
  lossesPaisa: bigint;
  totalPaisa: bigint;
}

const sum = (v: bigint | null | undefined) => v ?? 0n;

export async function projectCost(tx: Tx, tenantId: string, projectId: string): Promise<ProjectCost> {
  const sites = await tx.stockLocation.findMany({ where: { tenantId, projectId, type: 'SITE' }, select: { id: true } });
  const material = sites.length
    ? sum(
        (
          await tx.stockMovement.aggregate({
            where: { tenantId, locationId: { in: sites.map((s) => s.id) }, ownerSupplied: false, type: { in: ['RECEIPT_IN', 'PURCHASE_IN', 'PURCHASE_RETURN_OUT'] } },
            _sum: { valuePaisa: true },
          })
        )._sum.valuePaisa,
      )
    : 0n;
  const wages = sum(
    (await tx.wageSettlementLine.aggregate({ where: { tenantId, paymentStatus: 'PAID', settlement: { projectId } }, _sum: { netPaisa: true } }))._sum.netPaisa,
  );
  const advances = sum((await tx.advance.aggregate({ where: { tenantId, projectId }, _sum: { amountPaisa: true } }))._sum.amountPaisa);
  const subcontract = -sum(
    (
      await tx.subcontractLedgerEntry.aggregate({
        where: { tenantId, type: { in: ['RUNNING_PAYMENT', 'RETENTION_RELEASE'] }, assignment: { projectId } },
        _sum: { amountPaisa: true },
      })
    )._sum.amountPaisa,
  );
  const kharcha = -sum(
    (
      await tx.cashEntry.aggregate({
        where: {
          tenantId,
          projectId,
          type: 'EXPENSE',
          status: { not: 'REJECTED' },
          OR: [{ costBucket: null }, { costBucket: { not: 'RECOVERABLE_FROM_OWNER' } }],
        },
        _sum: { amountPaisa: true },
      })
    )._sum.amountPaisa,
  );
  const losses = sum((await tx.shortage.aggregate({ where: { tenantId, projectId, resolution: 'ACCEPT_LOSS' }, _sum: { valuePaisa: true } }))._sum.valuePaisa);
  return {
    materialPaisa: material,
    wagesPaisa: wages,
    advancesPaisa: advances,
    subcontractPaisa: subcontract,
    kharchaPaisa: kharcha,
    lossesPaisa: losses,
    totalPaisa: material + wages + advances + subcontract + kharcha + losses,
  };
}

export const costDto = (c: ProjectCost) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.toString()])) as Record<keyof ProjectCost, string>;

