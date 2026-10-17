/**
 * Handover to the owner: checklist (keys, utility connections, warranty cards, final drawings,
 * final photos), owner sign-off, completion (CLOSEOUT → HANDED_OVER with the handover date,
 * defect period and retention due date) and the handover certificate PDF.
 */
import { withPdfTenant, withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { tr } from '../../core/i18n/index.js';
import { day } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { HandoverItemKey, Project } from '../../generated/prisma/client.js';
import { signedUrlFor } from '../attachments/attachments.service.js';
import { documentLang, letterhead, pdfFileName, salutation, shareOf, storePdf } from '../billing/documents.js';
import { assertEditable, assertProjectScope } from '../projects/access.js';
import { certificateHtml } from './certificate.js';
import { HANDOVER_ITEM_KEYS, type CertificateQuery, type CompleteHandoverInput, type HandoverItemInput, type SignOffInput } from './closeout.schema.js';
import { actor, addMonths, assertAttachments, attachmentsById, audit, peopleById, personOf, photosOf, today, ymd, type Actor } from './closeout.shared.js';
import { recordHandoverTx } from './retention.dates.js';

type Blocker = 'PROJECT_NOT_CLOSEOUT' | 'ITEMS_PENDING' | 'SIGN_OFF_MISSING';

async function handoverOf(tx: Tx, tenantId: string, projectId: string) {
  return tx.projectHandover.findUnique({ where: { tenantId_projectId: { tenantId, projectId } }, include: { items: true } });
}

async function ensureHandover(tx: Tx, tenantId: string, projectId: string) {
  return (await tx.projectHandover.findUnique({ where: { tenantId_projectId: { tenantId, projectId } } })) ?? tx.projectHandover.create({ data: { tenantId, projectId } });
}

export const openSnagCount = (tx: Tx, tenantId: string, projectId: string) => tx.snag.count({ where: { tenantId, projectId, status: { not: 'VERIFIED' } } });

async function view(tx: Tx, a: Actor, project: Project) {
  const h = await handoverOf(tx, a.tenantId, project.id);
  const itemRows = h?.items ?? [];
  const files = await attachmentsById(tx, a.tenantId, [...itemRows.flatMap((i) => i.attachmentIds), ...(h?.signatureAttachmentId ? [h.signatureAttachmentId] : [])]);
  const people = await peopleById(tx, a.tenantId, [...itemRows.map((i) => i.doneById), h?.signOffRecordedById]);
  const items = [];
  for (const key of HANDOVER_ITEM_KEYS) {
    const i = itemRows.find((x) => x.key === key);
    items.push({
      key,
      done: i?.done ?? false,
      note: i?.note ?? null,
      attachments: await photosOf(i?.attachmentIds ?? [], files),
      doneAt: i?.doneAt?.toISOString() ?? null,
      doneBy: personOf(people, i?.doneById),
    });
  }
  const signOff =
    h?.ownerName && h.signedOn
      ? {
          ownerName: h.ownerName,
          signedOn: ymd(h.signedOn)!,
          note: h.signOffNote,
          signature: h.signatureAttachmentId ? ((await photosOf([h.signatureAttachmentId], files))[0] ?? null) : null,
          recordedAt: h.signOffRecordedAt?.toISOString() ?? null,
          recordedBy: personOf(people, h.signOffRecordedById),
        }
      : null;
  const blockers: Blocker[] = [];
  if (project.status !== 'CLOSEOUT') blockers.push('PROJECT_NOT_CLOSEOUT');
  if (items.some((i) => !i.done)) blockers.push('ITEMS_PENDING');
  if (!signOff) blockers.push('SIGN_OFF_MISSING');
  return {
    projectId: project.id,
    projectStatus: project.status,
    items,
    signOff,
    handedOverAt: ymd(h?.handedOverAt),
    defectPeriodMonths: h?.defectPeriodMonths ?? project.defectPeriodMonths,
    retentionDueDate: ymd(h?.retentionDueDate),
    openSnags: await openSnagCount(tx, a.tenantId, project.id),
    canComplete: blockers.length === 0,
    blockers,
    certificate: h?.certificateAttachmentId ? { attachmentId: h.certificateAttachmentId, generatedAt: h.certificateGeneratedAt?.toISOString() ?? null } : null,
  };
}

export async function get(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => view(tx, a, await assertProjectScope(tx, 'closeout.handover.manage', projectId, a)));
}

