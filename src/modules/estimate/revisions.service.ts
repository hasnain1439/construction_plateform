/**
 * Saved estimates (BoQ revisions) of a project.
 *
 *   Generate   POST /projects/:id/estimates      → DRAFT Rev n (n = last + 1); one DRAFT at a time
 *   Regenerate POST /estimates/:id/regenerate     → DRAFT only: fresh quantities / rates / rulebook,
 *                                                  line overrides kept by lineKey
 *   Override   PATCH /estimates/:id/lines/:lineId → DRAFT only: quantity and / or rate with a note
 *   Approve    POST /estimates/:id/approve        → APPROVED (rates + rulebook frozen); the previous
 *                                                  APPROVED becomes SUPERSEDED (one APPROVED per project)
 *   Compare    GET /estimates/:a/compare/:b       → line diffs (by lineKey) + totals diff
 *
 * A price-list change marks the DRAFT estimates that use the material `ratesOutdated`
 * (markRatesOutdated, called by the price-list service); APPROVED / SUPERSEDED never change.
 *
 * Stored line `amountPaisa` / `rateQuantity` are the EFFECTIVE values (after the override);
 * `ratePaisa` stays the price-list rate. Money fields need fields.rates (+ contract / profit).
 */
import { writeAudit } from '../../core/audit/audit.js';
import { assertPerm, fieldAccess, type FieldAccess } from '../../core/auth/access.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { tr, type Lang } from '../../core/i18n/index.js';
import { estimateHtml, shoppingListHtml } from '../../core/pdf/templates.js';
import { Prisma, type Estimate, type EstimateLine } from '../../generated/prisma/client.js';
import { documentLang, letterhead, pdfFileName, salutation, shareOf, storePdf } from '../billing/documents.js';
import { assertEditable, assertProjectScope, caller, findProjectFor, type Caller } from '../projects/access.js';
import { contractTotalPaisa } from '../projects/projects.dto.js';
import * as repo from '../projects/projects.repository.js';
import { BOQ_SECTIONS, BUILD_STAGES, priceQuantity, summarize, type BoqLine, type BuildStageKey, type TotalsLine } from './boq.js';
import { computeEstimate, ratesSnapshot, type EstimateContext } from './estimate.service.js';
import { estimateChangesLayer } from '../change-orders/estimateLayer.js'; // Step 15

const str = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
const estimateNotFound = () => new NotFound('ESTIMATE_NOT_FOUND', 'Estimate not found');

const userSel = { select: { id: true, name: true } } as const;
const withPeople = { generatedBy: userSel, approvedBy: userSel, rulebook: { select: { id: true, region: true, version: true } } } as const;
type EstimateRow = Estimate & { generatedBy: { id: string; name: string } | null; approvedBy: { id: string; name: string } | null; rulebook: { id: string; region: string; version: number } | null };
type LineRow = EstimateLine & { overriddenBy: { id: string; name: string } | null };
type ProjectInfo = { id: string; code: string; name: string; contractType: repo.ProjectFull['contractType'] } & Parameters<typeof contractTotalPaisa>[0];

const projectSel = { id: true, code: true, name: true, contractType: true, contractValuePaisa: true, ratePerSqftPaisa: true, coveredAreaSqft: true } as const;

// ─── Loading + access ───────────────────────────────────────────────────────

/** The estimate, if its project is in the caller's scope for `perm` (else 404 ESTIMATE_NOT_FOUND). */
async function findEstimate(tx: Tx, c: Caller, id: string, perm: string): Promise<EstimateRow> {
  assertPerm(perm, c);
  const e = await tx.estimate.findFirst({ where: { tenantId: c.tenantId, id }, include: withPeople });
  if (!e) throw estimateNotFound();
  try {
    await findProjectFor(tx, c, e.projectId, perm);
  } catch (err) {
    if (err instanceof NotFound) throw estimateNotFound();
    throw err;
  }
  return e;
}

const lineRows = (tx: Tx, estimateId: string) =>
  tx.estimateLine.findMany({ where: { estimateId }, orderBy: { sortOrder: 'asc' }, include: { overriddenBy: userSel } }) as Promise<LineRow[]>;

const projectInfo = (tx: Tx, projectId: string) => tx.project.findUniqueOrThrow({ where: { id: projectId }, select: projectSel }) as Promise<ProjectInfo>;

// ─── DTOs ───────────────────────────────────────────────────────────────────

