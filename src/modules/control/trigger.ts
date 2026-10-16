/**
 * Step 14 · on-write trigger of the control alert engine, for the modules whose writes change a
 * variance (material usage, stock counts, milestone progress). Loaded lazily so those modules
 * don't import the whole control module (and its imports) at start-up.
 * Back-dated writes (`at` given: seed / import) don't trigger — the daily job catches up.
 */
import type { Tx } from '../../core/db/withTenant.js';

export async function controlTrigger(tx: Tx, tenantId: string, projectId: string | null | undefined, rules: string[], opts: { at?: Date | undefined } = {}): Promise<void> {
  if (!projectId || opts.at) return;
  const { triggerControlAlerts } = await import('./alerts/engine.js');
  await triggerControlAlerts(tx, tenantId, projectId, rules);
}