export async function setItemTx(tx: Tx, a: Actor, projectId: string, key: HandoverItemKey, input: HandoverItemInput, opts: { at?: Date } = {}) {
  const project = await assertProjectScope(tx, 'closeout.handover.manage', projectId, a);
  assertEditable(project, ['ACTIVE', 'CLOSEOUT']);
  await assertAttachments(tx, a.tenantId, input.attachmentIds, ['SITE_PHOTO', 'DOCUMENT'], 'photo or document');
  const h = await ensureHandover(tx, a.tenantId, projectId);
  const before = await tx.handoverItem.findUnique({ where: { handoverId_key: { handoverId: h.id, key } } });
  const at = opts.at ?? new Date();
  const doneFields = input.done ? (before?.done ? {} : { doneAt: at, doneById: a.userId }) : { doneAt: null, doneById: null };
  const data = {
    done: input.done,
    ...(input.note !== undefined ? { note: input.note || null } : {}),
    ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds } : {}),
    ...doneFields,
  };
  if (before) await tx.handoverItem.update({ where: { id: before.id }, data });
  else await tx.handoverItem.create({ data: { tenantId: a.tenantId, handoverId: h.id, key, ...data } });
  await audit(tx, a, 'handover.item', 'Project', projectId, { key, before: before ? { done: before.done, note: before.note } : null, after: { done: input.done, note: input.note ?? null, attachments: input.attachmentIds?.length ?? null } });
  return view(tx, a, project);
}

export async function setItem(projectId: string, key: HandoverItemKey, input: HandoverItemInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => setItemTx(tx, a, projectId, key, input));
}

export async function signOffTx(tx: Tx, a: Actor, projectId: string, input: SignOffInput, opts: { at?: Date } = {}) {
  const project = await assertProjectScope(tx, 'closeout.handover.manage', projectId, a);
  assertEditable(project, ['ACTIVE', 'CLOSEOUT']);
  if (input.signedOn > today()) throw new BadRequest('FUTURE_DATE', 'The sign-off date cannot be in the future');
  await assertAttachments(tx, a.tenantId, input.signatureAttachmentId ? [input.signatureAttachmentId] : [], ['SITE_PHOTO', 'DOCUMENT'], 'signature photo');
  const h = await ensureHandover(tx, a.tenantId, projectId);
  await tx.projectHandover.update({
    where: { id: h.id },
    data: {
      ownerName: input.ownerName,
      signedOn: dateOnly(input.signedOn),
      signatureAttachmentId: input.signatureAttachmentId ?? null,
      signOffNote: input.note ?? null,
      signOffRecordedAt: opts.at ?? new Date(),
      signOffRecordedById: a.userId,
    },
  });
  await audit(tx, a, 'handover.sign_off', 'Project', projectId, {
    before: h.ownerName ? { ownerName: h.ownerName, signedOn: ymd(h.signedOn) } : null,
    after: { ownerName: input.ownerName, signedOn: input.signedOn, signatureAttachmentId: input.signatureAttachmentId ?? null },
  });
  return view(tx, a, project);
}

export async function signOff(projectId: string, input: SignOffInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => signOffTx(tx, a, projectId, input));
}

