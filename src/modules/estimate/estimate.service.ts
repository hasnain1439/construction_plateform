/**
 * Estimate (BoQ) of a project — computed live on every read from the project's current plot,
 * structure, foundation, floors / rooms / openings, the rulebook (platform → company → project
 * layers, rulebook.ts) and the company price list. `GET /projects/:id/estimate` is the live
 * preview (grey-structure stages + the full `boq` that Generate would save); saved revisions live
 * in revisions.service.ts.
 *
 * Money visibility follows the field permissions: rates / amounts / cost need `fields.rates`,
 * the contract value `fields.contract`, the margin `fields.profit` + `fields.contract`.
 */
import { fieldAccess, type FieldAccess } from '../../core/auth/access.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Prisma } from '../../generated/prisma/client.js';
import { currentRates, defaultCategory } from '../master-data/master-data.repository.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { assertEditable, assertProjectScope, caller, findEditableProject, type Caller } from '../projects/access.js';
import { plotCalc } from '../projects/calc.js';
import { readFoundation } from '../projects/foundation.js';
import { readRoof } from '../projects/roof.js';
import { readWalls } from '../projects/walls.js';
import type { SupplyCategoryKey } from '../projects/presets.js';
import { contractTotalPaisa } from '../projects/projects.dto.js';
import * as repo from '../projects/projects.repository.js';
import { audit, detail } from '../projects/projects.service.js';
import { recomputeStageAmounts } from '../projects/wizard.service.js';
import { BOQ_LABOUR_ITEMS, BOQ_MATERIALS, BOQ_SECTIONS, BUILD_STAGES, buildBoq, type Boq, type BoqLabourItem, type BoqLabourRates, type BoqLine, type BoqMaterialKey, type BoqPriceBook } from './boq.js';
import { suggest } from './contractValue.js';
import {
  estimateQuantities,
  MATERIALS,
  priceEstimate,
  STAGES,
  type EstimateInput,
  type LabourItem,
  type MaterialKey,
  type PricedEstimate,
  type EstimateQuantities,
} from './engine.js';
import { assertProjectOverrides, loadRulebook, settingsBase, withProject, type ParamSource, type ResolvedRulebook } from './rulebook.js';
import { lineTexts, visibleParameters } from './rateRedaction.js';
import { PARAM_BY_KEY, fromSettingValue } from './rulebookDefs.js';
import { effectiveSettings, readOverrides, type EstimateSettings, type EstimateSettingsInput } from './settings.js';

/**
 * Which company material prices each estimate material: platform rulebook keys first, then a name
 * match. Steel by size (steel10 … steel20) is priced from "Steel Grade-60 #3 … #6" (or a company
 * "Grade-40 #n" material when a roof uses G40); without a rate for that size it falls back to the
 * generic steel rate (`fallbackTo`) and the material is flagged `rateFallback`.
 */
export const MATERIAL_SOURCES: Record<BoqMaterialKey, { rulebook: string[]; name?: RegExp; supply: SupplyCategoryKey | null; fallbackTo?: MaterialKey; bar?: number }> = {
  cement: { rulebook: ['cement_opc', 'cement_src'], supply: 'CEMENT' },
  bricks: { rulebook: ['bricks_class1', 'bricks_class2'], supply: 'BRICKS' },
  blocks: { rulebook: [], name: /\bblock/i, supply: 'BRICKS' },
  floorTiles: { rulebook: [], name: /floor\s*tile/i, supply: 'TILES_FLOORING' },
  wallTiles: { rulebook: [], name: /wall\s*tile/i, supply: 'TILES_FLOORING' },
  paint: { rulebook: [], name: /emulsion|wall\s*paint/i, supply: 'PAINT' },
  primer: { rulebook: [], name: /primer|sealer/i, supply: 'PAINT' },
  sand: { rulebook: ['sand_chenab', 'sand_ravi'], supply: 'SAND_BAJRI' },
  crush: { rulebook: ['bajri_margalla', 'bajri_sargodha'], supply: 'SAND_BAJRI' },
  steel: { rulebook: ['steel_g60_4', 'steel_g60_3', 'steel_g60_5', 'steel_g60_6'], supply: 'STEEL' },
  steel10: { rulebook: ['steel_g60_3'], supply: 'STEEL', fallbackTo: 'steel', bar: 3 },
  steel12: { rulebook: ['steel_g60_4'], supply: 'STEEL', fallbackTo: 'steel', bar: 4 },
  steel16: { rulebook: ['steel_g60_5'], supply: 'STEEL', fallbackTo: 'steel', bar: 5 },
  steel20: { rulebook: ['steel_g60_6'], supply: 'STEEL', fallbackTo: 'steel', bar: 6 },
  tIron: { rulebook: [], name: /t[-\s]?iron|garder|girder|\brsj\b|i[-\s]?beam/i, supply: 'STEEL' },
  roofTile: { rulebook: [], name: /roof\s*tile|clay\s*tile|khaprail|terracotta/i, supply: 'BRICKS' },
  precastPlank: { rulebook: [], name: /precast|hollow[-\s]?core|plank/i, supply: null },
  steelDeck: { rulebook: [], name: /deck/i, supply: 'STEEL' },
  waterproofing: { rulebook: [], name: /waterproof|compound/i, supply: 'WATERPROOFING' },
  bitumen: { rulebook: [], name: /bitumen/i, supply: 'WATERPROOFING' },
  termite: { rulebook: [], name: /termite|deemak|dimak/i, supply: null },
  stone: { rulebook: [], name: /stone/i, supply: 'BRICKS' },
};

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

