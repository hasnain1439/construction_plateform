/**
 * Daily billing check (02:30 Asia/Karachi, after the subscription job). Uses prismaAdmin
 * like the other jobs.
 */
import { prismaAdmin } from '../core/db/prisma.js';
import { dateOnly } from '../core/utils/dates.js';
import { daysBetween, today, ymd } from '../modules/billing/billing.shared.js';
import { recordEvent } from '../modules/billing/ledger.js';
import * as alerts from '../modules/notifications/alerts.js';

/** A stage marked ready this many days ago without an invoice gets a reminder (daily). */
export const READY_UNBILLED_DAYS = 3;

/**
 * Daily (and safe to repeat): every live invoice past due with a balance gets one open
 * INVOICE_OVERDUE event. Cross-tenant, so it runs as prismaAdmin like the subscription job.
 */
export async function runBillingOverdueCheck(now = new Date()): Promise<{ marked: string[]; checked: number; readyReminders: number }> {
  const day = today();
  const due = await prismaAdmin.invoice.findMany({
    where: { status: { in: ['ISSUED', 'PARTLY_PAID'] }, dueDate: { lt: dateOnly(day) }, balancePaisa: { gt: 0n } },
    select: { id: true, tenantId: true, projectId: true, number: true, dueDate: true, balancePaisa: true, project: { select: { name: true } } },
  });
  const marked: string[] = [];
  for (const inv of due) {
    const overdueDays = daysBetween(ymd(inv.dueDate)!, day);
    const isNew = await prismaAdmin.$transaction(async (tx) => {
      const fresh = await recordEvent(tx, {
        tenantId: inv.tenantId,
        projectId: inv.projectId,
        type: 'INVOICE_OVERDUE',
        refType: 'INVOICE',
        refId: inv.id,
        details: { number: inv.number, dueDate: ymd(inv.dueDate), balancePaisa: inv.balancePaisa.toString(), overdueDays },
        occurredAt: now,
      });
      if (fresh) {
        await alerts.invoiceOverdue(tx, { tenantId: inv.tenantId, projectId: inv.projectId, projectName: inv.project.name, invoiceId: inv.id, number: inv.number ?? 'Invoice', balancePaisa: inv.balancePaisa, overdueDays, at: now });
      }
      return fresh;
    });
    if (isNew) marked.push(inv.id);
  }

  // Stages ready to bill for 3+ days with no invoice → a daily reminder (deduped per 24 h).
  const ready = await prismaAdmin.projectBillingStage.findMany({
    where: { status: 'READY', readyAt: { lte: new Date(now.getTime() - READY_UNBILLED_DAYS * 86_400_000) } },
    select: { id: true, tenantId: true, projectId: true, label: true, amountPaisa: true, readyAt: true, project: { select: { name: true } } },
  });
  let readyReminders = 0;
  for (const st of ready) {
    const sent = await prismaAdmin.$transaction((tx) =>
      alerts.stageReadyUnbilled(tx, {
        tenantId: st.tenantId,
        projectId: st.projectId,
        projectName: st.project.name,
        stageId: st.id,
        label: st.label,
        amountPaisa: st.amountPaisa,
        days: Math.floor((now.getTime() - st.readyAt!.getTime()) / 86_400_000),
        at: now,
      }),
    );
    if (sent.length) readyReminders += 1;
  }
  return { marked, checked: due.length, readyReminders };
}
