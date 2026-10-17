/**
 * Step 12 · Prices a quote: inputs → quick-mode geometry (quickMode.ts) → the Step 11 engine and
 * BoQ with the company rulebook, price list (the quote's quality category) and sub-contract rates
 * → cost, price, margin, payment stages, quantities and material specifications.
 *
 * Nothing is saved here; the service stores the result as a QuoteRevision (money as paisa strings
 * inside the JSON, BigInt columns for the totals).
 */
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest } from '../../core/errors/AppError.js';
import { BOQ_SECTIONS, buildBoq, type BoqLine } from '../estimate/boq.js';
import { estimateQuantities } from '../estimate/engine.js';
import { loadLabourRates, loadPriceBook, MATERIAL_SOURCES } from '../estimate/estimate.service.js';
import { loadRulebook, settingsBase } from '../estimate/rulebook.js';
import type { StageDef } from '../master-data/catalog.js';
import { plotCalc, stageAmounts } from '../projects/calc.js';
import { presetFor, SUPPLY_CATEGORIES, type SupplyCategoryKey } from '../projects/presets.js';
import type * as repo from '../projects/projects.repository.js';
import { QUICK_VALUES, quickGeometry, quotePrice, type QuickFloorBasis } from './quickMode.js';
import type { QuoteInputsInput } from './sales.schema.js';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Inputs as stored on a revision: every default filled in. */
export interface QuoteInputs {
  plot: { unit: 'MARLA' | 'KANAL' | 'SQFT'; size: number; frontFt: number | null; depthFt: number | null; marlaStandard: number };
  coveredAreaSqft: number;
  floors: number;
  mumty: boolean;
  basement: boolean;
  basementHeightFt: number;
  structureType: 'FRAMED' | 'LOAD_BEARING';
  contractType: 'FULL' | 'GREY_OWNER_FINISHING' | 'LABOR_ONLY';
  qualityCategoryId: string | null;
  supplyRules: Array<{ categoryKey: SupplyCategoryKey; suppliedBy: 'CONTRACTOR' | 'OWNER' }>;
  marginPercent: number;
  finishingAllowancePercent: number;
  paymentTemplateId: string | null;
  finalPricePaisa: string | null;
}

export interface PaymentStage {
  label: string;
  percent: number;
  isRetention: boolean;
  amountPaisa: string | null;
}

export interface Specification {
  categoryKey: SupplyCategoryKey;
  label: string;
  suppliedBy: 'CONTRACTOR' | 'OWNER';
  qualityCategory: { id: string; name: string } | null;
  materials: string[];
}

/** Stored as QuoteRevision.result (JSON). */
export interface QuoteResult {
  rulebook: { region: string; version: number | null };
  basis: {
    plotAreaSqft: number | null;
    coveredAreaSqft: number;
    storeyAreaSqft: number;
    floors: QuickFloorBasis[];
    foundation: 'ISOLATED' | 'STRIP';
    assumptions: Record<string, number>;
  };
  quantities: {
    cementBags: number;
    steelKg: number;
    bricks: number;
    blocks: number;
    sandCft: number;
    crushCft: number;
    plasterSqft: number;
    floorTilesSqft: number;
    wallTilesSqft: number;
    paintGallons: number;
  };
  sections: Array<{ section: string; amountPaisa: string }>;
  specifications: Specification[];
  /** `message` is English; `code` + `params` / `materials` / `items` let the app show it in the user's language (QA-A-10). */
  warnings: Array<{ code: string; message: string; params?: Record<string, number>; materials?: string[]; items?: string[] }>;
}

export interface QuoteComputation {
  inputs: QuoteInputs;
  result: QuoteResult;
  paymentStages: PaymentStage[];
  paymentTemplate: { id: string; name: string } | null;
  directCostPaisa: bigint;
  overheadPaisa: bigint;
  contingencyPaisa: bigint;
  costPaisa: bigint;
  finishingAllowancePaisa: bigint;
  computedPricePaisa: bigint | null;
  pricePaisa: bigint | null;
  perSqftPaisa: bigint | null;
  marginPaisa: bigint | null;
  marginOnPricePercent: number | null;
  priceOverridden: boolean;
  costPerSqftPaisa: bigint | null;
}

/** Company defaults a quote falls back on. */
export async function companyQuoteSettings(tx: Tx, tenantId: string) {
  const s = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { marlaStandardSqft: true, defaultMarginPercent: true, defaultFinishingAllowancePercent: true, quoteValidityDays: true },
  });
  return {
    marlaStandard: s ? Number(s.marlaStandardSqft) : 225,
    marginPercent: s ? Number(s.defaultMarginPercent) : 20,
    finishingAllowancePercent: s ? Number(s.defaultFinishingAllowancePercent) : 0,
    quoteValidityDays: s?.quoteValidityDays ?? 15,
  };
}

