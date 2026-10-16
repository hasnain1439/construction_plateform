/**
 * Drawings: one row per sheet (folder + title), files are revisions. A new revision becomes the
 * latest and supersedes the previous one; superseded revisions stay readable (isLatest = false).
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { NotFound } from '../../core/errors/AppError.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { Prisma, ProjectStatus } from '../../generated/prisma/client.js';
import { assertEditable, assertProjectScope } from '../projects/access.js';
import type { AddRevisionInput, CreateDrawingInput, DrawingsQuery, UpdateDrawingInput, UpdateRevisionInput } from './closeout.schema.js';
import { actor, assertAttachments, attachmentsById, audit, fileOf, lockKey, peopleById, personOf, ymd, type Actor } from './closeout.shared.js';

/** Drawings can change while the project runs and until it is handed over. */
export const DRAWING_STATUSES: ProjectStatus[] = ['ACTIVE', 'CLOSEOUT', 'HANDED_OVER'];

const include = { revisions: { orderBy: { revisionNo: 'desc' } } } as const satisfies Prisma.DrawingInclude;
type Row = Prisma.DrawingGetPayload<{ include: typeof include }>;

async function toDtos(tx: Tx, a: Actor, rows: Row[], withRevisions: boolean) {
  const revs = rows.flatMap((r) => (withRevisions ? r.revisions : r.revisions.filter((x) => x.isLatest)));
  const files = await attachmentsById(
    tx,
    a.tenantId,
    revs.map((x) => x.attachmentId),
  );
  const people = await peopleById(
    tx,
    a.tenantId,
    revs.map((x) => x.uploadedById),
  );
  const revDto = async (x: Row['revisions'][number]) => ({
    id: x.id,
    drawingId: x.drawingId,
    revisionNo: x.revisionNo,
    isLatest: x.isLatest,
    approvedAt: ymd(x.approvedAt),
    notes: x.notes,
    file: await fileOf(files.get(x.attachmentId)),
    uploadedBy: personOf(people, x.uploadedById),
    createdAt: x.createdAt.toISOString(),
  });
  const out = [];
  for (const r of rows) {
    const latest = r.revisions.find((x) => x.isLatest) ?? r.revisions[0] ?? null;
    const base = {
      id: r.id,
      projectId: r.projectId,
      folder: r.folder,
      title: r.title,
      number: r.number,
      milestoneId: r.milestoneId,
      notes: r.notes,
      revisionCount: r.revisions.length,
      latest: latest ? await revDto(latest) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
    if (!withRevisions) out.push(base);
    else {
      const revisions = [];
      for (const x of r.revisions) revisions.push(await revDto(x));
      out.push({ ...base, revisions });
    }
  }
  return out;
}

async function findDrawing(tx: Tx, a: Actor, id: string, perm: string) {
  const d = await tx.drawing.findFirst({ where: { tenantId: a.tenantId, id }, include });
  if (!d) throw new NotFound('DRAWING_NOT_FOUND', 'Drawing not found');
  const project = await assertProjectScope(tx, perm, d.projectId, a).catch(() => {
    throw new NotFound('DRAWING_NOT_FOUND', 'Drawing not found');
  });
  return { d, project };
}

async function detail(tx: Tx, a: Actor, id: string) {
  const d = await tx.drawing.findFirstOrThrow({ where: { tenantId: a.tenantId, id }, include });
  return (await toDtos(tx, a, [d], true))[0]!;
}

export async function list(projectId: string, q: DrawingsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await assertProjectScope(tx, 'closeout.drawing.view', projectId, a);
    const where: Prisma.DrawingWhereInput = {
      tenantId: a.tenantId,
      projectId,
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { number: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const rows = await tx.drawing.findMany({ where: { ...where, ...(q.folder ? { folder: q.folder } : {}) }, include, orderBy: [{ folder: 'asc' }, { title: 'asc' }] });
    const counts = await tx.drawing.groupBy({ by: ['folder'], where, _count: true });
    return {
      items: await toDtos(tx, a, rows, false),
      folders: counts.map((c) => ({ folder: c.folder, count: c._count })),
    };
  });
}

export async function get(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await findDrawing(tx, a, id, 'closeout.drawing.view');
    return detail(tx, a, id);
  });
}

