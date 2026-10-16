/**
 * Step 15 · revised contract and revised end date of a project (project detail, CO list summary).
 *   revisedContract = original contract total + Σ approved-set CO totals (signed)
 *   revisedEndDate  = contract end date + Σ approved-set CO days, in company working days
 *                     (weekly off days and holidays skipped; stoppages are in the Step 13 delay view)
 */
import type { FieldAccess } from '../../core/auth/access.js';
import type { Tx } from '../../core/db/withTenant.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import { loadCalendar } from '../schedule/schedule.shared.js';
import { approvedChanges } from './totals.js';

export interface ProjectChangeSummary {
  approvedCount: number;
  daysImpact: number;
  originalEndDate: string | null;
  revisedEndDate: string | null;
  approvedChangesPaisa?: string;
  originalContractPaisa?: string | null;
  revisedContractPaisa?: string | null;
}

/** `contractTotal` = the project's contract total (stages / value / rate × area), null when not set. */
export async function projectChangeSummary(
  tx: Tx,
  tenantId: string,
  project: { id: string; endDate: Date | null },
  contractTotal: bigint | null,
  fa: FieldAccess,
): Promise<ProjectChangeSummary> {
  const ch = await approvedChanges(tx, tenantId, project.id);
  const originalEndDate = project.endDate ? formatDateOnly(project.endDate) : null;
  let revisedEndDate = originalEndDate;
  if (originalEndDate && ch.days > 0) revisedEndDate = (await loadCalendar(tx, tenantId, null)).cal.addWorkingDays(originalEndDate, ch.days);
  return {
    approvedCount: ch.count,
    daysImpact: ch.days,
    originalEndDate,
    revisedEndDate,
    ...(fa.rates || fa.amounts ? { approvedChangesPaisa: ch.totalPaisa.toString() } : {}),
    ...(fa.contract
      ? {
          originalContractPaisa: contractTotal === null ? null : contractTotal.toString(),
          revisedContractPaisa: contractTotal === null ? null : (contractTotal + ch.totalPaisa).toString(),
        }
      : {}),
  };
}
