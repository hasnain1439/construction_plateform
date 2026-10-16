/**
 * Step 15 · the "approved changes" layer of an APPROVED estimate: the baseline lines and totals are
 * never touched; GET /estimates/:id shows the approved-set change orders on top of them.
 * Money keys with fields.rates (the estimate's own rule).
 */
import type { FieldAccess } from '../../core/auth/access.js';
import type { Tx } from '../../core/db/withTenant.js';
import { APPROVED_SET, changeOrderCode } from './totals.js';

export async function estimateChangesLayer(tx: Tx, tenantId: string, projectId: string, estimateTotalPaisa: bigint, fa: FieldAccess) {
  const rows = await tx.changeOrder.findMany({
    where: { tenantId, projectId, status: { in: APPROVED_SET } },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, title: true, type: true, status: true, daysImpact: true, costPaisa: true, totalPaisa: true },
  });
  const signedCost = (r: { type: string; costPaisa: bigint }) => (r.type === 'DEDUCTION' ? -r.costPaisa : r.costPaisa);
  const cost = rows.reduce((s, r) => s + signedCost(r), 0n);
  const price = rows.reduce((s, r) => s + r.totalPaisa, 0n);
  return {
    count: rows.length,
    daysImpact: rows.reduce((s, r) => s + r.daysImpact, 0),
    items: rows.map((r) => ({
      id: r.id,
      code: changeOrderCode(r.number),
      title: r.title,
      type: r.type,
      status: r.status,
      daysImpact: r.daysImpact,
      ...(fa.rates ? { costPaisa: signedCost(r).toString(), totalPaisa: r.totalPaisa.toString() } : {}),
    })),
    ...(fa.rates ? { costPaisa: cost.toString(), revisedTotalPaisa: (estimateTotalPaisa + cost).toString(), priceTotalPaisa: price.toString() } : {}),
  };
}