export async function createTx(tx: Tx, a: Actor, projectId: string, input: CreateDrawingInput, opts: { at?: Date } = {}) {
  const project = await assertProjectScope(tx, 'closeout.drawing.manage', projectId, a);
  assertEditable(project, DRAWING_STATUSES);
  await assertAttachments(tx, a.tenantId, [input.revision.attachmentId], ['DOCUMENT'], 'drawing file');
  const d = await tx.drawing.create({
    data: {
      tenantId: a.tenantId,
      projectId,
      folder: input.folder,
      title: input.title,
      number: input.number ?? null,
      milestoneId: input.milestoneId ?? null,
      notes: input.notes ?? null,
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  await tx.drawingRevision.create({
    data: {
      tenantId: a.tenantId,
      drawingId: d.id,
      revisionNo: 0,
      attachmentId: input.revision.attachmentId,
      approvedAt: input.revision.approvedAt ? dateOnly(input.revision.approvedAt) : null,
      notes: input.revision.notes ?? null,
      isLatest: true,
      uploadedById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  await audit(tx, a, 'drawing.create', 'Drawing', d.id, { projectId, folder: input.folder, title: input.title, attachmentId: input.revision.attachmentId });
  return detail(tx, a, d.id);
}

export async function create(projectId: string, input: CreateDrawingInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createTx(tx, a, projectId, input));
}

export async function update(id: string, input: UpdateDrawingInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { d, project } = await findDrawing(tx, a, id, 'closeout.drawing.manage');
    assertEditable(project, DRAWING_STATUSES);
    const data: Prisma.DrawingUpdateInput = {};
    if (input.folder !== undefined) data.folder = input.folder;
    if (input.title !== undefined) data.title = input.title;
    if (input.number !== undefined) data.number = input.number;
    if (input.milestoneId !== undefined) data.milestoneId = input.milestoneId;
    if (input.notes !== undefined) data.notes = input.notes;
    await tx.drawing.update({ where: { id: d.id }, data });
    await audit(tx, a, 'drawing.update', 'Drawing', d.id, {
      before: { folder: d.folder, title: d.title, number: d.number, milestoneId: d.milestoneId, notes: d.notes },
      after: input as Prisma.InputJsonValue,
    });
    return detail(tx, a, d.id);
  });
}

export async function remove(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const { d, project } = await findDrawing(tx, a, id, 'closeout.drawing.manage');
    assertEditable(project, DRAWING_STATUSES);
    await tx.drawing.delete({ where: { id: d.id } }); // revisions cascade; the files stay as attachments
    await audit(tx, a, 'drawing.delete', 'Drawing', d.id, { projectId: d.projectId, title: d.title, revisions: d.revisions.map((r) => ({ revisionNo: r.revisionNo, attachmentId: r.attachmentId })) });
    return { id: d.id, deleted: true as const };
  });
}

export async function addRevisionTx(tx: Tx, a: Actor, id: string, input: AddRevisionInput, opts: { at?: Date } = {}) {
  const { d, project } = await findDrawing(tx, a, id, 'closeout.drawing.manage');
  assertEditable(project, DRAWING_STATUSES);
  await assertAttachments(tx, a.tenantId, [input.attachmentId], ['DOCUMENT'], 'drawing file');
  await lockKey(tx, `drawing:${d.id}`);
  const last = await tx.drawingRevision.findFirst({ where: { tenantId: a.tenantId, drawingId: d.id }, orderBy: { revisionNo: 'desc' } });
  const superseded = await tx.drawingRevision.findMany({ where: { tenantId: a.tenantId, drawingId: d.id, isLatest: true }, select: { id: true, revisionNo: true } });
  await tx.drawingRevision.updateMany({ where: { tenantId: a.tenantId, drawingId: d.id, isLatest: true }, data: { isLatest: false } });
  const rev = await tx.drawingRevision.create({
    data: {
      tenantId: a.tenantId,
      drawingId: d.id,
      revisionNo: (last?.revisionNo ?? -1) + 1,
      attachmentId: input.attachmentId,
      approvedAt: input.approvedAt ? dateOnly(input.approvedAt) : null,
      notes: input.notes ?? null,
      isLatest: true,
      uploadedById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  await tx.drawing.update({ where: { id: d.id }, data: { updatedAt: opts.at ?? new Date() } });
  await audit(tx, a, 'drawing.revision_add', 'Drawing', d.id, { revisionId: rev.id, revisionNo: rev.revisionNo, attachmentId: input.attachmentId, superseded: superseded.map((s) => s.revisionNo) });
  return detail(tx, a, d.id);
}

export async function addRevision(id: string, input: AddRevisionInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => addRevisionTx(tx, a, id, input));
}

export async function updateRevision(id: string, input: UpdateRevisionInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const rev = await tx.drawingRevision.findFirst({ where: { tenantId: a.tenantId, id } });
    if (!rev) throw new NotFound('REVISION_NOT_FOUND', 'Revision not found');
    const { project } = await findDrawing(tx, a, rev.drawingId, 'closeout.drawing.manage').catch(() => {
      throw new NotFound('REVISION_NOT_FOUND', 'Revision not found');
    });
    assertEditable(project, DRAWING_STATUSES);
    await tx.drawingRevision.update({
      where: { id: rev.id },
      data: {
        ...(input.approvedAt !== undefined ? { approvedAt: input.approvedAt ? dateOnly(input.approvedAt) : null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    await audit(tx, a, 'drawing.revision_update', 'Drawing', rev.drawingId, {
      revisionId: rev.id,
      revisionNo: rev.revisionNo,
      before: { approvedAt: ymd(rev.approvedAt), notes: rev.notes },
      after: { approvedAt: input.approvedAt, notes: input.notes } as Prisma.InputJsonValue,
    });
    return detail(tx, a, rev.drawingId);
  });
}
