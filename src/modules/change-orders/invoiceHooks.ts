/**
 * Step 15 · billing hooks for change orders, called by the invoice service:
 *   - a new STAGE / RUNNING_BILL invoice draft gets one line per approved change order waiting for
 *     the next stage (billingMode NEXT_STAGE, not on a live invoice yet);
 *   - issuing an invoice with change-order lines marks those change orders BILLED;
 *   - cancelling it puts them back (COMPLETED / IN_PROGRESS / APPROVED by their dates).
 * Imports nothing from billing (no import cycle).
 */
import { writeAudit } from '../../core/audit/audit.js';
import type { Tx } from '../../core/db/withTenant.js';
import { changeOrderCode } from './totals.js';

/** Statuses a change order can be billed from. */
export const BILLABLE: Array<'APPROVED' | 'IN_PROGRESS' | 'COMPLETED'> = ['APPROVED', 'IN_PROGRESS', 'COMPLETED'];

export interface ChangeOrderInvoiceLine {
  description: string;
  amountPaisa: bigint;
  sourceType: 'CHANGE_ORDER';
  sourceId: string;
}

/** The single stage-invoice line of a change order: "CO-003 · Extra bathroom tiles" at the owner total (signed). */
export const stageLineOf = (co: { id: string; number: number; title: string; totalPaisa: bigint }): ChangeOrderInvoiceLine => ({
  description: `${changeOrderCode(co.number)} · ${co.title}`,
  amountPaisa: co.totalPaisa,
  sourceType: 'CHANGE_ORDER',
  sourceId: co.id,
});

/** Approved NEXT_STAGE change orders of the project not yet on a live invoice. */
export async function pendingStageLines(tx: Tx, tenantId: string, projectId: string): Promise<ChangeOrderInvoiceLine[]> {
  const cos = await tx.changeOrder.findMany({
    where: { tenantId, projectId, billingMode: 'NEXT_STAGE', status: { in: BILLABLE } },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, title: true, totalPaisa: true },
  });
  if (!cos.length) return [];
  const taken = new Set(
    (
      await tx.invoiceLine.findMany({
        where: { tenantId, sourceType: 'CHANGE_ORDER', sourceId: { in: cos.map((c) => c.id) }, invoice: { status: { not: 'CANCELLED' } } },
        select: { sourceId: true },
      })
    ).map((l) => l.sourceId),
  );
  return cos.filter((c) => !taken.has(c.id)).map(stageLineOf);
}

async function changeOrdersOn(tx: Tx, tenantId: string, invoiceId: string) {
  const ids = [
    ...new Set(
      (await tx.invoiceLine.findMany({ where: { tenantId, invoiceId, sourceType: 'CHANGE_ORDER' }, select: { sourceId: true } })).map((l) => l.sourceId).filter((x): x is string => Boolean(x)),
    ),
  ];
  return ids.length ? tx.changeOrder.findMany({ where: { tenantId, id: { in: ids } } }) : [];
}

/** Invoice issued → its change orders are BILLED. */
export async function markBilled(tx: Tx, a: { tenantId: string; userId: string }, invoice: { id: string; number: string | null }, at: Date = new Date()) {
  for (const co of await changeOrdersOn(tx, a.tenantId, invoice.id)) {
    if (!BILLABLE.includes(co.status as (typeof BILLABLE)[number])) continue;
    await tx.changeOrder.update({ where: { id: co.id }, data: { status: 'BILLED', billedAt: at } });
    await writeAudit(tx, {
      tenantId: a.tenantId,
      actorType: 'USER',
      actorId: a.userId,
      action: 'changeorder.billed',
      entityType: 'ChangeOrder',
      entityId: co.id,
      details: { code: changeOrderCode(co.number), from: co.status, invoiceId: invoice.id, invoiceNumber: invoice.number },
    });
  }
}

/** Issued invoice cancelled → its BILLED change orders go back to where they were. */
export async function revertBilled(tx: Tx, a: { tenantId: string; userId: string }, invoice: { id: string; number: string | null }) {
  for (const co of await changeOrdersOn(tx, a.tenantId, invoice.id)) {
    if (co.status !== 'BILLED') continue;
    const back = co.completedAt ? 'COMPLETED' : co.startedAt ? 'IN_PROGRESS' : 'APPROVED';
    await tx.changeOrder.update({ where: { id: co.id }, data: { status: back, billedAt: null } });
    await writeAudit(tx, {
      tenantId: a.tenantId,
      actorType: 'USER',
      actorId: a.userId,
      action: 'changeorder.unbilled',
      entityType: 'ChangeOrder',
      entityId: co.id,
      details: { code: changeOrderCode(co.number), to: back, invoiceId: invoice.id, invoiceNumber: invoice.number },
    });
  }
}
