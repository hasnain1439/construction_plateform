/**
 * Step 15 · what approved change orders add to a project — read by receivables (revised contract),
 * project detail, the schedule delay breakdown and the estimate "approved changes" layer.
 * No imports from other modules (it is imported by billing / projects / estimate / schedule).
 */
import type { Tx } from '../../core/db/withTenant.js';
import type { ChangeOrderStatus } from '../../generated/prisma/client.js';

/** Statuses that count in the revised contract and the revised end date. */
export const APPROVED_SET: ChangeOrderStatus[] = ['APPROVED', 'IN_PROGRESS', 'COMPLETED', 'BILLED'];

export const changeOrderCode = (n: number) => `CO-${String(n).padStart(3, '0')}`;
export const siteInstructionCode = (n: number) => `SI-${String(n).padStart(3, '0')}`;

export interface ApprovedChanges {
  count: number;
  /** Σ signed owner totals (a deduction is negative) */
  totalPaisa: bigint;
  /** Σ signed cost (cost × sign of the type) */
  costPaisa: bigint;
  days: number;
}

/** Approved-set change orders of one project. */
export async function approvedChanges(tx: Tx, tenantId: string, projectId: string): Promise<ApprovedChanges> {
  return (await approvedChangesMany(tx, tenantId, [projectId])).get(projectId)!;
}

/** Approved-set change orders of several projects in one query (every id gets an entry). */
export async function approvedChangesMany(tx: Tx, tenantId: string, projectIds: string[]): Promise<Map<string, ApprovedChanges>> {
  const out = new Map<string, ApprovedChanges>(projectIds.map((id) => [id, { count: 0, totalPaisa: 0n, costPaisa: 0n, days: 0 }]));
  if (!projectIds.length) return out;
  const rows = await tx.changeOrder.findMany({
    where: { tenantId, projectId: projectIds.length === 1 ? projectIds[0]! : { in: projectIds }, status: { in: APPROVED_SET } },
    select: { projectId: true, type: true, totalPaisa: true, costPaisa: true, daysImpact: true },
  });
  for (const r of rows) {
    const a = out.get(r.projectId)!;
    a.count += 1;
    a.totalPaisa += r.totalPaisa;
    a.costPaisa += r.type === 'DEDUCTION' ? -r.costPaisa : r.costPaisa;
    a.days += r.daysImpact;
  }
  return out;
}

/** Keeps Schedule.changeOrderDays (Step 13 hook) = Σ days of the approved-set change orders. */
export async function syncScheduleDays(tx: Tx, tenantId: string, projectId: string): Promise<number> {
  const { days } = await approvedChanges(tx, tenantId, projectId);
  await tx.schedule.updateMany({ where: { tenantId, projectId }, data: { changeOrderDays: days } });
  return days;
}

/** Approved-set change orders of a project for the delay breakdown (oldest approval first). */
export async function approvedChangeItems(tx: Tx, tenantId: string, projectId: string) {
  const rows = await tx.changeOrder.findMany({
    where: { tenantId, projectId, status: { in: APPROVED_SET } },
    orderBy: [{ approvedAt: 'asc' }, { number: 'asc' }],
    select: { id: true, number: true, title: true, daysImpact: true, approvedOn: true },
  });
  return rows.map((r) => ({ id: r.id, code: changeOrderCode(r.number), title: r.title, daysImpact: r.daysImpact, approvedOn: r.approvedOn ? r.approvedOn.toISOString().slice(0, 10) : null }));
}