function lineDto(l: LineRow, fa: FieldAccess) {
  const quantityWithWastage = Number(l.quantityWithWastage);
  const override =
    l.overrideQuantity !== null || l.overrideRatePaisa !== null
      ? {
          quantity: num(l.overrideQuantity),
          ...(fa.rates ? { ratePaisa: str(l.overrideRatePaisa) } : {}),
          note: l.overrideNote ?? '',
          by: l.overriddenBy,
          at: l.overriddenAt?.toISOString() ?? null,
        }
      : null;
  return {
    id: l.id,
    lineKey: l.lineKey,
    section: l.section,
    stageKey: l.stageKey,
    kind: l.kind,
    description: l.description,
    material: l.material,
    materialId: l.materialId,
    unit: l.unit,
    quantity: Number(l.quantity),
    wastagePercent: Number(l.wastagePercent),
    quantityWithWastage,
    suppliedBy: l.suppliedBy,
    formula: l.formula,
    trace: l.trace as string[],
    override,
    effectiveQuantity: l.overrideQuantity !== null ? Number(l.overrideQuantity) : quantityWithWastage,
    ...(fa.rates
      ? {
          ratePaisa: str(l.ratePaisa),
          effectiveRatePaisa: str(l.overrideRatePaisa ?? l.ratePaisa),
          rateUnit: l.rateUnit,
          rateQuantity: num(l.rateQuantity),
          amountPaisa: str(l.amountPaisa),
          rateStatus: l.rateStatus,
        }
      : {}),
  };
}

function summaryDto(e: EstimateRow, p: ProjectInfo, counts: { lines: number; owner: number }, fa: FieldAccess) {
  const covered = Number(e.coveredAreaSqft);
  const contract = contractTotalPaisa(p);
  const margin = contract === null ? null : contract - e.totalPaisa;
  return {
    id: e.id,
    projectId: e.projectId,
    revision: e.revision,
    status: e.status,
    ratesOutdated: e.ratesOutdated,
    note: e.note,
    rulebook: e.rulebook,
    region: e.region,
    generatedAt: e.generatedAt.toISOString(),
    generatedBy: e.generatedBy,
    approvedAt: e.approvedAt?.toISOString() ?? null,
    approvedBy: e.approvedBy,
    supersededAt: e.supersededAt?.toISOString() ?? null,
    coveredAreaSqft: covered,
    lineCount: counts.lines,
    ownerSuppliedLines: counts.owner,
    ...(fa.rates
      ? {
          directCostPaisa: e.directCostPaisa.toString(),
          overheadPaisa: e.overheadPaisa.toString(),
          contingencyPaisa: e.contingencyPaisa.toString(),
          totalPaisa: e.totalPaisa.toString(),
          perSqftPaisa: covered > 0 ? BigInt(new Prisma.Decimal(e.totalPaisa.toString()).div(covered).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)).toString() : null,
          ...(fa.contract ? { contractTotalPaisa: str(contract) } : {}),
          ...(fa.contract && fa.profit
            ? { marginPaisa: str(margin), marginPercent: contract && contract > 0n && margin !== null ? Math.round((Number(margin) / Number(contract)) * 10000) / 100 : null }
            : {}),
        }
      : {}),
  };
}

function detailDto(e: EstimateRow, p: ProjectInfo, lines: LineRow[], fa: FieldAccess) {
  const counts = { lines: lines.length, owner: lines.filter((l) => l.suppliedBy === 'OWNER').length };
  const amountOf = (pred: (l: LineRow) => boolean) => lines.filter((l) => pred(l) && l.suppliedBy === 'CONTRACTOR' && l.amountPaisa !== null).reduce((a, l) => a + l.amountPaisa!, 0n);
  const snap = e.overridesSnapshot as { parameters?: Record<string, { value: number; source: string }> };
  const basis = e.basis as { warnings?: unknown[] } & Record<string, unknown>;
  const { warnings, ...rest } = basis;
  return {
    ...summaryDto(e, p, counts, fa),
    project: { id: p.id, code: p.code, name: p.name, contractType: p.contractType },
    sections: BOQ_SECTIONS.map((section) => ({
      section,
      lines: lines.filter((l) => l.section === section).map((l) => lineDto(l, fa)),
      ...(fa.rates ? { amountPaisa: amountOf((l) => l.section === section).toString() } : {}),
    })).filter((s) => s.lines.length),
    stages: BUILD_STAGES.map((stageKey) => ({ stageKey, ...(fa.rates ? { amountPaisa: amountOf((l) => l.stageKey === stageKey && l.kind !== 'PERCENT').toString() } : {}) })),
    parameters: snap.parameters ?? {},
    warnings: (warnings ?? []).filter((w) => fa.rates || !String((w as { code?: string }).code ?? '').includes('RATES')),
    basis: rest,
  };
}

export type EstimateDetailDto = ReturnType<typeof detailDto>;