function engineInput(p: repo.ProjectFull): EstimateInput {
  const plot = plotCalc({ plotUnit: p.plotUnit, plotSize: p.plotSize, marlaStandard: p.marlaStandard, frontFt: p.frontFt, depthFt: p.depthFt });
  const f = readFoundation(p.foundation);
  return {
    plotAreaSqft: plot.plotAreaSqft,
    frontFt: num(p.frontFt),
    depthFt: num(p.depthFt),
    structureType: p.structureType,
    coveredAreaSqft: num(p.coveredAreaSqft),
    floors: p.floors.map((fl) => ({
      level: fl.level,
      name: fl.name,
      ceilingHeightFt: Number(fl.ceilingHeightFt),
      roof: readRoof(fl.roof),
      rooms: fl.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        walls: readWalls(r.walls),
        lengthFt: Number(r.lengthFt),
        widthFt: Number(r.widthFt),
        heightFt: Number(r.heightFt),
        isWet: r.isWet,
        openings: r.openings.map((o) => ({ type: o.type, widthFt: Number(o.widthFt), heightFt: Number(o.heightFt), quantity: o.quantity, side: o.side })),
      })),
    })),
    foundation: f,
  };
}

/** The company price book for the estimate materials, in the project's quality category per supply category. */
export async function loadPriceBook(tx: Tx, tenantId: string, p: repo.ProjectFull): Promise<BoqPriceBook> {
  const materials = await tx.material.findMany({
    where: { isHidden: false },
    select: { id: true, name: true, unit: true, altUnits: true, platformMaterial: { select: { rulebookKey: true } } },
    orderBy: { name: 'asc' },
  });
  const fallback = await defaultCategory(tx);
  const rule = (key: SupplyCategoryKey | null) => (key ? p.supplyRules.find((r) => r.categoryKey === key) : undefined);
  const g40 = p.floors.some((f) => readRoof(f.roof)?.steelGrade === 'G40');

  // Candidates per estimate material, in priority order
  const candidates = Object.fromEntries(
    BOQ_MATERIALS.map((m) => {
      const src = MATERIAL_SOURCES[m];
      // A roof in Grade-40 steel: the company's own "Grade-40 #n" material first
      const grade40 = g40 && src.bar ? materials.filter((x) => /(grade|g)[\s-]*40/i.test(x.name) && new RegExp(`#\\s*${src.bar}\\b`).test(x.name)) : [];
      const byKey = src.rulebook.flatMap((k) => materials.filter((x) => x.platformMaterial?.rulebookKey === k && !grade40.includes(x)));
      const byName = src.name ? materials.filter((x) => src.name!.test(x.name) && !byKey.includes(x)) : [];
      return [m, [...grade40, ...byKey, ...byName]];
    }),
  ) as Record<BoqMaterialKey, typeof materials>;

  // Current rates, one query per quality category in use (sequential: one connection)
  const categoryOf = (m: BoqMaterialKey) => {
    const r = rule(MATERIAL_SOURCES[m].supply);
    return r?.qualityCategory ? { id: r.qualityCategory.id, name: r.qualityCategory.name } : fallback ? { id: fallback.id, name: fallback.name } : null;
  };
  const rates = new Map<string, Map<string, bigint>>();
  for (const m of BOQ_MATERIALS) {
    const cat = categoryOf(m);
    if (!cat || rates.has(cat.id)) continue;
    const ids = [...new Set(BOQ_MATERIALS.filter((x) => categoryOf(x)?.id === cat.id).flatMap((x) => candidates[x].map((c) => c.id)))];
    rates.set(cat.id, new Map((await currentRates(tx, tenantId, cat.id, ids)).map((r) => [r.materialId, r.ratePaisa])));
  }

  const book: BoqPriceBook = {};
  for (const m of BOQ_MATERIALS) {
    const cat = categoryOf(m);
    const catRates = cat ? rates.get(cat.id) : undefined;
    const list = candidates[m];
    const chosen = list.find((x) => catRates?.has(x.id)) ?? list[0];
    const r = rule(MATERIAL_SOURCES[m].supply);
    const generic = MATERIAL_SOURCES[m].fallbackTo ? book[MATERIAL_SOURCES[m].fallbackTo!] : undefined;
    if ((!chosen || !catRates?.has(chosen.id)) && generic && generic.ratePaisa !== null) {
      // No rate for this bar size → the generic steel rate, flagged
      book[m] = { ...generic, fallback: true };
      continue;
    }
    book[m] = {
      materialId: chosen?.id ?? null,
      materialName: chosen?.name ?? null,
      unit: chosen?.unit ?? null,
      altUnits: Array.isArray(chosen?.altUnits) ? (chosen.altUnits as Array<{ unit: string; factor: number }>) : [],
      ratePaisa: chosen ? (catRates?.get(chosen.id) ?? null) : null,
      qualityCategory: cat,
      suppliedBy: r?.suppliedBy ?? 'CONTRACTOR',
    };
  }
  return book;
}

