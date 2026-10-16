/**
 * Handover date → defect period → retention due date. Small helpers other modules call
 * (projects status change, billing RETENTION invoices, sub-contractor retention release); no
 * imports from those modules, so there are no import cycles.
 */
import type { Tx } from '../../core/db/withTenant.js';
import { Conflict } from '../../core/errors/AppError.js';
import { dateOnly } from '../../core/utils/dates.js';
import { addMonths, today, ymd } from './closeout.shared.js';

/**
 * Records the handover of a project (status → HANDED_OVER): handover date, defect period (copied
 * from the project) and retention due date = date + defect period months. Draft RETENTION
 * invoices of the project get that due date. A date already recorded is kept.
 */
export async function recordHandoverTx(tx: Tx, tenantId: string, project: { id: string; defectPeriodMonths: number }, date: string) {
  const existing = await tx.projectHandover.findUnique({ where: { tenantId_projectId: { tenantId, projectId: project.id } } });
  if (existing?.handedOverAt) return existing;
  const due = addMonths(date, project.defectPeriodMonths);
  const data = { handedOverAt: dateOnly(date), defectPeriodMonths: project.defectPeriodMonths, retentionDueDate: dateOnly(due) };
  const h = existing
    ? await tx.projectHandover.update({ where: { id: existing.id }, data })
    : await tx.projectHandover.create({ data: { tenantId, projectId: project.id, ...data } });
  await tx.invoice.updateMany({ where: { tenantId, projectId: project.id, type: 'RETENTION', status: 'DRAFT' }, data: { dueDate: dateOnly(due) } });
  return h;
}

/** Retention due date of a handed-over project (null before handover). */
export async function retentionDueDate(tx: Tx, tenantId: string, projectId: string): Promise<string | null> {
  const h = await tx.projectHandover.findUnique({ where: { tenantId_projectId: { tenantId, projectId } }, select: { retentionDueDate: true } });
  return ymd(h?.retentionDueDate);
}

/**
 * Sub-contractor retention is held until the owner's retention is due: on a HANDED_OVER project a
 * release before the retention due date → 409 RETENTION_HELD.
 */
export async function assertRetentionReleasable(tx: Tx, tenantId: string, project: { id: string; status: string }) {
  if (project.status !== 'HANDED_OVER') return;
  const due = await retentionDueDate(tx, tenantId, project.id);
  if (due && today() < due) throw new Conflict('RETENTION_HELD', `Retention is held until ${due} (end of the defect period)`, { releaseDate: due });
}
