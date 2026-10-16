/**
 * Platform admin · estimation rulebook versions (Step 11).
 *
 * A version is DRAFT until published; only a DRAFT's values / safe ranges can change (review
 * status and labels any time). Publishing makes it the version every company of the region uses
 * from then on (the highest PUBLISHED version); approved estimates keep the version they froze.
 * The parameter set comes from the code (src/modules/estimate/rulebookDefs.ts).
 */
import { prismaAdmin } from '../../core/db/prisma.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { Prisma, type Rulebook, type RulebookParameter } from '../../generated/prisma/client.js';
import { RULEBOOK_PARAMS } from '../estimate/rulebookDefs.js';
import { auditAdmin } from './platformAdmin.shared.js';
import type { CreateRulebookInput, RulebooksQuery, UpdateParameterInput, UpdateRulebookInput } from './rulebook.schema.js';

const notFound = () => new NotFound('RULEBOOK_NOT_FOUND', 'Rulebook version not found');

function paramDto(p: RulebookParameter) {
  return {
    id: p.id,
    key: p.key,
    group: p.group,
    label: { en: p.label, roman: p.labelRoman, ur: p.labelUrdu },
    unit: p.unit,
    description: p.description,
    value: Number(p.value),
    safeMin: Number(p.safeMin),
    safeMax: Number(p.safeMax),
    reviewStatus: p.reviewStatus,
    sortOrder: p.sortOrder,
  };
}

function detailDto(r: Rulebook & { parameters: RulebookParameter[] }) {
  return {
    id: r.id,
    region: r.region,
    version: r.version,
    status: r.status,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    parameters: [...r.parameters].sort((a, b) => a.sortOrder - b.sortOrder).map(paramDto),
  };
}

async function load(id: string, db: Prisma.TransactionClient | typeof prismaAdmin = prismaAdmin) {
  const r = await db.rulebook.findUnique({ where: { id }, include: { parameters: true } });
  if (!r) throw notFound();
  return r;
}

