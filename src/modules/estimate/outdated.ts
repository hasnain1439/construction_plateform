/** Price-list hook (kept tiny: the master-data services import it). */
import type { Tx } from '../../core/db/withTenant.js';

/**
 * Marks the DRAFT estimates that use any of the materials as rates-outdated after a price-list change.
 * APPROVED / SUPERSEDED estimates never change (their rates are frozen).
 */
export async function markRatesOutdated(tx: Tx, materialIds: string[]): Promise<number> {
  if (!materialIds.length) return 0;
  const r = await tx.estimate.updateMany({
    where: { status: 'DRAFT', ratesOutdated: false, lines: { some: { materialId: { in: [...new Set(materialIds)] } } } },
    data: { ratesOutdated: true },
  });
  return r.count;
}
