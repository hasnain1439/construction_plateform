/**
 * Step 14 → Step 15 hook: approved change orders in the projected margin.
 *
 * Reads `src/modules/change-orders/totals.ts` (approved set: APPROVED / IN_PROGRESS / COMPLETED / BILLED):
 *   pricePaisa  Σ signed `totalPaisa` (owner price; a DEDUCTION is negative)
 *   costPaisa   Σ signed `costPaisa`  (what the extra work costs the contractor)
 *   inContract  true — receivables `moneyOf().contract` already includes the approved price.
 *               cost.service `contractOf()` then splits it back into the original contract + the
 *               approved changes (or takes a revised contract as is), so the price is never added twice.
 * Revised contract = original + pricePaisa; budget at completion = APPROVED estimate total + costPaisa.
 * Both flow into the cost variance projection, the P&L projected margin, the dashboard and the control summary.
 */
import type { Tx } from '../../core/db/withTenant.js';
import { approvedChanges } from '../change-orders/totals.js';

export interface ApprovedChanges {
  pricePaisa: bigint;
  costPaisa: bigint;
  inContract: boolean;
}

export async function approvedChangesOf(tx: Tx, tenantId: string, projectId: string): Promise<ApprovedChanges> {
  const a = await approvedChanges(tx, tenantId, projectId);
  return { pricePaisa: a.totalPaisa, costPaisa: a.costPaisa, inContract: true };
}