async function detail(tx: Tx, c: Caller, id: string) {
  const e = (await tx.estimate.findFirstOrThrow({ where: { id }, include: withPeople })) as EstimateRow;
  const fa = c.fields ?? fieldAccess(c);
  const dto = detailDto(e, await projectInfo(tx, e.projectId), await lineRows(tx, id), fa);
  // Step 15: approved change orders on top of the APPROVED baseline (which never changes).
  return { ...dto, changes: e.status === 'APPROVED' ? await estimateChangesLayer(tx, c.tenantId, e.projectId, e.totalPaisa, fa) : null };
}

// ─── Writing lines ──────────────────────────────────────────────────────────

function lineData(tenantId: string, estimateId: string, l: BoqLine, i: number, keep?: Pick<EstimateLine, 'overrideQuantity' | 'overrideRatePaisa' | 'overrideNote' | 'overriddenById' | 'overriddenAt'>) {
  const base = {
    tenantId,
    estimateId,
    sortOrder: i + 1,
    lineKey: l.lineKey,
    section: l.section,
    stageKey: l.stageKey,
    kind: l.kind,
    description: l.description,
    material: l.material,
    materialId: l.materialId,
    unit: l.unit,
    quantity: new Prisma.Decimal(l.quantity),
    wastagePercent: new Prisma.Decimal(l.wastagePercent),
    quantityWithWastage: new Prisma.Decimal(l.quantityWithWastage),
    suppliedBy: l.suppliedBy,
    formula: l.formula,
    trace: l.trace,
    ratePaisa: l.ratePaisa,
    rateUnit: l.rateUnit,
    rateFactor: l.rateFactor === null ? null : new Prisma.Decimal(l.rateFactor),
    rateQuantity: l.rateQuantity === null ? null : new Prisma.Decimal(l.rateQuantity),
    amountPaisa: l.amountPaisa,
    rateStatus: l.rateStatus,
  };
  if (!keep || l.kind === 'PERCENT') return base;
  const owner = l.suppliedBy === 'OWNER';
  const rateOverride = owner ? null : keep.overrideRatePaisa;
  if (keep.overrideQuantity === null && rateOverride === null) return base;
  const priced = effectivePrice({ ...base, overrideQuantity: keep.overrideQuantity, overrideRatePaisa: rateOverride, rateFactor: base.rateFactor });
  return { ...base, ...keep, overrideRatePaisa: rateOverride, rateQuantity: priced.rateQuantity, amountPaisa: priced.amountPaisa };
}

/** Effective rate quantity / amount of a line with its overrides (a rate on a line without one is per the line's unit). */
export function effectivePrice(l: { kind: string; suppliedBy: string; quantityWithWastage: Prisma.Decimal; ratePaisa: bigint | null; rateFactor: Prisma.Decimal | null; overrideQuantity: Prisma.Decimal | null; overrideRatePaisa: bigint | null }) {
  if (l.suppliedBy === 'OWNER') return { rateQuantity: null, amountPaisa: null };
  const qty = Number(l.overrideQuantity ?? l.quantityWithWastage);
  const rate = l.overrideRatePaisa ?? l.ratePaisa;
  const factor = l.rateFactor !== null ? Number(l.rateFactor) : l.overrideRatePaisa !== null ? 1 : null;
  const p = priceQuantity(qty, factor, rate);
  return { rateQuantity: p.rateQuantity === null ? null : new Prisma.Decimal(p.rateQuantity), amountPaisa: p.amountPaisa };
}

/** Recomputes the PERCENT lines and the estimate totals from the stored (effective) line amounts. */
export async function recomputeTotals(tx: Tx, estimateId: string) {
  const e = await tx.estimate.findUniqueOrThrow({ where: { id: estimateId }, select: { coveredAreaSqft: true } });
  const rows = await tx.estimateLine.findMany({ where: { estimateId }, orderBy: { sortOrder: 'asc' } });
  const lines: Array<TotalsLine & { id: string }> = rows.map((l) => ({
    id: l.id,
    section: l.section,
    stageKey: l.stageKey,
    kind: l.kind,
    suppliedBy: l.suppliedBy,
    quantity: Number(l.quantity),
    amountPaisa: l.amountPaisa,
    rateQuantity: num(l.rateQuantity),
  }));
  const t = summarize(lines, Number(e.coveredAreaSqft), null);
  for (const l of lines.filter((x) => x.kind === 'PERCENT')) {
    await tx.estimateLine.update({ where: { id: l.id }, data: { amountPaisa: l.amountPaisa, rateQuantity: l.rateQuantity === null ? null : new Prisma.Decimal(l.rateQuantity) } });
  }
  await tx.estimate.update({
    where: { id: estimateId },
    data: { directCostPaisa: t.directCostPaisa, overheadPaisa: t.overheadPaisa, contingencyPaisa: t.contingencyPaisa, totalPaisa: t.totalPaisa },
  });
}

