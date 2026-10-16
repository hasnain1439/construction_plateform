/**
 * Retention after handover: the owner's retention (retention billing stage → RETENTION invoice due
 * on handover + defect period) and every sub-contractor's retention held until the same date.
 * Amounts need fields.amounts (omitted otherwise).
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import type { Project } from '../../generated/prisma/client.js';
import { LIVE } from '../billing/ledger.js';
import { subAccounts } from '../labor/subcontractLedger.js';
import { assertProjectScope } from '../projects/access.js';
import type { RetentionSettingsInput } from './closeout.schema.js';
import { actor, audit, daysBetween, today, ymd, type Actor } from './closeout.shared.js';

/** The owner's retention: amount held (stage amount, or what running bills held back) and its invoice. */
export async function clientRetention(tx: Tx, tenantId: string, project: Pick<Project, 'id' | 'billingModel'>) {
  const stage = await tx.projectBillingStage.findFirst({ where: { tenantId, projectId: project.id, isRetention: true } });
  if (!stage) return { stage: null, amountPaisa: 0n, invoice: null };
  const invoice = await tx.invoice.findFirst({ where: { tenantId, projectId: project.id, billingStageId: stage.id, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' } });
  let amount = stage.amountPaisa;
  if (invoice) amount = invoice.totalPaisa;
  else if (project.billingModel === 'RUNNING_BILLS') {
    const held = await tx.invoiceLine.aggregate({ where: { tenantId, sourceType: 'RETENTION', sourceId: stage.id, invoice: { status: { in: LIVE } } }, _sum: { amountPaisa: true } });
    if (held._sum.amountPaisa) amount = -held._sum.amountPaisa;
  }
  return { stage, amountPaisa: amount, invoice };
}

async function view(tx: Tx, a: Actor, project: Project) {
  const money = a.seesFinancials;
  const h = await tx.projectHandover.findUnique({ where: { tenantId_projectId: { tenantId: a.tenantId, projectId: project.id } } });
  const due = ymd(h?.retentionDueDate);
  const day = today();
  const handedOver = project.status === 'HANDED_OVER' || project.status === 'CLOSED';
  const releasable = handedOver && (!due || due <= day);
  const client = await clientRetention(tx, a.tenantId, project);
  const assignments = await tx.subcontractAssignment.findMany({
    where: { tenantId: a.tenantId, projectId: project.id },
    include: { subcontractor: { select: { id: true, name: true, trade: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const accounts = await subAccounts(tx, a.tenantId, assignments);
  const subs = assignments
    .map((g) => ({ g, acc: accounts.get(g.id)! }))
    .filter(({ acc }) => acc.retentionPaisa > 0n || acc.retentionReleasedPaisa > 0n)
    .map(({ g, acc }) => ({
      assignmentId: g.id,
      subcontractorId: g.subcontractor.id,
      name: g.subcontractor.name,
      trade: g.subcontractor.trade,
      scope: g.scope,
      retentionPercent: Number(g.retentionPercent),
      ...(money ? { retentionHeldPaisa: acc.retentionHeldPaisa.toString(), retentionReleasedPaisa: acc.retentionReleasedPaisa.toString() } : {}),
      releaseDate: due,
      releasable: releasable && acc.retentionHeldPaisa > 0n,
    }));
  const subHeld = assignments.reduce((s, g) => s + accounts.get(g.id)!.retentionHeldPaisa, 0n);
  const inv = client.invoice;
  const clientHeld = inv ? inv.balancePaisa : client.amountPaisa;
  const defectTotal = await tx.snag.count({ where: { tenantId: a.tenantId, projectId: project.id, inDefectPeriod: true } });
  const defectOpen = await tx.snag.count({ where: { tenantId: a.tenantId, projectId: project.id, inDefectPeriod: true, status: { not: 'VERIFIED' } } });
  return {
    projectId: project.id,
    projectStatus: project.status,
    retentionPercent: Number(project.retentionPercent),
    defectPeriodMonths: h?.defectPeriodMonths ?? project.defectPeriodMonths,
    handedOverAt: ymd(h?.handedOverAt),
    retentionDueDate: due,
    daysToDue: due ? daysBetween(day, due) : null,
    reminder: {
      daysBefore: h?.reminderDaysBefore ?? 14,
      reminderSentAt: h?.retentionReminderSentAt?.toISOString() ?? null,
      dueNotifiedAt: h?.retentionDueNotifiedAt?.toISOString() ?? null,
    },
    client: {
      hasRetentionStage: client.stage !== null,
      stageLabel: client.stage?.label ?? null,
      ...(money ? { amountPaisa: client.amountPaisa.toString() } : {}),
      invoice: inv
        ? {
            id: inv.id,
            number: inv.number,
            status: inv.status,
            dueDate: ymd(inv.dueDate),
            ...(money ? { totalPaisa: inv.totalPaisa.toString(), balancePaisa: inv.balancePaisa.toString() } : {}),
          }
        : null,
      canInvoice: client.stage !== null && !inv && (project.status === 'CLOSEOUT' || project.status === 'HANDED_OVER'),
    },
    subcontractors: subs,
    totals: money ? { clientHeldPaisa: clientHeld.toString(), subcontractorHeldPaisa: subHeld.toString() } : {},
    defectSnags: { total: defectTotal, open: defectOpen },
  };
}

export async function get(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => view(tx, a, await assertProjectScope(tx, 'closeout.retention.view', projectId, a)));
}

export async function updateSettings(projectId: string, input: RetentionSettingsInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await assertProjectScope(tx, 'closeout.handover.manage', projectId, a);
    const h = (await tx.projectHandover.findUnique({ where: { tenantId_projectId: { tenantId: a.tenantId, projectId } } })) ?? (await tx.projectHandover.create({ data: { tenantId: a.tenantId, projectId } }));
    // A changed lead time re-arms the "coming up" reminder.
    await tx.projectHandover.update({ where: { id: h.id }, data: { reminderDaysBefore: input.reminderDaysBefore, ...(input.reminderDaysBefore !== h.reminderDaysBefore ? { retentionReminderSentAt: null } : {}) } });
    await audit(tx, a, 'retention.settings', 'Project', projectId, { before: { reminderDaysBefore: h.reminderDaysBefore }, after: { reminderDaysBefore: input.reminderDaysBefore } });
    // The caller may lack closeout.retention.view: answer with the retention view anyway (amounts follow fields.amounts).
    return view(tx, a, project);
  });
}
