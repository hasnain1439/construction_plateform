/**
 * Milestone progress / status from site — REST (`POST /milestones/:id/progress`) and sync
 * (MILESTONE_PROGRESS), idempotent by `clientId`. Permission schedule.progress.edit.
 *
 *   PLANNED → IN_PROGRESS (progress > 0 starts it; actualStart = date) → CURING (curing days) → DONE
 *   progress 100 % finishes it (CURING when it has curing days, else DONE; actualEnd = date)
 *   BLOCKED needs a note; DONE can only be reopened with schedule.plan.manage
 *
 * Warnings (never block): PREDECESSOR_NOT_DONE, and the stage-lock warning PREVIOUS_STAGE_UNPAID
 * when the milestone starts a billing stage while an earlier stage's invoice still has a balance
 * (BillingEvent PREVIOUS_STAGE_UNPAID refType MILESTONE + notification to owner / PMs with billing;
 * amounts only for callers with fields.amounts).
 */
import { controlTrigger } from '../control/trigger.js';
import { can, fieldAccess } from '../../core/auth/access.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { MilestoneStatus, Prisma } from '../../generated/prisma/client.js';
import { recordEvent } from '../billing/ledger.js';
import * as alerts from '../notifications/alerts.js';
import { caller, type Caller } from '../projects/access.js';
import type { ProgressInput } from './schedule.schema.js';
import { findMilestone, milestoneDetail } from './schedule.service.js';
import { audit, day, SITE_STATUSES, today } from './schedule.shared.js';

type C = Pick<Caller, 'tenantId' | 'userId' | 'role'>;