function snapshots(ctx: EstimateContext) {
  const company = Object.fromEntries(ctx.rb.params.filter((p) => p.source === 'COMPANY').map((p) => [p.key, p.value]));
  return {
    rulebookVersionId: ctx.rb.rulebook?.id ?? null,
    region: ctx.rb.region,
    overridesSnapshot: { company, project: ctx.overrides, parameters: ctx.sources } as Prisma.InputJsonValue,
    ratesSnapshot: ratesSnapshot(ctx) as Prisma.InputJsonValue,
    basis: {
      structureType: ctx.q.basis.structureType,
      structureTypeAssumed: ctx.q.basis.structureTypeAssumed,
      coveredAreaSqft: ctx.q.basis.coveredAreaSqft,
      coveredAreaSource: ctx.q.basis.coveredAreaSource,
      plotAreaSqft: ctx.q.basis.plotAreaSqft,
      methods: ctx.q.basis.methods,
      floors: ctx.q.basis.floors.map((f) => ({ level: f.level, name: f.name, rooms: f.rooms, roomAreaSqft: f.roomAreaSqft, footprintSqft: f.footprintSqft, wallsMethod: f.wallsMethod, roofMethod: f.roofMethod })),
      warnings: [...ctx.q.warnings, ...ctx.boq.warnings],
    } as unknown as Prisma.InputJsonValue,
    coveredAreaSqft: new Prisma.Decimal(ctx.boq.coveredAreaSqft),
    directCostPaisa: ctx.boq.totals.directCostPaisa,
    overheadPaisa: ctx.boq.totals.overheadPaisa,
    contingencyPaisa: ctx.boq.totals.contingencyPaisa,
    totalPaisa: ctx.boq.totals.totalPaisa,
  };
}

const audit = (tx: Tx, c: Pick<Caller, 'tenantId' | 'userId'>, action: string, id: string, details: Prisma.InputJsonValue) =>
  writeAudit(tx, { tenantId: c.tenantId, actorType: 'USER', actorId: c.userId, action, entityType: 'Estimate', entityId: id, details });

// ─── Generate / regenerate ──────────────────────────────────────────────────

/** Creates DRAFT Rev n of a project (no request context needed — the seed uses it too). */
export async function generateInTx(tx: Tx, c: Pick<Caller, 'tenantId' | 'userId'>, projectId: string, note?: string | null, opts: { audit?: boolean } = {}): Promise<string> {
  const draft = await tx.estimate.findFirst({ where: { projectId, status: 'DRAFT' }, select: { id: true, revision: true } });
  if (draft) throw new Conflict('ESTIMATE_DRAFT_EXISTS', `Rev ${draft.revision} is still a draft — regenerate or approve it first`, { estimateId: draft.id });
  const p = await repo.loadFull(tx, projectId);
  const ctx = await computeEstimate(tx, c.tenantId, p);
  const last = await tx.estimate.aggregate({ where: { projectId }, _max: { revision: true } });
  const revision = (last._max.revision ?? 0) + 1;
  const e = await tx.estimate.create({
    data: { tenantId: c.tenantId, projectId, revision, status: 'DRAFT', note: note ?? null, generatedById: c.userId, ...snapshots(ctx) },
  });
  await tx.estimateLine.createMany({ data: ctx.boq.lines.map((l, i) => lineData(c.tenantId, e.id, l, i)) });
  if (opts.audit !== false) await audit(tx, c, 'estimate.generate', e.id, { projectId, code: p.code, revision, totalPaisa: e.totalPaisa.toString(), lines: ctx.boq.lines.length, rulebookVersion: ctx.rb.rulebook?.version ?? null });
  return e.id;
}

