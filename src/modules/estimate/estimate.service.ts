/**
 * Estimate (BoQ) of a project — computed live on every read from the project's current plot,
 * structure, foundation, floors / rooms / openings, the estimate settings and the company price
 * list. Nothing is stored except the settings the user changed (`Project.estimateSettings`).
 *
 * Money visibility follows the field permissions: rates / amounts / cost need `fields.rates`,
 * the contract value `fields.contract`, the margin `fields.profit` + `fields.contract`.
 */
import { fieldAccess, type FieldAccess } from '../../core/auth/access.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Prisma } from '../../generated/prisma/client.js';
import { currentRates, defaultCategory } from '../master-data/master-data.repository.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
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
import { suggest } from './contractValue.js';
import {
  estimateQuantities,
  LABOUR_ITEMS,
  MATERIALS,
  priceEstimate,
  STAGES,
  type EstimateInput,
  type LabourItem,
  type LabourRates,
  type MaterialKey,
  type PriceBook,
  type PricedEstimate,
  type EstimateQuantities,
} from './engine.js';
import { effectiveSettings, ESTIMATE_DEFAULTS, readOverrides, type EstimateSettings, type EstimateSettingsInput } from './settings.js';

/**
 * Which company material prices each estimate material: platform rulebook keys first, then a name
 * match. Steel by size (steel10 … steel20) is priced from "Steel Grade-60 #3 … #6" (or a company
 * "Grade-40 #n" material when a roof uses G40); without a rate for that size it falls back to the
 * generic steel rate (`fallbackTo`) and the material is flagged `rateFallback`.
 */