/** Supply split: the contract-type preset with the quote's overrides on top. */
export function supplySplit(contractType: QuoteInputs['contractType'], overrides: QuoteInputs['supplyRules']) {
  const map = new Map(presetFor(contractType).map((r) => [r.categoryKey, r.suppliedBy as 'CONTRACTOR' | 'OWNER']));
  for (const o of overrides) map.set(o.categoryKey, o.suppliedBy);
  return SUPPLY_CATEGORIES.map((c) => ({ categoryKey: c.key as SupplyCategoryKey, label: c.label, suppliedBy: map.get(c.key)! }));
}

const lineQty = (lines: BoqLine[], pred: (l: BoqLine) => boolean) => r2(sum(lines.filter((l) => l.kind === 'MATERIAL' && pred(l)).map((l) => l.quantityWithWastage)));

export async function computeQuote(tx: Tx, tenantId: string, raw: QuoteInputsInput): Promise<QuoteComputation> {
  const company = await companyQuoteSettings(tx, tenantId);

  // Quality category (contractor-supplied material) and payment template
  let category: { id: string; name: string } | null = null;
  if (raw.qualityCategoryId) {
    category = await tx.qualityCategory.findFirst({ where: { id: raw.qualityCategoryId, isArchived: false }, select: { id: true, name: true } });
    if (!category) throw new BadRequest('INVALID_QUALITY_CATEGORY', 'Quality category not found (or archived)', { qualityCategoryIds: [raw.qualityCategoryId] });
  } else {
    category = await tx.qualityCategory.findFirst({ where: { isDefault: true, isArchived: false }, select: { id: true, name: true } });
  }
  const template = raw.paymentTemplateId
    ? await tx.paymentScheduleTemplate.findFirst({ where: { id: raw.paymentTemplateId } })
    : await tx.paymentScheduleTemplate.findFirst({ where: { isDefault: true } });
  if (raw.paymentTemplateId && !template) throw new BadRequest('INVALID_TEMPLATE', 'Payment template not found');
  const stageDefs: StageDef[] = template ? (template.stages as unknown as StageDef[]) : [{ label: 'Full payment', percent: 100 }];

  const inputs: QuoteInputs = {
    plot: { unit: raw.plot.unit, size: raw.plot.size, frontFt: raw.plot.frontFt ?? null, depthFt: raw.plot.depthFt ?? null, marlaStandard: raw.plot.marlaStandard ?? company.marlaStandard },
    coveredAreaSqft: raw.coveredAreaSqft,
    floors: raw.floors,
    mumty: raw.mumty ?? true,
    basement: raw.basement ?? false,
    basementHeightFt: raw.basementHeightFt ?? 10,
    structureType: raw.structureType,
    contractType: raw.contractType,
    qualityCategoryId: category?.id ?? null,
    supplyRules: raw.supplyRules ?? [],
    marginPercent: raw.marginPercent ?? company.marginPercent,
    finishingAllowancePercent: raw.contractType === 'FULL' ? (raw.finishingAllowancePercent ?? company.finishingAllowancePercent) : 0,
    paymentTemplateId: template?.id ?? null,
    finalPricePaisa: raw.finalPricePaisa === undefined || raw.finalPricePaisa === null ? null : raw.finalPricePaisa.toString(),
  };

  // Geometry → engine → BoQ (the Step 11 code path)
  const plot = plotCalc({ plotUnit: inputs.plot.unit, plotSize: inputs.plot.size, marlaStandard: inputs.plot.marlaStandard, frontFt: inputs.plot.frontFt, depthFt: inputs.plot.depthFt });
  const geo = quickGeometry({
    plotAreaSqft: plot.plotAreaSqft,
    frontFt: inputs.plot.frontFt,
    depthFt: inputs.plot.depthFt,
    coveredAreaSqft: inputs.coveredAreaSqft,
    floors: inputs.floors,
    mumty: inputs.mumty,
    basement: inputs.basement,
    basementHeightFt: inputs.basementHeightFt,
    structureType: inputs.structureType,
  });
  const rb = await loadRulebook(tx, tenantId);
  const settings = settingsBase(rb.values);
  const split = supplySplit(inputs.contractType, inputs.supplyRules);
  // The price book reads the supply rules and roofs of a project — a stand-in with the quote's split.
  const standIn = {
    supplyRules: split.map((r) => ({ categoryKey: r.categoryKey, suppliedBy: r.suppliedBy, qualityCategory: r.suppliedBy === 'CONTRACTOR' ? category : null })),
    floors: [],
  } as unknown as repo.ProjectFull;
  const prices = await loadPriceBook(tx, tenantId, standIn);
  const labourRates = await loadLabourRates(tx);
  const q = estimateQuantities(geo.input, settings);
  const boq = buildBoq({ input: geo.input, quantities: q, settings, params: rb.values, contractType: inputs.contractType, prices, labourRates, contractTotalPaisa: null });
  const t = boq.totals;

  const price = quotePrice({
    contractType: inputs.contractType,
    costPaisa: t.totalPaisa,
    coveredAreaSqft: inputs.coveredAreaSqft,
    marginPercent: inputs.marginPercent,
    finishingAllowancePercent: inputs.finishingAllowancePercent,
    finalPricePaisa: inputs.finalPricePaisa === null ? null : BigInt(inputs.finalPricePaisa),
  });
  const amounts = price.pricePaisa === null ? null : stageAmounts(price.pricePaisa, stageDefs.map((s) => s.percent));
  const paymentStages = stageDefs.map((s, i) => ({ label: s.label, percent: s.percent, isRetention: Boolean(s.isRetention), amountPaisa: amounts ? amounts[i]!.toString() : null }));

  // What the client gets (no rates): per supply category, who supplies it, the quality, the materials
  const used = new Set(boq.lines.filter((l) => l.kind === 'MATERIAL' && l.material).map((l) => l.material!));
  const specifications: Specification[] = split.map((r) => {
    const names = Object.entries(MATERIAL_SOURCES)
      .filter(([m, src]) => src.supply === r.categoryKey && used.has(m))
      .map(([m]) => prices[m as keyof typeof prices]?.materialName)
      .filter((n): n is string => Boolean(n));
    return { categoryKey: r.categoryKey, label: r.label, suppliedBy: r.suppliedBy, qualityCategory: r.suppliedBy === 'CONTRACTOR' ? category : null, materials: [...new Set(names)] };
  });

  const lines = boq.lines;
  const result: QuoteResult = {
    rulebook: { region: rb.region, version: rb.rulebook?.version ?? null },
    basis: {
      plotAreaSqft: plot.plotAreaSqft,
      coveredAreaSqft: inputs.coveredAreaSqft,
      storeyAreaSqft: geo.storeyAreaSqft,
      floors: geo.floors,
      foundation: geo.foundation,
      assumptions: { ...QUICK_VALUES },
    },
    quantities: {
      cementBags: lineQty(lines, (l) => l.material === 'cement'),
      steelKg: lineQty(lines, (l) => l.material === 'steel' || /^steel\d+$/.test(l.material ?? '')),
      bricks: lineQty(lines, (l) => l.material === 'bricks'),
      blocks: lineQty(lines, (l) => l.material === 'blocks'),
      sandCft: lineQty(lines, (l) => l.material === 'sand'),
      crushCft: lineQty(lines, (l) => l.material === 'crush'),
      plasterSqft: q.work.plasterSqft,
      floorTilesSqft: lineQty(lines, (l) => l.material === 'floorTiles'),
      wallTilesSqft: lineQty(lines, (l) => l.material === 'wallTiles'),
      paintGallons: lineQty(lines, (l) => l.material === 'paint'),
    },
    sections: BOQ_SECTIONS.filter((s) => lines.some((l) => l.section === s)).map((s) => ({ section: s, amountPaisa: t.sections[s].toString() })),
    specifications,
    // Engine warnings about missing rooms / foundation don't apply to a quick estimate. The steel / RCC
    // norm checks compare detailed structure inputs with the rulebook; the quick mode has no such
    // inputs (it uses the rule-of-thumb itself), so it would only flag its own defaults (QA-A-22).
    warnings: [...q.warnings.filter((w) => !['NO_ROOMS', 'FOUNDATION_MISSING', 'STRUCTURE_TYPE_ASSUMED', 'COVERED_AREA_ESTIMATED'].includes(w.code)), ...boq.warnings.filter((w) => w.code !== 'STEEL_NORM_DEVIATION' && w.code !== 'RCC_NORM_DEVIATION')].map((w) => ({
      code: w.code,
      message: w.message,
      ...('params' in w && w.params ? { params: w.params } : {}),
      ...('materials' in w && w.materials ? { materials: w.materials as string[] } : {}),
      ...('items' in w && w.items ? { items: w.items as string[] } : {}),
    })),
  };

  return {
    inputs,
    result,
    paymentStages,
    paymentTemplate: template ? { id: template.id, name: template.name } : null,
    directCostPaisa: t.directCostPaisa,
    overheadPaisa: t.overheadPaisa,
    contingencyPaisa: t.contingencyPaisa,
    costPaisa: t.totalPaisa,
    finishingAllowancePaisa: price.finishingAllowancePaisa,
    computedPricePaisa: price.computedPricePaisa,
    pricePaisa: price.pricePaisa,
    perSqftPaisa: price.perSqftPaisa,
    marginPaisa: price.marginPaisa,
    marginOnPricePercent: price.marginOnPricePercent,
    priceOverridden: price.priceOverridden,
    costPerSqftPaisa: t.perSqftPaisa,
  };
}