export async function generate(projectId: string, input: { note?: string | null }) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await assertProjectScope(tx, 'projects.estimate.manage', projectId, c);
    assertEditable(project);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`estimate:${projectId}`}))`;
    const id = await generateInTx(tx, c, projectId, input.note);
    return detail(tx, c, id);
  });
}

export async function regenerate(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const e = await findEstimate(tx, c, id, 'projects.estimate.manage');
    if (e.status !== 'DRAFT') throw new Conflict('ESTIMATE_LOCKED', `Rev ${e.revision} is ${e.status.toLowerCase()} — only a draft can be regenerated`, { status: e.status });
    const p = await repo.loadFull(tx, e.projectId);
    const ctx = await computeEstimate(tx, c.tenantId, p);
    const old = await tx.estimateLine.findMany({ where: { estimateId: id }, select: { lineKey: true, overrideQuantity: true, overrideRatePaisa: true, overrideNote: true, overriddenById: true, overriddenAt: true } });
    const kept = new Map(old.filter((l) => l.overrideQuantity !== null || l.overrideRatePaisa !== null).map((l) => [l.lineKey, l]));
    await tx.estimateLine.deleteMany({ where: { estimateId: id } });
    await tx.estimateLine.createMany({ data: ctx.boq.lines.map((l, i) => lineData(c.tenantId, id, l, i, kept.get(l.lineKey))) });
    await tx.estimate.update({ where: { id }, data: { ...snapshots(ctx), ratesOutdated: false, generatedAt: new Date(), generatedById: c.userId } });
    if (kept.size) await recomputeTotals(tx, id);
    const after = await tx.estimate.findUniqueOrThrow({ where: { id }, select: { totalPaisa: true } });
    await audit(tx, c, 'estimate.regenerate', id, { projectId: e.projectId, revision: e.revision, totalPaisa: after.totalPaisa.toString(), previousTotalPaisa: e.totalPaisa.toString(), overridesKept: [...kept.keys()].filter((k) => ctx.boq.lines.some((l) => l.lineKey === k)).length });
    return detail(tx, c, id);
  });
}

// ─── Line overrides ─────────────────────────────────────────────────────────

export interface LineOverrideInput {
  quantity?: number | null;
  ratePaisa?: string | null;
  note?: string;
}

export async function overrideLine(id: string, lineId: string, input: LineOverrideInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const e = await findEstimate(tx, c, id, 'projects.estimate.manage');
    if (e.status !== 'DRAFT') throw new Conflict('ESTIMATE_LOCKED', `Rev ${e.revision} is ${e.status.toLowerCase()} — only a draft can be changed`, { status: e.status });
    const line = await tx.estimateLine.findFirst({ where: { estimateId: id, id: lineId } });
    if (!line) throw new NotFound('ESTIMATE_LINE_NOT_FOUND', 'Estimate line not found');
    if (line.kind === 'PERCENT') throw new BadRequest('LINE_NOT_EDITABLE', 'Overheads and contingency follow the other lines — change the % in the rulebook settings');
    if (input.ratePaisa !== undefined) {
      assertPerm('fields.rates', c, 'Changing a rate needs the "See rates" permission');
      if (input.ratePaisa !== null && line.suppliedBy === 'OWNER') throw new BadRequest('OWNER_SUPPLIED_NO_RATE', 'The owner buys this material — it has no rate in the estimate');
    }
    const settingValue = (input.quantity !== undefined && input.quantity !== null) || (input.ratePaisa !== undefined && input.ratePaisa !== null);
    if (settingValue && !input.note?.trim()) throw new BadRequest('NOTE_REQUIRED', 'Say why the line is changed (note)');
    const overrideQuantity = input.quantity === undefined ? line.overrideQuantity : input.quantity === null ? null : new Prisma.Decimal(input.quantity);
    const overrideRatePaisa = input.ratePaisa === undefined ? line.overrideRatePaisa : input.ratePaisa === null ? null : BigInt(input.ratePaisa);
    const cleared = overrideQuantity === null && overrideRatePaisa === null;
    const priced = effectivePrice({ ...line, overrideQuantity, overrideRatePaisa });
    await tx.estimateLine.update({
      where: { id: lineId },
      data: {
        overrideQuantity,
        overrideRatePaisa,
        overrideNote: cleared ? null : (input.note?.trim() ?? line.overrideNote),
        overriddenById: cleared ? null : c.userId,
        overriddenAt: cleared ? null : new Date(),
        rateQuantity: priced.rateQuantity,
        amountPaisa: priced.amountPaisa,
      },
    });
    await recomputeTotals(tx, id);
    await audit(tx, c, 'estimate.line_override', id, {
      revision: e.revision,
      lineKey: line.lineKey,
      quantity: overrideQuantity === null ? null : Number(overrideQuantity),
      ratePaisa: str(overrideRatePaisa),
      previousQuantity: num(line.overrideQuantity),
      previousRatePaisa: str(line.overrideRatePaisa),
      note: cleared ? null : (input.note?.trim() ?? null),
    });
    return detail(tx, c, id);
  });
}

// ─── Approve ────────────────────────────────────────────────────────────────

export async function approve(id: string, input: { confirmOutdatedRates?: boolean }) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const e = await findEstimate(tx, c, id, 'estimate.revision.approve');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`estimate:${e.projectId}`}))`;
    await approveInTx(tx, c, e, input);
    return detail(tx, c, id);
  });
}

