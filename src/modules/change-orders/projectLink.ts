/** Step 15 · project helpers for the change-order module (scope, editable status, contract total). */
import type { Tx } from '../../core/db/withTenant.js';
import type { Project } from '../../generated/prisma/client.js';
import { contractTotalPaisa } from '../projects/projects.dto.js';

export { assertEditable, assertProjectScope } from '../projects/access.js';

/** Original contract total, as receivables count it: Σ billing stages, else the contract value (labour-only: rate × area). */
export async function contractTotalOf(tx: Tx, tenantId: string, project: Project): Promise<bigint | null> {
  const stages = await tx.projectBillingStage.aggregate({ where: { tenantId, projectId: project.id }, _sum: { amountPaisa: true } });
  const fromStages = stages._sum.amountPaisa ?? 0n;
  return fromStages > 0n ? fromStages : contractTotalPaisa(project);
}