export async function loadLabourRates(tx: Tx): Promise<BoqLabourRates> {
  const rows = await tx.laborRate.findMany({ where: { kind: 'SUBCONTRACT', isActive: true, key: { in: [...BOQ_LABOUR_ITEMS] } } });
  const pieceRates: BoqLabourRates['pieceRates'] = {};
  for (const r of rows) pieceRates[r.key as BoqLabourItem] = { unit: r.unit, ratePaisa: r.ratePaisa, label: r.label };
  return { pieceRates };
}

// ─── Response ───────────────────────────────────────────────────────────────

const str = (v: bigint | null) => (v === null ? null : v.toString());

export interface EstimateWarning {
  code: string;
  message: string;
  tab?: number;
  params?: Record<string, number>;
  materials?: MaterialKey[];
  items?: LabourItem[];
}

function toDto(ctx: EstimateContext, fa: FieldAccess, generatedAt: Date, margins: MarginDefaults, basis: BoqBasis) {
  const { p, overrides, settings, q, priced } = ctx;
  const rates = fa.rates;
  const warnings: EstimateWarning[] = [...q.warnings];
  if (rates && priced.missingRates.length) {
    warnings.push({
      code: 'RATES_MISSING',
      message: `No price-list rate for: ${priced.missingRates.map((m) => m.material).join(', ')} — these lines are left out of the cost`,
      materials: priced.missingRates.map((m) => m.material),
    });
  }
  const generic = priced.materials.filter((m) => m.rateFallback && m.rateStatus === 'OK').map((m) => m.material);
  if (rates && generic.length) {
    warnings.push({
      code: 'STEEL_RATE_GENERIC',
      message: `No price-list rate for these bar sizes: ${generic.join(', ')} — priced at the general steel rate`,
      materials: generic,
    });
  }
  if (rates && priced.missingLabourRates.length) {
    warnings.push({
      code: 'LABOUR_RATES_MISSING',
      message: `No sub-contract rate for: ${priced.missingLabourRates.join(', ')} — left out of the labour cost`,
      items: priced.missingLabourRates,
    });
  }
  const contract = contractTotalPaisa(p);
  if (fa.contract && contract === null) warnings.push({ code: 'CONTRACT_VALUE_MISSING', tab: 2, message: 'No contract value — the margin cannot be worked out' });
  if (fa.contract && contract !== null && p.contractType === 'FULL' && basis.finishingPaisa === 0n) {
    warnings.push({ code: 'CONTRACT_INCLUDES_FINISHING', message: 'Full contract: the contract value also covers finishing, which this estimate does not price' });
  }

  const money = <T extends object>(values: T) => (rates ? values : {});
  const lineDto = (l: PricedEstimate['lines'][number]) => ({
    id: l.id,
    stage: l.stage,
    floor: l.floor,
    element: l.element,
    kind: l.kind,
    measure: l.measure,
    material: l.material,
    netQuantity: l.netQuantity,
    wastagePercent: l.wastagePercent,
    quantity: l.quantity,
    unit: l.unit,
    formula: l.formula,
    formulaText: l.formulaText,
    method: l.method,
    suppliedBy: l.suppliedBy,
    ...money({ ratePaisa: str(l.ratePaisa), rateUnit: l.rateUnit, rateQuantity: l.rateQuantity, amountPaisa: str(l.amountPaisa), rateStatus: l.rateStatus }),
  });

  const c = priced.cost;
  return {
    projectId: p.id,
    projectCode: p.code,
    projectName: p.name,
    contractType: p.contractType,
    generatedAt: generatedAt.toISOString(),
    settings,
    defaults: ctx.base,
    customised: Object.keys(overrides).sort(),
    basis: q.basis,
    stages: STAGES.map((stage) => ({
      stage,
      lines: priced.lines.filter((l) => l.stage === stage).map(lineDto),
      totals: MATERIALS.filter((m) => q.stageTotals[stage][m] !== undefined).map((m) => ({ material: m, quantity: q.stageTotals[stage][m]! })),
      ...money({
        materialsPaisa: priced.stageCosts[stage].materialsPaisa.toString(),
        ownerSuppliedPaisa: priced.stageCosts[stage].ownerSuppliedPaisa.toString(),
        missingRates: priced.stageCosts[stage].missingRates,
      }),
    })),
    materials: priced.materials.map((m) => ({
      material: m.material,
      unit: m.unit,
      netQuantity: m.netQuantity,
      quantity: m.quantity,
      suppliedBy: m.suppliedBy,
      materialId: m.materialId,
      materialName: m.materialName,
      ...money({
        qualityCategory: m.qualityCategory,
        ratePaisa: str(m.ratePaisa),
        rateUnit: m.rateUnit,
        rateQuantity: m.rateQuantity,
        amountPaisa: str(m.amountPaisa),
        rateStatus: m.rateStatus,
        rateFallback: m.rateFallback,
      }),
    })),
    labour: {
      method: priced.labour.method,
      lines: priced.labour.lines.map((l) => ({
        item: l.item,
        quantity: l.quantity,
        unit: l.unit,
        ...money({ ratePaisa: str(l.ratePaisa), amountPaisa: str(l.amountPaisa), rateStatus: l.rateStatus }),
      })),
      ...money({ totalPaisa: priced.labour.totalPaisa.toString() }),
    },
    ...money({
      cost: {
        materialsPaisa: c.materialsPaisa.toString(),
        ownerSuppliedPaisa: c.ownerSuppliedPaisa.toString(),
        labourPaisa: c.labourPaisa.toString(),
        totalPaisa: c.totalPaisa.toString(),
        perSqftPaisa: str(c.perSqftPaisa),
        ...(fa.contract ? { contractTotalPaisa: str(c.contractTotalPaisa) } : {}),
        ...(fa.contract && fa.profit ? { marginPaisa: str(c.marginPaisa), marginPercent: c.marginPercent } : {}),
      },
    }),
    // The BoQ cost (QA-A-01): the one number the wizard, the BoQ page and the contract suggestion all use
    ...(rates ? { boqCost: boqCostDto(basis, contract, fa) } : {}),
    // Contract value from this estimate: needs the contract value (fields.contract) and the cost (fields.rates)
    ...(fa.contract && rates ? { contractSuggestion: contractSuggestion(p, basis, margins) } : {}),
    warnings,
  };
}