/** Approves a DRAFT (seed + service): supersedes the current APPROVED revision first (one APPROVED per project). */
export async function approveInTx(tx: Tx, c: Pick<Caller, 'tenantId' | 'userId'>, e: Pick<Estimate, 'id' | 'projectId' | 'revision' | 'status' | 'ratesOutdated' | 'totalPaisa'>, input: { confirmOutdatedRates?: boolean }, opts: { audit?: boolean } = {}): Promise<void> {
  if (e.status !== 'DRAFT') throw new Conflict('ESTIMATE_NOT_DRAFT', `Rev ${e.revision} is already ${e.status.toLowerCase()}`, { status: e.status });
  if (e.ratesOutdated && !input.confirmOutdatedRates) {
    throw new Conflict('RATES_OUTDATED', 'The price list changed after this estimate was made — regenerate it, or approve with confirmOutdatedRates: true');
  }
  const previous = await tx.estimate.findFirst({ where: { projectId: e.projectId, status: 'APPROVED' }, select: { id: true, revision: true } });
  const now = new Date();
  if (previous) await tx.estimate.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED', supersededAt: now } });
  await tx.estimate.update({ where: { id: e.id }, data: { status: 'APPROVED', approvedAt: now, approvedById: c.userId } });
  if (opts.audit !== false) await audit(tx, c, 'estimate.approve', e.id, {
    projectId: e.projectId,
    revision: e.revision,
    totalPaisa: e.totalPaisa.toString(),
    supersededRevision: previous?.revision ?? null,
    ratesOutdated: e.ratesOutdated,
  });
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function listForProject(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await assertProjectScope(tx, 'projects.estimate.view', projectId, c);
    const p = await projectInfo(tx, projectId);
    const rows = (await tx.estimate.findMany({ where: { projectId }, include: withPeople, orderBy: { revision: 'desc' } })) as EstimateRow[];
    const counts = await tx.estimateLine.groupBy({ by: ['estimateId', 'suppliedBy'], where: { estimateId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const fa = c.fields ?? fieldAccess(c);
    return rows.map((e) => {
      const mine = counts.filter((x) => x.estimateId === e.id);
      return summaryDto(e, p, { lines: mine.reduce((a, x) => a + x._count._all, 0), owner: mine.filter((x) => x.suppliedBy === 'OWNER').reduce((a, x) => a + x._count._all, 0) }, fa);
    });
  });
}

export async function getOne(id: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await findEstimate(tx, c, id, 'projects.estimate.view');
    return detail(tx, c, id);
  });
}

// ─── Compare ────────────────────────────────────────────────────────────────

export async function compare(aId: string, bId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const a = await findEstimate(tx, c, aId, 'projects.estimate.view');
    const b = await findEstimate(tx, c, bId, 'projects.estimate.view');
    if (a.projectId !== b.projectId) throw new BadRequest('DIFFERENT_PROJECTS', 'Both revisions must belong to the same project');
    const fa = c.fields ?? fieldAccess(c);
    const p = await projectInfo(tx, a.projectId);
    const la = await lineRows(tx, a.id);
    const lb = await lineRows(tx, b.id);
    const ma = new Map(la.map((l) => [l.lineKey, l]));
    const mb = new Map(lb.map((l) => [l.lineKey, l]));
    const effQty = (l: LineRow | undefined) => (l ? Number(l.overrideQuantity ?? l.quantityWithWastage) : null);
    const effRate = (l: LineRow | undefined) => (l ? (l.overrideRatePaisa ?? l.ratePaisa) : null);
    const keys = [...new Set([...la.map((l) => l.lineKey), ...lb.map((l) => l.lineKey)])];
    const order = (k: string) => (mb.get(k)?.sortOrder ?? 0) * 10_000 + (ma.get(k)?.sortOrder ?? 0);
    const lines = keys
      .sort((x, y) => BOQ_SECTIONS.indexOf((mb.get(x) ?? ma.get(x))!.section as never) - BOQ_SECTIONS.indexOf((mb.get(y) ?? ma.get(y))!.section as never) || order(x) - order(y))
      .map((k) => {
        const x = ma.get(k);
        const y = mb.get(k);
        const ref = (y ?? x)!;
        const qa = effQty(x);
        const qb = effQty(y);
        const amtA = x?.amountPaisa ?? null;
        const amtB = y?.amountPaisa ?? null;
        const change = !x ? 'ADDED' : !y ? 'REMOVED' : qa !== qb || effRate(x) !== effRate(y) || amtA !== amtB ? 'CHANGED' : 'UNCHANGED';
        return {
          lineKey: k,
          section: ref.section,
          stageKey: ref.stageKey,
          description: ref.description,
          unit: ref.unit,
          change,
          quantityA: qa,
          quantityB: qb,
          quantityDelta: Math.round(((qb ?? 0) - (qa ?? 0)) * 10000) / 10000,
          ...(fa.rates
            ? { ratePaisaA: str(effRate(x)), ratePaisaB: str(effRate(y)), amountPaisaA: str(amtA), amountPaisaB: str(amtB), amountDeltaPaisa: ((amtB ?? 0n) - (amtA ?? 0n)).toString() }
            : {}),
        };
      });
    const sectionSum = (ls: LineRow[], s: string) => ls.filter((l) => l.section === s && l.suppliedBy === 'CONTRACTOR').reduce((acc, l) => acc + (l.amountPaisa ?? 0n), 0n);
    const counts = (ls: LineRow[]) => ({ lines: ls.length, owner: ls.filter((l) => l.suppliedBy === 'OWNER').length });
    return {
      a: summaryDto(a, p, counts(la), fa),
      b: summaryDto(b, p, counts(lb), fa),
      lines,
      sections: BOQ_SECTIONS.filter((s) => la.some((l) => l.section === s) || lb.some((l) => l.section === s)).map((s) => ({
        section: s,
        ...(fa.rates ? { amountPaisaA: sectionSum(la, s).toString(), amountPaisaB: sectionSum(lb, s).toString(), deltaPaisa: (sectionSum(lb, s) - sectionSum(la, s)).toString() } : {}),
      })),
      ...(fa.rates
        ? {
            totals: {
              totalPaisaA: a.totalPaisa.toString(),
              totalPaisaB: b.totalPaisa.toString(),
              deltaPaisa: (b.totalPaisa - a.totalPaisa).toString(),
              deltaPercent: a.totalPaisa > 0n ? Math.round((Number(b.totalPaisa - a.totalPaisa) / Number(a.totalPaisa)) * 10000) / 100 : null,
            },
          }
        : {}),
    };
  });
}