export const MATERIAL_SOURCES: Record<MaterialKey, { rulebook: string[]; name?: RegExp; supply: SupplyCategoryKey | null; fallbackTo?: MaterialKey; bar?: number }> = {
  cement: { rulebook: ['cement_opc', 'cement_src'], supply: 'CEMENT' },
  bricks: { rulebook: ['bricks_class1', 'bricks_class2'], supply: 'BRICKS' },
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
async function loadPriceBook(tx: Tx, tenantId: string, p: repo.ProjectFull): Promise<PriceBook> {
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
    MATERIALS.map((m) => {
      const src = MATERIAL_SOURCES[m];
      // A roof in Grade-40 steel: the company's own "Grade-40 #n" material first
      const grade40 = g40 && src.bar ? materials.filter((x) => /(grade|g)[\s-]*40/i.test(x.name) && new RegExp(`#\\s*${src.bar}\\b`).test(x.name)) : [];
      const byKey = src.rulebook.flatMap((k) => materials.filter((x) => x.platformMaterial?.rulebookKey === k && !grade40.includes(x)));
      const byName = src.name ? materials.filter((x) => src.name!.test(x.name) && !byKey.includes(x)) : [];
      return [m, [...grade40, ...byKey, ...byName]];
    }),
  ) as Record<MaterialKey, typeof materials>;

  // Current rates, one query per quality category in use (sequential: one connection)
  const categoryOf = (m: MaterialKey) => {
    const r = rule(MATERIAL_SOURCES[m].supply);
    return r?.qualityCategory ? { id: r.qualityCategory.id, name: r.qualityCategory.name } : fallback ? { id: fallback.id, name: fallback.name } : null;
  };
  const rates = new Map<string, Map<string, bigint>>();
  for (const m of MATERIALS) {
    const cat = categoryOf(m);
    if (!cat || rates.has(cat.id)) continue;
    const ids = [...new Set(MATERIALS.filter((x) => categoryOf(x)?.id === cat.id).flatMap((x) => candidates[x].map((c) => c.id)))];
    rates.set(cat.id, new Map((await currentRates(tx, tenantId, cat.id, ids)).map((r) => [r.materialId, r.ratePaisa])));
  }

  const book: PriceBook = {};
  for (const m of MATERIALS) {
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

async function loadLabourRates(tx: Tx): Promise<LabourRates> {
  const rows = await tx.laborRate.findMany({ where: { kind: 'SUBCONTRACT', isActive: true, key: { in: [...LABOUR_ITEMS] } } });
  const pieceRates: LabourRates['pieceRates'] = {};
  for (const r of rows) pieceRates[r.key as LabourItem] = { unit: r.unit, ratePaisa: r.ratePaisa, label: r.label };
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

function toDto(
  p: repo.ProjectFull,
  overrides: EstimateSettingsInput,
  settings: EstimateSettings,
  q: EstimateQuantities,
  priced: PricedEstimate,
  fa: FieldAccess,
  generatedAt: Date,
  margins: MarginDefaults,
) {
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
  if (fa.contract && contract !== null && p.contractType === 'FULL') {
    warnings.push({ code: 'CONTRACT_INCLUDES_FINISHING', message: 'Full contract: the contract value also covers finishing, which this grey-structure estimate does not' });
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
    defaults: ESTIMATE_DEFAULTS,
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
    // Contract value from this estimate: needs the contract value (fields.contract) and the cost (fields.rates)
    ...(fa.contract && rates ? { contractSuggestion: contractSuggestion(p, q.basis.coveredAreaSqft, c, margins) } : {}),
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

function contractSuggestion(p: PricingProject, coveredAreaSqft: number, cost: PricedEstimate['cost'], company: MarginDefaults, sent: Partial<MarginDefaults> = {}) {
  if (!p.contractType) return null;
  const m = effectiveMargins(p, company, sent);
  const s = suggest({
    contractType: p.contractType,
    costPaisa: cost.totalPaisa,
    labourPaisa: cost.labourPaisa,
    coveredAreaSqft: coveredAreaSqft > 0 ? coveredAreaSqft : null,
    marginPercent: m.margin.value,
    finishingAllowancePercent: m.finishing.value,
  });
  const current = s.kind === 'RATE_PER_SQFT' ? p.ratePerSqftPaisa : p.contractValuePaisa;
  return {
    kind: s.kind,
    contractType: p.contractType,
    /** Estimated cost (labour-only: the estimated labour) the suggestion starts from. */
    basisPaisa: s.basisPaisa.toString(),
    coveredAreaSqft,
    marginPercent: m.margin.value,
    marginSource: m.margin.source,
    finishingAllowancePercent: s.finishingApplies ? m.finishing.value : 0,
    finishingSource: m.finishing.source,
    finishingApplies: s.finishingApplies,
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
    const settings = effectiveSettings(readOverrides(p.estimateSettings));
    const q = estimateQuantities(engineInput(p), settings);
    const prices = await loadPriceBook(tx, c.tenantId, p);
    const labourRates = await loadLabourRates(tx);
    const priced = priceEstimate(q, prices, labourRates, { settings, contractTotalPaisa: contractTotalPaisa(p) });
    const company = await marginDefaults(tx, c.tenantId);
    const s = contractSuggestion(p, q.basis.coveredAreaSqft, priced.cost, company, input)!;
    if (s.suggestedPaisa === null) {
      throw new BadRequest(
        'ESTIMATE_COST_MISSING',
        s.kind === 'RATE_PER_SQFT' ? 'The estimate has no labour cost (or no covered area) to work a rate from' : 'The estimate has no cost yet — add rooms and material rates first',
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

/** Builds the estimate inside a transaction (the project scope is checked by the caller). */
export async function buildEstimate(tx: Tx, c: Caller, projectId: string): Promise<EstimateDto> {
  const p = await repo.loadFull(tx, projectId);
  const overrides = readOverrides(p.estimateSettings);
  const settings = effectiveSettings(overrides);
  const q = estimateQuantities(engineInput(p), settings);
  const prices = await loadPriceBook(tx, c.tenantId, p);
  const labourRates = await loadLabourRates(tx);
  const priced = priceEstimate(q, prices, labourRates, { settings, contractTotalPaisa: contractTotalPaisa(p) });
  return toDto(p, overrides, settings, q, priced, c.fields ?? fieldAccess(c), new Date(), await marginDefaults(tx, c.tenantId));
}

export async function getEstimate(projectId: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    await assertProjectScope(tx, 'projects.estimate.view', projectId, c);
    return buildEstimate(tx, c, projectId);
  });
}

/** Replaces the stored overrides: fields sent are kept, fields left out go back to the default, `{}` resets. */
export async function updateSettings(projectId: string, input: EstimateSettingsInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await assertProjectScope(tx, 'projects.estimate.manage', projectId, c);
    assertEditable(project);
    const before = readOverrides(project.estimateSettings);
    // Store only what differs from the defaults, so a later default change still reaches this project.
    const stored = Object.fromEntries(
      Object.entries(input).filter(([k, v]) => v !== undefined && v !== ESTIMATE_DEFAULTS[k as keyof EstimateSettings]),
    ) as EstimateSettingsInput;
    await tx.project.update({
      where: { id: projectId },
      data: { estimateSettings: Object.keys(stored).length ? (stored as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    const changed = [...new Set([...Object.keys(before), ...Object.keys(stored)])].filter(
      (k) => JSON.stringify(before[k as keyof EstimateSettingsInput]) !== JSON.stringify(stored[k as keyof EstimateSettingsInput]),
    );
    await audit(tx, c, 'project.estimate_settings_update', projectId, {
      code: project.code,
      changed: changed.sort(),
      reset: Object.keys(stored).length === 0,
    } as Prisma.InputJsonValue);
    return buildEstimate(tx, c, projectId);
  });
}