export type EstimateDto = ReturnType<typeof toDto>;

// ─── Contract value from the estimate ───────────────────────────────────────

export interface MarginDefaults {
  marginPercent: number;
  finishingAllowancePercent: number;
}

/** The company defaults (TenantSettings; 20 % / 0 % when the row does not exist yet). */
export async function marginDefaults(tx: Tx, tenantId: string): Promise<MarginDefaults> {
  const s = await tx.tenantSettings.findUnique({ where: { tenantId }, select: { defaultMarginPercent: true, defaultFinishingAllowancePercent: true } });
  return { marginPercent: s ? Number(s.defaultMarginPercent) : 20, finishingAllowancePercent: s ? Number(s.defaultFinishingAllowancePercent) : 0 };
}

type PricingProject = Pick<repo.ProjectFull, 'contractType' | 'contractValuePaisa' | 'ratePerSqftPaisa' | 'marginPercent' | 'finishingAllowancePercent'>;

/** Margin / finishing in effect: the sent value, else the project override, else the company default — with where it came from. */
export function effectiveMargins(p: PricingProject, company: MarginDefaults, sent: Partial<MarginDefaults> = {}) {
  const pick = (sentValue: number | undefined, project: Prisma.Decimal | null, def: number) =>
    sentValue !== undefined
      ? { value: sentValue, source: sentValue === def ? ('COMPANY' as const) : ('PROJECT' as const) }
      : project !== null
        ? { value: Number(project), source: 'PROJECT' as const }
        : { value: def, source: 'COMPANY' as const };
  return {
    margin: pick(sent.marginPercent, p.marginPercent, company.marginPercent),
    finishing: pick(sent.finishingAllowancePercent, p.finishingAllowancePercent, company.finishingAllowancePercent),
  };
}