export async function listRulebooks(q: RulebooksQuery) {
  const rows = await prismaAdmin.rulebook.findMany({
    where: q.region ? { region: q.region } : {},
    include: { parameters: { select: { reviewStatus: true } } },
    orderBy: [{ region: 'asc' }, { version: 'desc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    region: r.region,
    version: r.version,
    status: r.status,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    notes: r.notes,
    parameterCount: r.parameters.length,
    pendingReview: r.parameters.filter((p) => p.reviewStatus === 'PENDING_ENGINEER_REVIEW').length,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getRulebook(id: string) {
  return detailDto(await load(id));
}

/** New DRAFT version = last + 1 of the region, values copied from `copyFromId` (or the latest version); keys the source lacks come from the built-in defaults. */
export async function createRulebook(input: CreateRulebookInput) {
  return prismaAdmin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rulebook:${input.region}`}))`;
    const source = input.copyFromId
      ? await tx.rulebook.findUnique({ where: { id: input.copyFromId }, include: { parameters: true } })
      : await tx.rulebook.findFirst({ where: { region: input.region }, orderBy: { version: 'desc' }, include: { parameters: true } });
    if (input.copyFromId && (!source || source.region !== input.region)) throw new BadRequest('INVALID_SOURCE', 'copyFromId must be a rulebook version of the same region');
    const last = await tx.rulebook.aggregate({ where: { region: input.region }, _max: { version: true } });
    const version = (last._max.version ?? 0) + 1;
    const from = new Map((source?.parameters ?? []).map((p) => [p.key, p]));
    const created = await tx.rulebook.create({ data: { region: input.region, version, status: 'DRAFT', notes: input.notes ?? null } });
    await tx.rulebookParameter.createMany({
      data: RULEBOOK_PARAMS.map((d, i) => {
        const p = from.get(d.key);
        return {
          rulebookId: created.id,
          key: d.key,
          group: d.group,
          label: p?.label ?? d.label.en,
          labelRoman: p?.labelRoman ?? d.label.roman,
          labelUrdu: p?.labelUrdu ?? d.label.ur,
          description: p ? p.description : d.description,
          unit: p?.unit ?? d.unit,
          value: p?.value ?? new Prisma.Decimal(d.value[input.region]),
          safeMin: p?.safeMin ?? new Prisma.Decimal(d.safeMin),
          safeMax: p?.safeMax ?? new Prisma.Decimal(d.safeMax),
          reviewStatus: p?.reviewStatus ?? 'PENDING_ENGINEER_REVIEW',
          sortOrder: i + 1,
        };
      }),
    });
    await auditAdmin(tx, { action: 'admin.rulebook_created', entityType: 'Rulebook', entityId: created.id, details: { region: input.region, version, copiedFrom: source ? source.version : null } });
    return detailDto(await load(created.id, tx));
  });
}

export async function updateRulebook(id: string, input: UpdateRulebookInput) {
  return prismaAdmin.$transaction(async (tx) => {
    const r = await load(id, tx);
    await tx.rulebook.update({ where: { id }, data: { notes: input.notes } });
    await auditAdmin(tx, { action: 'admin.rulebook_updated', entityType: 'Rulebook', entityId: id, details: { region: r.region, version: r.version, notes: input.notes } });
    return detailDto(await load(id, tx));
  });
}

export async function deleteRulebook(id: string) {
  return prismaAdmin.$transaction(async (tx) => {
    const r = await load(id, tx);
    if (r.status !== 'DRAFT') throw new Conflict('RULEBOOK_PUBLISHED', 'A published rulebook version cannot be deleted');
    await tx.rulebook.delete({ where: { id } });
    await auditAdmin(tx, { action: 'admin.rulebook_deleted', entityType: 'Rulebook', entityId: id, details: { region: r.region, version: r.version } });
    return { deleted: true };
  });
}

export async function updateParameter(id: string, key: string, input: UpdateParameterInput) {
  return prismaAdmin.$transaction(async (tx) => {
    const r = await load(id, tx);
    const p = r.parameters.find((x) => x.key === key);
    if (!p) throw new NotFound('PARAMETER_NOT_FOUND', `No parameter ${key} in this version`);
    const valueChange = input.value !== undefined || input.safeMin !== undefined || input.safeMax !== undefined;
    if (valueChange && r.status !== 'DRAFT') throw new Conflict('RULEBOOK_PUBLISHED', 'Values of a published version are frozen — create a new version');
    const safeMin = input.safeMin ?? Number(p.safeMin);
    const safeMax = input.safeMax ?? Number(p.safeMax);
    const value = input.value ?? Number(p.value);
    if (safeMin > safeMax) throw new BadRequest('INVALID_RANGE', 'safeMin must not be above safeMax', { safeMin, safeMax });
    if (value < safeMin || value > safeMax) throw new BadRequest('OUT_OF_SAFE_RANGE', `${key} must be between ${safeMin} and ${safeMax}`, { key, value, safeMin, safeMax });
    await tx.rulebookParameter.update({
      where: { id: p.id },
      data: {
        ...(input.value !== undefined ? { value: new Prisma.Decimal(input.value) } : {}),
        ...(input.safeMin !== undefined ? { safeMin: new Prisma.Decimal(input.safeMin) } : {}),
        ...(input.safeMax !== undefined ? { safeMax: new Prisma.Decimal(input.safeMax) } : {}),
        ...(input.reviewStatus !== undefined ? { reviewStatus: input.reviewStatus } : {}),
        ...(input.label?.en !== undefined ? { label: input.label.en } : {}),
        ...(input.label?.roman !== undefined ? { labelRoman: input.label.roman } : {}),
        ...(input.label?.ur !== undefined ? { labelUrdu: input.label.ur } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    await auditAdmin(tx, {
      action: 'admin.rulebook_parameter_updated',
      entityType: 'Rulebook',
      entityId: id,
      details: { region: r.region, version: r.version, key, before: { value: Number(p.value), safeMin: Number(p.safeMin), safeMax: Number(p.safeMax), reviewStatus: p.reviewStatus }, changes: input as Prisma.InputJsonValue },
    });
    return detailDto(await load(id, tx));
  });
}

export async function publishRulebook(id: string) {
  return prismaAdmin.$transaction(async (tx) => {
    const r = await load(id, tx);
    if (r.status !== 'DRAFT') throw new Conflict('RULEBOOK_PUBLISHED', 'This version is already published');
    for (const p of r.parameters) {
      if (Number(p.value) < Number(p.safeMin) || Number(p.value) > Number(p.safeMax)) {
        throw new BadRequest('OUT_OF_SAFE_RANGE', `${p.key} is outside its safe range`, { key: p.key, value: Number(p.value), safeMin: Number(p.safeMin), safeMax: Number(p.safeMax) });
      }
    }
    await tx.rulebook.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
    await auditAdmin(tx, {
      action: 'admin.rulebook_published',
      entityType: 'Rulebook',
      entityId: id,
      details: { region: r.region, version: r.version, pendingReview: r.parameters.filter((p) => p.reviewStatus === 'PENDING_ENGINEER_REVIEW').length },
    });
    return detailDto(await load(id, tx));
  });
}