const ALLOWED: Record<MilestoneStatus, MilestoneStatus[]> = {
  PLANNED: ['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'CURING', 'DONE'],
  IN_PROGRESS: ['IN_PROGRESS', 'BLOCKED', 'CURING', 'DONE'],
  BLOCKED: ['BLOCKED', 'PLANNED', 'IN_PROGRESS'],
  CURING: ['CURING', 'DONE', 'IN_PROGRESS'],
  DONE: ['DONE'],
};

export interface ProgressWarning {
  code: 'PREVIOUS_STAGE_UNPAID' | 'PREDECESSOR_NOT_DONE';
  message: string;
  details: Record<string, unknown>;
}

/** Earlier billing stages whose invoice still has a balance (ISSUED / PARTLY_PAID). */
async function unpaidEarlierStages(tx: Tx, tenantId: string, billingStageId: string) {
  const stage = await tx.projectBillingStage.findUnique({ where: { id: billingStageId } });
  if (!stage) return { stage: null, unpaid: [] };
  const earlier = await tx.projectBillingStage.findMany({ where: { tenantId, projectId: stage.projectId, sortOrder: { lt: stage.sortOrder }, isRetention: false }, select: { id: true, label: true } });
  const invoices = await tx.invoice.findMany({
    where: { tenantId, billingStageId: { in: earlier.map((e) => e.id) }, status: { in: ['ISSUED', 'PARTLY_PAID'] }, balancePaisa: { gt: 0 } },
    orderBy: { issueDate: 'asc' },
  });
  return {
    stage,
    unpaid: invoices.map((i) => ({ stageId: i.billingStageId!, label: earlier.find((e) => e.id === i.billingStageId)?.label ?? '', invoiceId: i.id, invoiceNumber: i.number, dueDate: day(i.dueDate), balancePaisa: i.balancePaisa.toString() })),
  };
}

export async function updateProgressTx(tx: Tx, c: C, milestoneId: string, input: ProgressInput, opts: { at?: Date } = {}) {
  if (input.clientId) {
    const again = await tx.milestoneUpdate.findFirst({ where: { tenantId: c.tenantId, clientId: input.clientId } });
    if (again) {
      const { updates: _u, ...milestone } = await milestoneDetail(tx, c, again.milestoneId);
      void _u;
      return { id: again.id, milestone, warnings: [] as ProgressWarning[], duplicate: true };
    }
  }
  const { m, project } = await findMilestone(tx, c, milestoneId, 'schedule.progress.edit');
  if (!SITE_STATUSES.includes(project.status)) throw new Conflict('PROJECT_LOCKED', `This project is ${project.status.replace('_', ' ').toLowerCase()} — progress can't change`, { status: project.status });
  const date = input.date ?? today();
  if (date > today()) throw new BadRequest('DATE_IN_FUTURE', 'The date cannot be in the future');
  const photos = input.photoAttachmentIds ?? [];
  if (photos.length) {
    const found = await tx.attachment.count({ where: { tenantId: c.tenantId, id: { in: photos }, kind: 'SITE_PHOTO' } });
    if (found !== new Set(photos).size) throw new BadRequest('INVALID_ATTACHMENT', 'A photo was not found — upload it again');
  }

  const from = m.status;
  let progress = input.progressPercent ?? m.progressPercent;
  let to: MilestoneStatus = input.status ?? from;
  if (!input.status) {
    if (progress >= 100 && (from === 'PLANNED' || from === 'IN_PROGRESS' || from === 'BLOCKED')) to = m.curingDays > 0 ? 'CURING' : 'DONE';
    else if (progress > 0 && from === 'PLANNED') to = 'IN_PROGRESS';
    else if (progress > 0 && from === 'BLOCKED' && input.progressPercent !== undefined) to = 'IN_PROGRESS';
  }
  const reopen = from === 'DONE' && to === 'IN_PROGRESS' && can('schedule.plan.manage', c);
  if (!ALLOWED[from].includes(to) && !reopen) throw new Conflict('INVALID_STATUS_CHANGE', `A ${from.toLowerCase().replace('_', ' ')} milestone cannot become ${to.toLowerCase().replace('_', ' ')}`, { from, to });
  if (to === 'BLOCKED' && !input.note) throw new BadRequest('NOTE_REQUIRED', 'Write why the work is blocked');
  if (to === 'CURING' || to === 'DONE') progress = 100;
  if (to === 'PLANNED') progress = 0;
  if (to === 'IN_PROGRESS' && progress >= 100 && input.progressPercent === undefined) progress = 99;

  const data: Prisma.MilestoneUncheckedUpdateInput = { status: to, progressPercent: progress, lastProgressAt: opts.at ?? new Date() };
  if ((to === 'IN_PROGRESS' || to === 'CURING' || to === 'DONE') && !m.actualStart) data.actualStart = dateOnly(date);
  if ((to === 'CURING' || to === 'DONE') && !(from === 'CURING' && m.actualEnd)) data.actualEnd = dateOnly(date);
  if (to === 'IN_PROGRESS' || to === 'BLOCKED' || to === 'PLANNED') data.actualEnd = null;
  if (to === 'PLANNED') data.actualStart = null;
  await tx.milestone.update({ where: { id: m.id }, data });
  const update = await tx.milestoneUpdate.create({
    data: {
      tenantId: c.tenantId,
      milestoneId: m.id,
      projectId: m.projectId,
      date: dateOnly(date),
      status: to,
      progressPercent: progress,
      previousStatus: from,
      previousProgress: m.progressPercent,
      note: input.note ?? null,
      photoAttachmentIds: photos,
      clientId: input.clientId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      createdById: c.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });

  const warnings: ProgressWarning[] = [];
  const starting = (to === 'IN_PROGRESS' || to === 'CURING' || to === 'DONE') && (from === 'PLANNED' || from === 'BLOCKED') && !m.actualStart;
  if (starting) {
    const preds = await tx.milestone.findMany({ where: { id: { in: m.dependsOn.filter((d) => d.type === 'FS').map((d) => d.dependsOnId) }, status: { notIn: ['DONE', 'CURING'] } }, select: { id: true, name: true, status: true } });
    if (preds.length) warnings.push({ code: 'PREDECESSOR_NOT_DONE', message: 'Earlier work is not finished yet', details: { milestones: preds } });
    if (m.billingStageId) {
      const { stage, unpaid } = await unpaidEarlierStages(tx, c.tenantId, m.billingStageId);
      if (stage && unpaid.length) {
        const at = opts.at ?? new Date();
        await recordEvent(tx, {
          tenantId: c.tenantId,
          projectId: m.projectId,
          type: 'PREVIOUS_STAGE_UNPAID',
          refType: 'MILESTONE',
          refId: m.id,
          details: { milestoneId: m.id, milestone: m.name, billingStageId: stage.id, label: stage.label, stages: unpaid },
          occurredAt: at,
        });
        await alerts.milestoneStageLock(tx, { tenantId: c.tenantId, projectId: m.projectId, projectName: project.name, milestoneId: m.id, milestone: m.name, label: stage.label, unpaid: unpaid.length, at });
        const amounts = fieldAccess(c).amounts;
        warnings.push({
          code: 'PREVIOUS_STAGE_UNPAID',
          message: `"${stage.label}" is starting but ${unpaid.length === 1 ? 'an earlier stage is' : `${unpaid.length} earlier stages are`} still unpaid`,
          details: { billingStage: { id: stage.id, label: stage.label }, stages: unpaid.map(({ balancePaisa, ...u }) => ({ ...u, ...(amounts ? { balancePaisa } : {}) })) },
        });
      }
    }
  }
  await audit(tx, c, 'milestone.progress', 'Milestone', m.id, {
    projectId: m.projectId,
    key: m.key,
    from: { status: from, progressPercent: m.progressPercent },
    to: { status: to, progressPercent: progress },
    date,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    warnings: warnings.map((w) => w.code),
  });
  // Step 14 + QA-B-10: progress changes the estimate-to-date, so material overuse and spend-vs-progress are re-checked too.
  await controlTrigger(tx, c.tenantId, m.projectId, ['MILESTONE_BEHIND_PLAN', 'QUOTA_EXHAUSTED', 'MATERIAL_OVERUSE', 'SPEND_AHEAD_OF_PROGRESS'], opts);
  const { updates: _u, ...milestone } = await milestoneDetail(tx, c, m.id);
  void _u;
  return { id: update.id, milestone, warnings, duplicate: false };
}

export async function updateProgress(milestoneId: string, input: ProgressInput) {
  const c = caller();
  const r = await withTenant(c.tenantId, (tx) => updateProgressTx(tx, c, milestoneId, input));
  const { duplicate: _d, ...out } = r;
  void _d;
  return out;
}