// ─── Owner shopping list ────────────────────────────────────────────────────

interface ShoppingLine {
  material: string | null;
  materialId: string | null;
  description: string;
  unit: string;
  stageKey: string | null;
  quantity: number;
}

function shoppingItems(lines: ShoppingLine[]) {
  const items = new Map<string, { material: string; materialId: string | null; description: string; unit: string; quantity: number; stages: Map<string, number> }>();
  for (const l of lines) {
    const key = l.material ?? l.description;
    const it = items.get(key) ?? { material: key, materialId: l.materialId, description: l.description, unit: l.unit, quantity: 0, stages: new Map<string, number>() };
    it.quantity += l.quantity;
    const st = l.stageKey ?? 'FINISHING';
    it.stages.set(st, (it.stages.get(st) ?? 0) + l.quantity);
    items.set(key, it);
  }
  const stageIdx = (s: string) => BUILD_STAGES.indexOf(s as BuildStageKey);
  return [...items.values()]
    .map((it) => {
      const stages = [...it.stages.entries()].sort((x, y) => stageIdx(x[0]) - stageIdx(y[0])).map(([stageKey, quantity]) => ({ stageKey, quantity: Math.round(quantity * 100) / 100 }));
      return { material: it.material, materialId: it.materialId, description: it.description, unit: it.unit, quantity: Math.round(it.quantity * 100) / 100, neededBy: stages[0]!.stageKey, stages };
    })
    .sort((x, y) => stageIdx(x.neededBy) - stageIdx(y.neededBy) || x.description.localeCompare(y.description));
}

async function shoppingList(tx: Tx, c: Caller, projectId: string, estimateId?: string) {
  await assertProjectScope(tx, 'projects.estimate.view', projectId, c);
  let e: { id: string; revision: number; status: string } | null = null;
  if (estimateId) {
    e = await tx.estimate.findFirst({ where: { id: estimateId, projectId }, select: { id: true, revision: true, status: true } });
    if (!e) throw estimateNotFound();
  } else {
    e =
      (await tx.estimate.findFirst({ where: { projectId, status: 'APPROVED' }, select: { id: true, revision: true, status: true } })) ??
      (await tx.estimate.findFirst({ where: { projectId, status: 'DRAFT' }, select: { id: true, revision: true, status: true } }));
  }
  if (e) {
    const rows = await tx.estimateLine.findMany({ where: { estimateId: e.id, suppliedBy: 'OWNER', kind: 'MATERIAL' }, orderBy: { sortOrder: 'asc' } });
    const items = shoppingItems(rows.map((l) => ({ material: l.material, materialId: l.materialId, description: l.description, unit: l.unit, stageKey: l.stageKey, quantity: Number(l.overrideQuantity ?? l.quantityWithWastage) })));
    return { source: estimateId ? ('ESTIMATE' as const) : (e.status as 'APPROVED' | 'DRAFT'), estimateId: e.id, revision: e.revision, items };
  }
  const ctx = await computeEstimate(tx, c.tenantId, await repo.loadFull(tx, projectId));
  const items = shoppingItems(ctx.boq.lines.filter((l) => l.suppliedBy === 'OWNER' && l.kind === 'MATERIAL').map((l) => ({ ...l, quantity: l.quantityWithWastage })));
  return { source: 'PREVIEW' as const, estimateId: null, revision: null, items };
}

