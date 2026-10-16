/**
 * Daily retention reminders (Step 17, 02:45 Asia/Karachi). For every handed-over project:
 *   - `reminderDaysBefore` days before the retention due date → RETENTION_RELEASE_DUE (REMINDER)
 *   - on / after the due date                                  → RETENTION_RELEASE_DUE (DUE)
 * Each is sent once (ProjectHandover.retentionReminderSentAt / retentionDueNotifiedAt), to the
 * owner and the project's PMs who see amounts, with the open defect-period snags. Cross-tenant,
 * so it runs as prismaAdmin like the other jobs.
 */
import { prismaAdmin } from '../core/db/prisma.js';
import { dateOnly, formatDateOnly, todayIn } from '../core/utils/dates.js';
import { addMonths, daysBetween } from '../modules/closeout/closeout.shared.js';
import { clientRetention } from '../modules/closeout/retention.service.js';
import * as alerts from '../modules/notifications/alerts.js';

export async function runRetentionReminders(now = new Date()): Promise<{ checked: number; reminders: string[]; due: string[] }> {
  const day = todayIn('Asia/Karachi', now);
  // Anything due within the longest lead time (90 days) or already due and not yet announced.
  const horizon = dateOnly(addMonths(day, 4));
  const rows = await prismaAdmin.projectHandover.findMany({
    where: {
      retentionDueDate: { not: null, lte: horizon },
      project: { status: 'HANDED_OVER' },
      OR: [{ retentionReminderSentAt: null }, { retentionDueNotifiedAt: null }],
    },
    include: { project: { select: { id: true, name: true, billingModel: true } } },
  });
  const reminders: string[] = [];
  const due: string[] = [];
  for (const h of rows) {
    const dueDate = formatDateOnly(h.retentionDueDate!);
    const left = daysBetween(day, dueDate);
    const stage = left <= 0 ? (h.retentionDueNotifiedAt ? null : 'DUE') : left <= h.reminderDaysBefore && !h.retentionReminderSentAt ? 'REMINDER' : null;
    if (!stage) continue;
    await prismaAdmin.$transaction(async (tx) => {
      const client = await clientRetention(tx, h.tenantId, h.project);
      const openSnags = await tx.snag.count({ where: { tenantId: h.tenantId, projectId: h.projectId, inDefectPeriod: true, status: { not: 'VERIFIED' } } });
      await alerts.retentionReleaseDue(tx, {
        tenantId: h.tenantId,
        projectId: h.projectId,
        projectName: h.project.name,
        handoverId: h.id,
        stage,
        dueDate,
        amountPaisa: client.invoice ? client.invoice.balancePaisa : client.amountPaisa,
        openSnags,
        at: now,
      });
      await tx.projectHandover.update({
        where: { id: h.id },
        data: stage === 'DUE' ? { retentionDueNotifiedAt: now, ...(h.retentionReminderSentAt ? {} : { retentionReminderSentAt: now }) } : { retentionReminderSentAt: now },
      });
    });
    (stage === 'DUE' ? due : reminders).push(h.projectId);
  }
  return { checked: rows.length, reminders, due };
}