/**
 * The BoQ cost the contract value is worked from (QA-A-01 / 02): the full Step 11 BoQ total for the
 * contractor's scope (direct + site overheads + contingency; owner-supplied lines are never in it)
 * — of a saved revision when the project has one (the one the BoQ page opens by default: the draft,
 * else the approved one, else the newest; or the one asked for), else of the live BoQ preview.
 */
export interface BoqBasis {
  source: 'REVISION' | 'LIVE';
  estimateId: string | null;
  revision: number | null;
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | null;
  directCostPaisa: bigint;
  overheadPaisa: bigint;
  contingencyPaisa: bigint;
  totalPaisa: bigint;
  /** Contractor-priced FINISHING-stage amount (0 = the BoQ prices no finishing). */
  finishingPaisa: bigint;
  coveredAreaSqft: number;
}

export async function boqBasis(tx: Tx, ctx: Pick<EstimateContext, 'p' | 'boq'>, estimateId?: string | null): Promise<BoqBasis> {
  const list = await tx.estimate.findMany({
    where: { projectId: ctx.p.id },
    select: { id: true, revision: true, status: true, directCostPaisa: true, overheadPaisa: true, contingencyPaisa: true, totalPaisa: true, coveredAreaSqft: true },
    orderBy: { revision: 'desc' },
  });
  const e =
    estimateId === null
      ? undefined // explicitly the live preview
      : estimateId
        ? list.find((x) => x.id === estimateId)
        : (list.find((x) => x.status === 'DRAFT') ?? list.find((x) => x.status === 'APPROVED') ?? list[0]);
  if (estimateId && !e) throw new NotFound('ESTIMATE_NOT_FOUND', 'Estimate revision not found for this project');
  if (e) {
    const fin = await tx.estimateLine.aggregate({
      where: { estimateId: e.id, stageKey: 'FINISHING', suppliedBy: 'CONTRACTOR', kind: { not: 'PERCENT' } },
      _sum: { amountPaisa: true },
    });
    return {
      source: 'REVISION',
      estimateId: e.id,
      revision: e.revision,
      status: e.status,
      directCostPaisa: e.directCostPaisa,
      overheadPaisa: e.overheadPaisa,
      contingencyPaisa: e.contingencyPaisa,
      totalPaisa: e.totalPaisa,
      finishingPaisa: fin._sum.amountPaisa ?? 0n,
      coveredAreaSqft: Number(e.coveredAreaSqft),
    };
  }
  const t = ctx.boq.totals;
  return {
    source: 'LIVE',
    estimateId: null,
    revision: null,
    status: null,
    directCostPaisa: t.directCostPaisa,
    overheadPaisa: t.overheadPaisa,
    contingencyPaisa: t.contingencyPaisa,
    totalPaisa: t.totalPaisa,
    finishingPaisa: t.stages.FINISHING,
    coveredAreaSqft: ctx.boq.coveredAreaSqft,
  };
}

function boqCostDto(b: BoqBasis, contract: bigint | null, fa: FieldAccess) {
  const margin = contract === null ? null : contract - b.totalPaisa;
  return {
    source: b.source,
    estimateId: b.estimateId,
    revision: b.revision,
    status: b.status,
    directCostPaisa: b.directCostPaisa.toString(),
    overheadPaisa: b.overheadPaisa.toString(),
    contingencyPaisa: b.contingencyPaisa.toString(),
    totalPaisa: b.totalPaisa.toString(),
    perSqftPaisa:
      b.coveredAreaSqft > 0 ? BigInt(new Prisma.Decimal(b.totalPaisa.toString()).div(b.coveredAreaSqft).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)).toString() : null,
    coveredAreaSqft: b.coveredAreaSqft,
    ...(fa.contract ? { contractTotalPaisa: str(contract) } : {}),
    ...(fa.contract && fa.profit
      ? { marginPaisa: str(margin), marginPercent: contract && contract > 0n && margin !== null ? Math.round((Number(margin) / Number(contract)) * 10000) / 100 : null }
      : {}),
  };
}