export async function ownerShoppingList(projectId: string, estimateId?: string) {
  const c = caller();
  return withTenant(c.tenantId, (tx) => shoppingList(tx, c, projectId, estimateId));
}

export async function ownerShoppingListPdf(projectId: string, q: { estimateId?: string; lang?: Lang }) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const list = await shoppingList(tx, c, projectId, q.estimateId);
    const p = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, code: true, client: { select: { name: true, phone: true } } } });
    const lang = await documentLang(tx, c.userId, q.lang);
    const html = shoppingListHtml({ company: await letterhead(tx, c.tenantId), project: p, generatedOn: new Date().toISOString().slice(0, 10), items: list.items }, lang);
    const name = pdfFileName(`Owner shopping list ${p.code}${list.revision ? ` Rev ${list.revision}` : ''}`, lang);
    const id = await storePdf(tx, c.tenantId, c.userId, 'REPORT', name, html, `${tr(lang, 'pdf.ownerShoppingList')} · ${p.name}`, lang);
    const items = list.items.slice(0, 6).map((i) => `${i.description} ${i.quantity} ${i.unit}`).join(', ');
    const share = await shareOf(tx, c.tenantId, id, (url) => tr(lang, 'share.ownerShoppingList', { salutation: salutation(p.client?.name, lang), project: p.name, items, url }));
    return { ...share!, clientPhone: p.client?.phone ?? null };
  });
}

// ─── PDF (internal BoQ) ─────────────────────────────────────────────────────

export async function estimatePdf(id: string, langOverride?: Lang) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const e = await findEstimate(tx, c, id, 'projects.estimate.view');
    const p = await projectInfo(tx, e.projectId);
    const lines = await lineRows(tx, id);
    const fa = c.fields ?? fieldAccess(c);
    const lang = await documentLang(tx, c.userId, langOverride);
    const amountOf = (s: string) => lines.filter((l) => l.section === s && l.suppliedBy === 'CONTRACTOR').reduce((a, l) => a + (l.amountPaisa ?? 0n), 0n);
    const covered = Number(e.coveredAreaSqft);
    const html = estimateHtml(
      {
        company: await letterhead(tx, c.tenantId),
        project: { name: p.name, code: p.code },
        revision: e.revision,
        status: e.status,
        generatedOn: e.generatedAt.toISOString().slice(0, 10),
        coveredAreaSqft: covered,
        showMoney: fa.rates,
        sections: BOQ_SECTIONS.filter((s) => lines.some((l) => l.section === s)).map((s) => ({
          section: s,
          amountPaisa: amountOf(s),
          lines: lines
            .filter((l) => l.section === s)
            .map((l) => ({
              description: l.description,
              stageKey: l.stageKey,
              quantity: Number(l.overrideQuantity ?? l.quantityWithWastage),
              unit: l.unit,
              wastagePercent: Number(l.wastagePercent),
              owner: l.suppliedBy === 'OWNER',
              ratePaisa: l.kind === 'PERCENT' ? null : (l.overrideRatePaisa ?? l.ratePaisa),
              amountPaisa: l.amountPaisa,
            })),
        })),
        directCostPaisa: e.directCostPaisa,
        overheadPaisa: e.overheadPaisa,
        contingencyPaisa: e.contingencyPaisa,
        totalPaisa: e.totalPaisa,
        perSqftPaisa: covered > 0 ? BigInt(new Prisma.Decimal(e.totalPaisa.toString()).div(covered).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)) : null,
      },
      lang,
    );
    const name = pdfFileName(`Estimate ${p.code} Rev ${e.revision}${fa.rates ? '' : ' qty'}`, lang);
    const attachmentId = await storePdf(tx, c.tenantId, c.userId, 'REPORT', name, html, `${tr(lang, 'pdf.estimate')} · ${p.name} · Rev ${e.revision}`, lang);
    return (await shareOf(tx, c.tenantId, attachmentId, (url) => tr(lang, 'share.estimate', { project: p.name, revision: e.revision, url })))!;
  });
}

export { markRatesOutdated } from './outdated.js';
