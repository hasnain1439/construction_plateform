/**
 * Step 15 · Site instructions: the owner asks for something on site, the Munshi records it (photo +
 * note, offline-safe by clientId) and the office turns it into a change order draft or dismisses it.
 * Also: a snag whose cost attribution is CHANGE_ORDER becomes a change order draft.
 *
 * Who sees what: changeorder.instruction.view → every instruction of the project; only
 * changeorder.instruction.create (the Munshi) → own instructions. Never any money.
 */
import { can } from '../../core/auth/access.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Conflict, NotFound } from '../../core/errors/AppError.js';
import type { SiteInstruction } from '../../generated/prisma/client.js';
import { assertAttachments, attachmentsById, lockKey, peopleById, personOf, photosOf } from '../closeout/closeout.shared.js';
import { audit } from '../inventory/stock.js';
import type { Created } from '../labor/labor.shared.js';
import { notify } from '../notifications/notifications.service.js';
import { assertEditable, assertProjectScope } from '../projects/access.js';
import type { ConvertInput, CreateSiteInstructionInput, DismissInput, SiteInstructionsQuery } from './changeOrders.schema.js';
import { coActor, CO_PROJECT_STATUSES, type CoActor } from './changeOrders.shared.js';
import { convertFields, createTx as createCoTx } from './changeOrders.service.js';
import { changeOrderCode, siteInstructionCode } from './totals.js';

type Site = { tenantId: string; userId: string; role: CoActor['role'] };

const siNotFound = () => new NotFound('SITE_INSTRUCTION_NOT_FOUND', 'Site instruction not found');

/** Every instruction of the project, or (create only) the caller's own. */
const seesAll = (a: Site) => can('changeorder.instruction.view', a);

function assertMayRead(a: Site) {
  if (!can('changeorder.instruction.view', a) && !can('changeorder.instruction.create', a)) {
    // requirePerm(any) normally stops this first.
    throw new NotFound('SITE_INSTRUCTION_NOT_FOUND', 'Site instruction not found');
  }
}

async function toDtos(tx: Tx, tenantId: string, rows: SiteInstruction[]) {
  const files = await attachmentsById(
    tx,
    tenantId,
    rows.flatMap((r) => r.photoIds),
  );
  const people = await peopleById(
    tx,
    tenantId,
    rows.flatMap((r) => [r.createdById, r.decidedById]),
  );
  const cos = await tx.changeOrder.findMany({ where: { tenantId, siteInstructionId: { in: rows.map((r) => r.id) } }, select: { id: true, number: true, status: true, siteInstructionId: true } });
  const out = [];
  for (const r of rows) {
    const co = cos.find((c) => c.siteInstructionId === r.id);
    out.push({
      id: r.id,
      projectId: r.projectId,
      number: r.number,
      code: siteInstructionCode(r.number),
      note: r.note,
      photos: await photosOf(r.photoIds, files),
      status: r.status,
      changeOrder: co ? { id: co.id, code: changeOrderCode(co.number), status: co.status } : null,
      dismissReason: r.dismissReason,
      clientId: r.clientId,
      createdBy: personOf(people, r.createdById),
      createdAt: r.createdAt.toISOString(),
      decidedBy: personOf(people, r.decidedById),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  return out;
}

export type SiteInstructionDto = Awaited<ReturnType<typeof toDtos>>[number];

async function dto(tx: Tx, tenantId: string, id: string) {
  return (await toDtos(tx, tenantId, [await tx.siteInstruction.findUniqueOrThrow({ where: { id } })]))[0]!;
}

/** The instruction if the caller may see it (own one without instruction.view), else 404. */
async function findSi(tx: Tx, a: Site, id: string, perm: string) {
  const si = await tx.siteInstruction.findFirst({ where: { tenantId: a.tenantId, id } });
  if (!si) throw siNotFound();
  const project = await assertProjectScope(tx, perm, si.projectId, a).catch((err: unknown) => {
    if (err instanceof NotFound) throw siNotFound();
    throw err;
  });
  if (perm === 'changeorder.instruction.create' && !seesAll(a) && si.createdById !== a.userId) throw siNotFound();
  return { si, project };
}

const readPerm = (a: Site) => (seesAll(a) ? 'changeorder.instruction.view' : 'changeorder.instruction.create');

// ─── Read ───────────────────────────────────────────────────────────────────

export async function list(projectId: string, q: SiteInstructionsQuery) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    assertMayRead(a);
    await assertProjectScope(tx, readPerm(a), projectId, a);
    const base: Prisma.SiteInstructionWhereInput = { tenantId: a.tenantId, projectId, ...(seesAll(a) ? {} : { createdById: a.userId }) };
    const rows = await tx.siteInstruction.findMany({ where: { ...base, ...(q.status ? { status: q.status } : {}) }, orderBy: { number: 'desc' } });
    const counts = await tx.siteInstruction.groupBy({ by: ['status'], where: base, _count: true });
    const n = (s: SiteInstruction['status']) => counts.find((c) => c.status === s)?._count ?? 0;
    return { items: await toDtos(tx, a.tenantId, rows), summary: { new: n('NEW'), converted: n('CONVERTED'), dismissed: n('DISMISSED') } };
  });
}