/**
 * The suggestion starts from the BoQ total (contractor scope). The BoQ already prices finishing
 * (tiles, paint, finishing labour), so for a FULL contract the finishing allowance applies only
 * when the BoQ prices no finishing at all (finishingPaisa = 0) — never on top of priced finishing.
 * Labour-only: the owner buys the material, so the BoQ total is the contractor's labour scope
 * (labour + lump sums + overheads + contingency), spread per sq ft.
 */
export function contractSuggestion(p: PricingProject, b: BoqBasis, company: MarginDefaults, sent: Partial<MarginDefaults> = {}) {
  if (!p.contractType) return null;
  const m = effectiveMargins(p, company, sent);
  const finishingApplies = p.contractType === 'FULL' && b.finishingPaisa === 0n;
  const s = suggest({
    contractType: p.contractType,
    costPaisa: b.totalPaisa,
    labourPaisa: b.totalPaisa,
    coveredAreaSqft: b.coveredAreaSqft > 0 ? b.coveredAreaSqft : null,
    marginPercent: m.margin.value,
    finishingAllowancePercent: finishingApplies ? m.finishing.value : 0,
  });
  const current = s.kind === 'RATE_PER_SQFT' ? p.ratePerSqftPaisa : p.contractValuePaisa;
  return {
    kind: s.kind,
    contractType: p.contractType,
    /** The BoQ total (contractor scope) the suggestion starts from. */
    basisPaisa: s.basisPaisa.toString(),
    basisSource: b.source,
    estimateId: b.estimateId,
    estimateRevision: b.revision,
    estimateStatus: b.status,
    coveredAreaSqft: b.coveredAreaSqft,
    marginPercent: m.margin.value,
    marginSource: m.margin.source,
    finishingAllowancePercent: finishingApplies ? m.finishing.value : 0,
    finishingSource: m.finishing.source,
    finishingApplies,
    companyMarginPercent: company.marginPercent,
    companyFinishingAllowancePercent: company.finishingAllowancePercent,
    suggestedPaisa: str(s.suggestedPaisa),
    currentPaisa: str(current),
  };
}

export type ContractSuggestion = NonNullable<ReturnType<typeof contractSuggestion>>;

export interface FromEstimateInput {
  marginPercent?: number;
  finishingAllowancePercent?: number;
  replace?: boolean;
  /** The saved revision to work from (the BoQ page sends the one on screen); null = the live BoQ preview; omitted = the default one. */
  estimateId?: string | null;
}

/**
 * Sets the contract value (labour-only: the rate per sq ft) from the live estimate. An existing
 * value is replaced only with `replace: true` (409 CONTRACT_VALUE_EXISTS otherwise). A margin /
 * finishing allowance that differs from the company default is stored on the project (it sticks
 * for the next suggestion); one equal to the default clears the override.
 */
