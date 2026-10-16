/**
 * Step 14 → Step 15 hook: approved change orders in the projected margin.
 *
 * Returns zeros on this branch (Step 15 is not in it). On merge with feature/phase-2-3, point it at
 * `src/modules/change-orders/totals.ts` (approved-set totals: APPROVED / IN_PROGRESS / COMPLETED /
 * BILLED):
 *   pricePaisa  Σ signed `totalPaisa` (owner price; a DEDUCTION is negative)
 *   costPaisa   Σ signed `costPaisa`  (what the extra work costs the contractor)
 *   inContract  true — receivables `moneyOf()` already returns `revisedContractPaisa`, which
 *               cost.service `contractOf()` picks up as the contract (and then never adds the
 *               price again; it also forces inContract when it sees a revised contract)
 * Revised contract = moneyOf revised contract (else contract + pricePaisa); budget at completion =
 * APPROVED estimate total + costPaisa. Both flow into the cost variance projection, the P&L
 * projected margin, the dashboard and the control summary.
 */
import type { Tx } from '../../core/db/withTenant.js';

export interface ApprovedChanges {
  pricePaisa: bigint;
  costPaisa: bigint;
  inContract: boolean;
}

export async function approvedChangesOf(_tx: Tx, _tenantId: string, _projectId: string): Promise<ApprovedChanges> {
  return { pricePaisa: 0n, costPaisa: 0n, inContract: false };
}
