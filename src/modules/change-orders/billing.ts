/**
 * Step 15 · billing link of an approved change order (changeorder.manage + billing.invoice.create):
 *   VARIATION   a DRAFT invoice of its own (type VARIATION), one line per CO line at the owner's
 *               price rates; ADDITION only (a deduction is credited on the next stage invoice)
 *   NEXT_STAGE  one line "CO-003 · title" on the project's DRAFT STAGE / RUNNING_BILL invoice when
 *               there is one, else on the next one created (invoiceHooks.pendingStageLines)
 * Issuing the invoice marks the change order BILLED (invoiceHooks.markBilled).
 */
import { assertPerm } from '../../core/auth/access.js';
import { withTenant } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { fieldAccess } from '../../core/auth/access.js';
import type { BillingActor } from '../billing/billing.shared.js';
import { writeLines as writeInvoiceLines, writeTotals } from '../billing/invoices.service.js';
import type { BillInput } from './changeOrders.schema.js';
import { assertCoStatus, audit, coActor, detailDto, findCo, invoicesOf, loadCo } from './changeOrders.shared.js';
import { BILLABLE, stageLineOf } from './invoiceHooks.js';
import { changeOrderCode } from './totals.js';

export async function bill(id: string, input: BillInput) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const { co, project } = await findCo(tx, a, id, 'changeorder.manage');
    assertPerm('billing.invoice.create', a, 'Invoices are made by the office');
    if (project.status === 'DRAFT') throw new Conflict('PROJECT_IS_DRAFT', 'Activate the project first');
    assertCoStatus(co, BILLABLE);
    const live = (await invoicesOf(tx, a.tenantId, [co.id])).get(co.id);
    if (live) throw new Conflict('CHANGE_ORDER_ALREADY_BILLED', 'This change order is already on an invoice', { invoiceId: live.id, invoiceNumber: live.number });
    const ba: BillingActor = { tenantId: a.tenantId, userId: a.userId, role: a.role, seesFinancials: fieldAccess().amounts, seesRates: fieldAccess().rates };
    const code = changeOrderCode(co.number);
    let invoiceId: string | null = null;

    if (input.mode === 'VARIATION') {
      if (co.type === 'DEDUCTION') throw new BadRequest('DEDUCTION_NEEDS_STAGE', 'A deduction is credited on the next stage invoice — choose "next stage"');
      if (!co.lines.length || co.totalPaisa <= 0n) throw new BadRequest('EMPTY_CHANGE_ORDER', 'This change order has no amount to bill');
      const inv = await tx.invoice.create({
        data: { tenantId: a.tenantId, projectId: project.id, clientId: project.clientId, type: 'VARIATION', notes: input.notes ?? `${code} · ${co.title}`, createdById: a.userId },
      });
      await writeInvoiceLines(
        tx,
        a.tenantId,
        inv.id,
        co.lines.map((l) => ({
          description: `${code} · ${l.description}`,
          quantity: l.quantity,
          unit: l.unit,
          ratePaisa: l.priceRatePaisa,
          amountPaisa: l.priceAmountPaisa,
          sourceType: 'CHANGE_ORDER' as const,
          sourceId: co.id,
        })),
      );
      await writeTotals(tx, ba, inv.id);
      await audit(tx, a, 'invoice.create', 'Invoice', inv.id, { type: 'VARIATION', lines: co.lines.length, changeOrderId: co.id });
      invoiceId = inv.id;
    } else {
      // Waiting for the next stage invoice; a draft one in the making gets the line right away.
      const draft = await tx.invoice.findFirst({
        where: { tenantId: a.tenantId, projectId: project.id, status: 'DRAFT', type: { in: ['STAGE', 'RUNNING_BILL'] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (draft) {
        const last = await tx.invoiceLine.findFirst({ where: { tenantId: a.tenantId, invoiceId: draft.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
        const line = stageLineOf(co);
        await tx.invoiceLine.create({ data: { tenantId: a.tenantId, invoiceId: draft.id, sortOrder: (last?.sortOrder ?? 0) + 1, ...line } });
        await writeTotals(tx, ba, draft.id);
        invoiceId = draft.id;
      }
    }
    await tx.changeOrder.update({ where: { id: co.id }, data: { billingMode: input.mode } });
    await audit(tx, a, 'changeorder.bill', 'ChangeOrder', co.id, { code, mode: input.mode, invoiceId, totalPaisa: co.totalPaisa.toString() });
    const invoice = invoiceId ? await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { id: true, number: true, type: true, status: true } }) : null;
    return { changeOrder: await detailDto(tx, a, await loadCo(tx, co.id), project), invoice };
  });
}