export async function contractFromEstimate(projectId: string, input: FromEstimateInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await findEditableProject(tx, c, projectId);
    if (!project.contractType) throw new BadRequest('CONTRACT_MISSING', 'Choose the contract type (step 2) first');
    const p = await repo.loadFull(tx, projectId);
    const ctx = await computeEstimate(tx, c.tenantId, p);
    const basis = await boqBasis(tx, ctx, input.estimateId);
    const company = await marginDefaults(tx, c.tenantId);
    const s = contractSuggestion(p, basis, company, input)!;
    if (s.suggestedPaisa === null) {
      throw new BadRequest(
        'ESTIMATE_COST_MISSING',
        s.kind === 'RATE_PER_SQFT' ? 'The BoQ has no cost (or no covered area) to work a rate from' : 'The BoQ has no cost yet — add rooms and material rates first',
      );
    }
    if (s.currentPaisa !== null && !input.replace) {
      throw new Conflict('CONTRACT_VALUE_EXISTS', 'The project already has a contract value — send replace: true to overwrite it', {
        currentPaisa: s.currentPaisa,
        suggestedPaisa: s.suggestedPaisa,
      });
    }
    const value = BigInt(s.suggestedPaisa);
    const override = (sent: number | undefined, def: number, current: Prisma.Decimal | null) =>
      sent === undefined ? current : sent === def ? null : new Prisma.Decimal(sent);
    await tx.project.update({
      where: { id: projectId },
      data: {
        ...(s.kind === 'RATE_PER_SQFT' ? { ratePerSqftPaisa: value } : { contractValuePaisa: value }),
        marginPercent: override(input.marginPercent, company.marginPercent, p.marginPercent),
        finishingAllowancePercent: override(input.finishingAllowancePercent, company.finishingAllowancePercent, p.finishingAllowancePercent),
      },
    });
    await recomputeStageAmounts(tx, projectId);
    await audit(tx, c, 'project.contract_from_estimate', projectId, {
      code: project.code,
      contractType: project.contractType,
      kind: s.kind,
      costPaisa: s.basisPaisa,
      basisSource: s.basisSource,
      estimateId: s.estimateId,
      estimateRevision: s.estimateRevision,
      coveredAreaSqft: s.coveredAreaSqft,
      marginPercent: s.marginPercent,
      marginSource: s.marginSource,
      finishingAllowancePercent: s.finishingAllowancePercent,
      valuePaisa: s.suggestedPaisa,
      previousPaisa: s.currentPaisa,
    });
    return detail(tx, c, projectId);
  });
}

// ─── Computation (shared with the saved revisions) ──────────────────────────

/** Everything an estimate is computed from and what came out — the live preview and Generate use the same. */
export interface EstimateContext {
  p: repo.ProjectFull;
  rb: ResolvedRulebook;
  /** Project overrides (layer 3) as stored. */
  overrides: EstimateSettingsInput;
  /** Engine settings from the rulebook + company (the "defaults" of this project). */
  base: EstimateSettings;
  /** Engine settings in effect (base ⊕ project). */
  settings: EstimateSettings;
  /** Every rulebook value in effect, with its source. */
  params: Record<string, number>;
  sources: Record<string, { value: number; source: ParamSource }>;
  q: EstimateQuantities;
  prices: BoqPriceBook;
  labourRates: BoqLabourRates;
  priced: PricedEstimate;
  boq: Boq;
}

export async function computeEstimate(tx: Tx, tenantId: string, p: repo.ProjectFull): Promise<EstimateContext> {
  const rb = await loadRulebook(tx, tenantId);
  const overrides = readOverrides(p.estimateSettings);
  const base = settingsBase(rb.values);
  const settings = effectiveSettings(overrides, base);
  const { params, sources } = withProject(rb, overrides);
  const input = engineInput(p);
  const q = estimateQuantities(input, settings);
  const prices = await loadPriceBook(tx, tenantId, p);
  const labourRates = await loadLabourRates(tx);
  const contract = contractTotalPaisa(p);
  const priced = priceEstimate(q, prices, labourRates, { settings, contractTotalPaisa: contract });
  const boq = buildBoq({ input, quantities: q, settings, params, contractType: p.contractType, prices, labourRates, contractTotalPaisa: contract });
  return { p, rb, overrides, base, settings, params, sources, q, prices, labourRates, priced, boq };
}

/** The rates an estimate used (stored on a saved revision). */
export function ratesSnapshot(ctx: EstimateContext) {
  return {
    materials: BOQ_MATERIALS.filter((m) => ctx.prices[m]).map((m) => {
      const e = ctx.prices[m]!;
      return { material: m, materialId: e.materialId, name: e.materialName, unit: e.unit, ratePaisa: str(e.ratePaisa), category: e.qualityCategory?.name ?? null, suppliedBy: e.suppliedBy, fallback: Boolean(e.fallback) };
    }),
    labour: BOQ_LABOUR_ITEMS.filter((i) => ctx.labourRates.pieceRates[i]).map((i) => ({ item: i, unit: ctx.labourRates.pieceRates[i]!.unit, ratePaisa: ctx.labourRates.pieceRates[i]!.ratePaisa.toString() })),
  };
}