export async function get(id: string) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    assertMayRead(a);
    const { si } = await findSi(tx, a, id, readPerm(a));
    return (await toDtos(tx, a.tenantId, [si]))[0]!;
  });
}

// ─── Create (REST + sync SITE_INSTRUCTION_CREATE) ──────────────────────────

export async function createTx(tx: Tx, a: Site, projectId: string, input: CreateSiteInstructionInput, opts: { at?: Date } = {}): Promise<Created<SiteInstructionDto>> {
  if (input.clientId) {
    const dup = await tx.siteInstruction.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: input.clientId } }, select: { id: true } });
    if (dup) return { created: false, data: await dto(tx, a.tenantId, dup.id) };
  }
  const project = await assertProjectScope(tx, 'changeorder.instruction.create', projectId, a);
  assertEditable(project, CO_PROJECT_STATUSES);
  await assertAttachments(tx, a.tenantId, input.photoIds, ['SITE_PHOTO'], 'photo');
  await lockKey(tx, `site-instruction:${projectId}`);
  const last = await tx.siteInstruction.findFirst({ where: { tenantId: a.tenantId, projectId }, orderBy: { number: 'desc' }, select: { number: true } });
  const si = await tx.siteInstruction.create({
    data: {
      tenantId: a.tenantId,
      projectId,
      number: (last?.number ?? 0) + 1,
      note: input.note,
      photoIds: input.photoIds ?? [],
      clientId: input.clientId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  const code = siteInstructionCode(si.number);
  await audit(tx, a, 'siteinstruction.create', 'SiteInstruction', si.id, { projectId, code, photos: si.photoIds.length, clientId: input.clientId ?? null });
  await notify(tx, {
    tenantId: a.tenantId,
    recipients: [{ projectRoles: ['THEKEDAR', 'PM'], projectId }],
    type: 'SITE_INSTRUCTION_CREATED',
    severity: 'INFO',
    text: { key: 'siteInstructionCreated', params: { project: project.name, code, note: input.note.slice(0, 120) } },
    projectId,
    ref: { type: 'SiteInstruction', id: si.id },
    actionUrl: `/projects/${projectId}/change-orders?tab=instructions`,
    actorId: a.userId,
    ...(opts.at ? { at: opts.at } : {}),
  });
  return { created: true, data: await dto(tx, a.tenantId, si.id) };
}

export async function create(projectId: string, input: CreateSiteInstructionInput) {
  const a = coActor();
  return withTenant(a.tenantId, (tx) => createTx(tx, a, projectId, input));
}

// ─── Office decisions ───────────────────────────────────────────────────────

function assertNew(si: SiteInstruction, coId: string | null) {
  if (si.status !== 'NEW') throw new Conflict('SITE_INSTRUCTION_NOT_NEW', `This instruction is already ${si.status.toLowerCase()}`, { status: si.status, changeOrderId: coId });
}

export async function convertTx(tx: Tx, a: CoActor, id: string, input: ConvertInput) {
  const { si, project } = await findSi(tx, a, id, 'changeorder.create');
  const existing = await tx.changeOrder.findFirst({ where: { tenantId: a.tenantId, siteInstructionId: si.id }, select: { id: true } });
  assertNew(si, existing?.id ?? null);
  const note = si.note.replace(/\s+/g, ' ').trim();
  const title = note.length >= 3 ? (note.length > 80 ? `${note.slice(0, 77)}…` : note) : `Site instruction ${siteInstructionCode(si.number)}`;
  const detail = await createCoTx(tx, a, project, convertFields(input, { title, description: si.note }), { source: 'SITE_INSTRUCTION', siteInstructionId: si.id });
  await tx.siteInstruction.update({ where: { id: si.id }, data: { status: 'CONVERTED', decidedById: a.userId, decidedAt: new Date() } });
  await audit(tx, a, 'siteinstruction.convert', 'SiteInstruction', si.id, { code: siteInstructionCode(si.number), changeOrderId: detail.id, changeOrderCode: detail.code });
  return detail;
}

export async function convert(id: string, input: ConvertInput) {
  const a = coActor();
  return withTenant(a.tenantId, (tx) => convertTx(tx, a, id, input));
}

export async function dismiss(id: string, input: DismissInput) {
  const a = coActor();
  return withTenant(a.tenantId, async (tx) => {
    const { si } = await findSi(tx, a, id, 'changeorder.create');
    assertNew(si, null);
    await tx.siteInstruction.update({ where: { id: si.id }, data: { status: 'DISMISSED', dismissReason: input.reason, decidedById: a.userId, decidedAt: new Date() } });
    await audit(tx, a, 'siteinstruction.dismiss', 'SiteInstruction', si.id, { code: siteInstructionCode(si.number), reason: input.reason });
    return dto(tx, a.tenantId, si.id);
  });
}

// ─── Snag → change order ────────────────────────────────────────────────────

export async function fromSnagTx(tx: Tx, a: CoActor, snagId: string, input: ConvertInput) {
  const snag = await tx.snag.findFirst({ where: { tenantId: a.tenantId, id: snagId } });
  if (!snag) throw new NotFound('SNAG_NOT_FOUND', 'Snag not found');
  const project = await assertProjectScope(tx, 'changeorder.create', snag.projectId, a).catch((err: unknown) => {
    if (err instanceof NotFound) throw new NotFound('SNAG_NOT_FOUND', 'Snag not found');
    throw err;
  });
  if (snag.costAttribution !== 'CHANGE_ORDER') throw new Conflict('SNAG_NOT_CHANGE_ORDER', 'Set this snag’s cost to “change order” first', { attribution: snag.costAttribution });
  const existing = await tx.changeOrder.findFirst({ where: { tenantId: a.tenantId, snagId: snag.id }, select: { id: true } });
  if (existing) throw new Conflict('SNAG_ALREADY_CONVERTED', 'This snag already has a change order', { changeOrderId: existing.id });
  const code = `SN-${String(snag.number).padStart(3, '0')}`;
  const title = `${code}: ${snag.description}`.slice(0, 200);
  const trusted = input.lines === undefined && snag.costAmountPaisa > 0n ? [{ kind: 'OTHER' as const, description: snag.description.slice(0, 300), unit: 'job', quantity: new Prisma.Decimal(1), ratePaisa: snag.costAmountPaisa }] : [];
  const detail = await createCoTx(tx, a, project, convertFields(input, { title: title.length >= 3 ? title : `Snag ${code}`, description: snag.costNote ?? snag.description }), {
    source: 'SNAG',
    snagId: snag.id,
    trustedLines: trusted,
  });
  return detail;
}

export async function fromSnag(snagId: string, input: ConvertInput) {
  const a = coActor();
  return withTenant(a.tenantId, (tx) => fromSnagTx(tx, a, snagId, input));
}

