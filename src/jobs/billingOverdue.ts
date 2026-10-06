/**
 * Daily billing check (02:30 Asia/Karachi, after the subscription job). Uses prismaAdmin
 * like the other jobs.
 */
import { prismaAdmin } from '../core/db/prisma.js';
import { dateOnly } from '../core/utils/dates.js';
import { daysBetween, today, ymd } from '../modules/billing/billing.shared.js';
import { recordEvent } from '../modules/billing/ledger.js';

/**
 * Daily (and safe to repeat): every live invoice past due with a balance gets one open
 * INVOICE_OVERDUE event. Cross-tenant, so it runs as prismaAdmin like the subscription job.
 */
export async function runBillingOverdueCheck(now = new Date()): Promise<{ marked: string[]; checked: number }> {
  const day = today();
  const due = await prismaAdmin.invoice.findMany({
    where: { status: { in: ['ISSUED', 'PARTLY_PAID'] }, dueDate: { lt: dateOnly(day) }, balancePaisa: { gt: 0n } },
    select: { id: true, tenantId: true, projectId: true, number: true, dueDate: true, balancePaisa: true },
  });
  const marked: string[] = [];
  for (const inv of due) {
    const isNew = await prismaAdmin.$transaction((tx) =>
      recordEvent(tx, {
        tenantId: inv.tenantId,
        projectId: inv.projectId,
        type: 'INVOICE_OVERDUE',
        refType: 'INVOICE',
        refId: inv.id,
        details: { number: inv.number, dueDate: ymd(inv.dueDate), balancePaisa: inv.balancePaisa.toString(), overdueDays: daysBetween(ymd(inv.dueDate)!, day) },
        occurredAt: now,
      }),
    );
    if (isNew) marked.push(inv.id);
  }
  return { marked, checked: due.length };
}