/** BoQ line → response (rates / amounts with fields.rates only). */
export function boqLineDto(l: BoqLine, fa: FieldAccess) {
  return {
    id: l.lineKey,
    lineKey: l.lineKey,
    section: l.section,
    stageKey: l.stageKey,
    kind: l.kind,
    description: l.description,
    material: l.material,
    materialId: l.materialId,
    unit: l.unit,
    quantity: l.quantity,
    wastagePercent: l.wastagePercent,
    quantityWithWastage: l.quantityWithWastage,
    suppliedBy: l.suppliedBy,
    ...lineTexts(l.formula, l.trace, fa.rates),
    override: null,
    effectiveQuantity: l.quantityWithWastage,
    ...(fa.rates
      ? { ratePaisa: str(l.ratePaisa), effectiveRatePaisa: str(l.ratePaisa), rateUnit: l.rateUnit, rateQuantity: l.rateQuantity, amountPaisa: str(l.amountPaisa), rateStatus: l.rateStatus }
      : {}),
  };
}

/** The live BoQ preview (what Generate would save). */
function boqDto(ctx: EstimateContext, fa: FieldAccess) {
  const { boq } = ctx;
  const t = boq.totals;
  return {
    rulebook: ctx.rb.rulebook ? { id: ctx.rb.rulebook.id, region: ctx.rb.region, version: ctx.rb.rulebook.version } : null,
    region: ctx.rb.region,
    coveredAreaSqft: boq.coveredAreaSqft,
    parameters: visibleParameters(ctx.sources, fa.rates),
    sections: BOQ_SECTIONS.map((section) => ({
      section,
      lines: boq.lines.filter((l) => l.section === section).map((l) => boqLineDto(l, fa)),
      ...(fa.rates ? { amountPaisa: t.sections[section].toString() } : {}),
    })).filter((s) => s.lines.length),
    stages: BUILD_STAGES.map((stageKey) => ({ stageKey, ...(fa.rates ? { amountPaisa: t.stages[stageKey].toString() } : {}) })),
    warnings: boq.warnings,
    ...(fa.rates
      ? {
          directCostPaisa: t.directCostPaisa.toString(),
          overheadPaisa: t.overheadPaisa.toString(),
          contingencyPaisa: t.contingencyPaisa.toString(),
          totalPaisa: t.totalPaisa.toString(),
          perSqftPaisa: str(t.perSqftPaisa),
          ...(fa.contract ? { contractTotalPaisa: str(t.contractTotalPaisa) } : {}),
          ...(fa.contract && fa.profit ? { marginPaisa: str(t.marginPaisa), marginPercent: t.marginPercent } : {}),
        }
      : {}),
  };
}

/** Builds the estimate inside a transaction (the project scope is checked by the caller). */
export async function buildEstimate(tx: Tx, c: Caller, projectId: string) {
  const p = await repo.loadFull(tx, projectId);
  const ctx = await computeEstimate(tx, c.tenantId, p);
  const fa = c.fields ?? fieldAccess(c);
  const dto = toDto(ctx, fa, new Date(), await marginDefaults(tx, c.tenantId), await boqBasis(tx, ctx));
  return { ...dto, boq: boqDto(ctx, fa) };
}

export async function getEstimate(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await assertProjectScope(tx, 'projects.estimate.view', projectId, c);
    return buildEstimate(tx, c, projectId);
  });
}

/**
 * Replaces the stored overrides (the PROJECT layer): fields sent are kept, fields left out go back
 * to the company's rulebook value, `{}` resets. Rulebook keys must be inside their safe range.
 */
export async function updateSettings(projectId: string, input: EstimateSettingsInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await assertProjectScope(tx, 'projects.estimate.manage', projectId, c);
    assertEditable(project);
    const rb = await loadRulebook(tx, c.tenantId);
    assertProjectOverrides(rb, input);
    const base = settingsBase(rb.values) as unknown as Record<string, unknown>;
    const before = readOverrides(project.estimateSettings);
    // Store only what differs from the company values, so a later rulebook change still reaches this project.
    const isDefault = (k: string, v: unknown) => {
      if (k in base) return v === base[k];
      const d = PARAM_BY_KEY.get(k);
      return d !== undefined && fromSettingValue(d, v) === rb.values[k];
    };
    const stored = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && !isDefault(k, v))) as EstimateSettingsInput;
    await tx.project.update({
      where: { id: projectId },
      data: { estimateSettings: Object.keys(stored).length ? (stored as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    const changed = [...new Set([...Object.keys(before), ...Object.keys(stored)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(stored[k]));
    await audit(tx, c, 'project.estimate_settings_update', projectId, {
      code: project.code,
      changed: changed.sort(),
      reset: Object.keys(stored).length === 0,
    } as Prisma.InputJsonValue);
    return buildEstimate(tx, c, projectId);
  });
}