export async function completeTx(tx: Tx, a: Actor, projectId: string, input: CompleteHandoverInput) {
  const project = await assertProjectScope(tx, 'closeout.handover.manage', projectId, a);
  if (project.status !== 'CLOSEOUT') throw new Conflict('PROJECT_NOT_CLOSEOUT', 'Move the project to closeout first', { status: project.status });
  const current = await view(tx, a, project);
  if (current.blockers.length) throw new Conflict('HANDOVER_INCOMPLETE', 'Finish the checklist and record the owner sign-off first', { blockers: current.blockers });
  if (current.openSnags > 0 && !input.acceptOpenSnags) throw new Conflict('OPEN_SNAGS', `${current.openSnags} snags are not verified yet`, { count: current.openSnags });
  const date = input.handoverDate ?? today();
  if (date > today()) throw new BadRequest('FUTURE_DATE', 'The handover date cannot be in the future');
  await tx.project.update({ where: { id: project.id }, data: { status: 'HANDED_OVER' } });
  const h = await recordHandoverTx(tx, a.tenantId, project, date);
  await audit(tx, a, 'project.status_change', 'Project', project.id, { code: project.code, from: project.status, to: 'HANDED_OVER', note: input.note ?? null, via: 'handover' });
  await audit(tx, a, 'handover.complete', 'Project', project.id, {
    handoverDate: ymd(h.handedOverAt),
    defectPeriodMonths: h.defectPeriodMonths,
    retentionDueDate: ymd(h.retentionDueDate),
    openSnags: current.openSnags,
    acceptOpenSnags: input.acceptOpenSnags ?? false,
  });
  return view(tx, a, { ...project, status: 'HANDED_OVER' });
}

export async function complete(projectId: string, input: CompleteHandoverInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => completeTx(tx, a, projectId, input));
}

/** Handover certificate PDF (stored as a DOCUMENT attachment) + share link and WhatsApp text. */
export async function certificate(projectId: string, query: CertificateQuery) {
  const a = actor();
  return withPdfTenant(a.tenantId, async (tx) => {
    const project = await assertProjectScope(tx, 'closeout.handover.manage', projectId, a);
    const h = await handoverOf(tx, a.tenantId, projectId);
    if (!h?.ownerName || !h.signedOn) throw new Conflict('SIGN_OFF_MISSING', 'Record the owner sign-off first');
    const client = project.clientId ? await tx.client.findFirst({ where: { tenantId: a.tenantId, id: project.clientId }, select: { name: true, phone: true } }) : null;
    const lang = await documentLang(tx, a.userId, query.lang);
    const signature = h.signatureAttachmentId ? await tx.attachment.findFirst({ where: { tenantId: a.tenantId, id: h.signatureAttachmentId } }) : null;
    const handoverDate = ymd(h.handedOverAt);
    const months = h.defectPeriodMonths ?? project.defectPeriodMonths;
    const html = certificateHtml(
      {
        company: await letterhead(tx, a.tenantId),
        project: { name: project.name, code: project.code, address: [project.siteAddress, project.city].filter(Boolean).join(', ') || null },
        client: client ? { name: client.name } : null,
        handoverDate,
        signedOn: ymd(h.signedOn),
        ownerName: h.ownerName,
        signatureUrl: signature?.mimeType.startsWith('image/') ? (await signedUrlFor(signature)).url : null,
        items: HANDOVER_ITEM_KEYS.map((key) => {
          const i = h.items.find((x) => x.key === key);
          return { key, done: i?.done ?? false, note: i?.note ?? null };
        }),
        defectPeriodMonths: months,
        defectPeriodUntil: ymd(h.retentionDueDate) ?? addMonths(handoverDate ?? ymd(h.signedOn)!, months),
      },
      lang,
    );
    const at = new Date();
    const id = await storePdf(tx, a.tenantId, a.userId, 'DOCUMENT', pdfFileName(`Handover ${project.code}`, lang), html, `${tr(lang, 'pdf.handoverCertificate')} · ${project.name}`, lang);
    await tx.projectHandover.update({ where: { id: h.id }, data: { certificateAttachmentId: id, certificateGeneratedAt: at } });
    await audit(tx, a, 'handover.certificate', 'Project', projectId, { attachmentId: id, lang });
    const share = await shareOf(tx, a.tenantId, id, (url) =>
      tr(lang, 'share.handover', { salutation: salutation(client?.name, lang), project: project.name, date: day(handoverDate ?? ymd(h.signedOn)), url }),
    );
    return { ...share!, clientPhone: client?.phone ?? null };
  });
}
