/** B6 — billing events for dashboard alerts (the daily overdue check is jobs/billingOverdue.ts). */
import { withTenant } from '../../core/db/withTenant.js';
import { actor, assertOwner } from './billing.shared.js';

const ACTION: Record<string, (projectId: string, refId: string) => string> = {
  INVOICE_OVERDUE: (p, r) => `/projects/${p}/billing/invoices/${r}`,
  CHEQUE_BOUNCED: (p) => `/projects/${p}/billing/payments`,
  STAGE_READY_UNBILLED: (p) => `/projects/${p}/billing/schedule`,
  PREVIOUS_STAGE_UNPAID: (p) => `/projects/${p}/billing/schedule`,
};

export async function listEvents(query: { openOnly?: boolean }) {
  const a = actor();
  assertOwner(a, 'Only the owner sees billing alerts');
  return withTenant(a.tenantId, async (tx) => {
    const rows = await tx.billingEvent.findMany({
      where: { tenantId: a.tenantId, ...(query.openOnly ? { resolvedAt: null } : {}) },
      include: { project: { select: { id: true, code: true, name: true } } },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    });
    return rows.map((e) => ({
      id: e.id,
      type: e.type,
      project: e.project,
      refType: e.refType,
      refId: e.refId,
      details: e.details,
      occurredAt: e.occurredAt.toISOString(),
      resolvedAt: e.resolvedAt?.toISOString() ?? null,
      href: ACTION[e.type]!(e.projectId, e.refId),
    }));
  });
}
