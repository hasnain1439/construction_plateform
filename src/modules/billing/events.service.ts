/** B6 — billing events for dashboard alerts (the daily overdue check is jobs/billingOverdue.ts). */
import { withTenant } from '../../core/db/withTenant.js';
import { rs } from '../../core/pdf/templates.js';
import type { BillingEvent } from '../../generated/prisma/client.js';
import { actor, assertOwner } from './billing.shared.js';

const ACTION: Record<string, (projectId: string, refId: string) => string> = {
  INVOICE_OVERDUE: (p, r) => `/projects/${p}/billing/invoices/${r}`,
  CHEQUE_BOUNCED: (p) => `/projects/${p}/billing/payments`,
  STAGE_READY_UNBILLED: (p) => `/projects/${p}/billing/schedule`,
  PREVIOUS_STAGE_UNPAID: (p) => `/projects/${p}/billing/schedule`,
};

type Details = Record<string, unknown> | null;
const money = (v: unknown) => (typeof v === 'string' && /^-?\d+$/.test(v) ? rs(BigInt(v)) : '');

/** One line describing the event (dashboard alerts). */
export function eventTitle(e: Pick<BillingEvent, 'type' | 'details'>): string {
  const d = (e.details ?? {}) as NonNullable<Details>;
  switch (e.type) {
    case 'INVOICE_OVERDUE':
      return `${String(d['number'] ?? 'Invoice')} overdue — ${money(d['balancePaisa'])}`;
    case 'CHEQUE_BOUNCED':
      return `${[d['bankName'], 'cheque', d['chequeNo']].filter(Boolean).join(' ')} bounced — ${money(d['amountPaisa'])}`;
    case 'STAGE_READY_UNBILLED':
      return `Ready to bill: ${String(d['label'] ?? 'stage')} — ${money(d['amountPaisa'])}`;
    case 'PREVIOUS_STAGE_UNPAID':
      return 'An earlier stage is still unpaid';
  }
}

export const eventSeverity = (type: BillingEvent['type']) => (type === 'CHEQUE_BOUNCED' ? 'CRITICAL' : 'WARNING');
export const eventHref = (e: Pick<BillingEvent, 'type' | 'projectId' | 'refId'>) => ACTION[e.type]!(e.projectId, e.refId);

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
