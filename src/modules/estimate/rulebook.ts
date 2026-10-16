/**
 * Rulebook resolution — the three layers every estimate number goes through:
 *
 *   1. RULEBOOK  the highest PUBLISHED platform rulebook version of the company's region
 *                (`Tenant.region`, chosen at sign-up; built-in v1 values from rulebookDefs.ts
 *                when the region has none published)
 *   2. COMPANY   CompanyRulebookOverride (within the parameter's safe range)
 *   3. PROJECT   Project.estimateSettings (same keys; legacy mixes "1:6" are read as 6)
 *
 * Only keys the code defines (rulebookDefs.ts) are used; a DB parameter without a code key is ignored.
 */
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest } from '../../core/errors/AppError.js';
import { fromSettingValue, PARAM_BY_KEY, projectOverridable, RULEBOOK_PARAMS, toSettingValue, type RulebookGroup, type RulebookRegion } from './rulebookDefs.js';
import { ESTIMATE_DEFAULTS, isSettingKey, type EstimateSettings, type EstimateSettingsInput } from './settings.js';

export type ParamSource = 'RULEBOOK' | 'COMPANY' | 'PROJECT';

export interface ResolvedParam {
  key: string;
  group: RulebookGroup;
  label: { en: string; roman: string; ur: string };
  description: string | null;
  unit: string;
  platformValue: number;
  companyValue: number | null;
  companyNote: string | null;
  /** Rulebook ⊕ company. */
  value: number;
  source: 'RULEBOOK' | 'COMPANY';
  safeMin: number;
  safeMax: number;
  reviewStatus: 'PENDING_ENGINEER_REVIEW' | 'REVIEWED';
  projectOverridable: boolean;
}

export interface ResolvedRulebook {
  region: RulebookRegion;
  rulebook: { id: string; version: number; status: 'DRAFT' | 'PUBLISHED'; publishedAt: Date | null; notes: string | null } | null;
  params: ResolvedParam[];
  byKey: Map<string, ResolvedParam>;
  /** Rulebook ⊕ company, every key. */
  values: Record<string, number>;
}

/** The company's resolved rulebook (layers 1 + 2). */
export async function loadRulebook(tx: Tx, tenantId: string): Promise<ResolvedRulebook> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { region: true } });
  const region: RulebookRegion = tenant?.region ?? 'PUNJAB_KP';
  const rb = await tx.rulebook.findFirst({ where: { region, status: 'PUBLISHED' }, orderBy: { version: 'desc' }, include: { parameters: true } });
  const overrides = await tx.companyRulebookOverride.findMany({ where: { tenantId } });
  const db = new Map((rb?.parameters ?? []).map((p) => [p.key, p]));
  const own = new Map(overrides.map((o) => [o.parameterKey, o]));
  const params: ResolvedParam[] = RULEBOOK_PARAMS.map((d) => {
    const p = db.get(d.key);
    const o = own.get(d.key);
    const platformValue = p ? Number(p.value) : d.value[region];
    const companyValue = o ? Number(o.value) : null;
    return {
      key: d.key,
      group: d.group,
      label: p ? { en: p.label, roman: p.labelRoman, ur: p.labelUrdu } : d.label,
      description: p ? p.description : d.description,
      unit: p?.unit ?? d.unit,
      platformValue,
      companyValue,
      companyNote: o?.note ?? null,
      value: companyValue ?? platformValue,
      source: companyValue === null ? 'RULEBOOK' : 'COMPANY',
      safeMin: p ? Number(p.safeMin) : d.safeMin,
      safeMax: p ? Number(p.safeMax) : d.safeMax,
      reviewStatus: p?.reviewStatus ?? 'PENDING_ENGINEER_REVIEW',
      projectOverridable: projectOverridable(d),
    };
  });
  return {
    region,
    rulebook: rb ? { id: rb.id, version: rb.version, status: rb.status, publishedAt: rb.publishedAt, notes: rb.notes } : null,
    params,
    byKey: new Map(params.map((p) => [p.key, p])),
    values: Object.fromEntries(params.map((p) => [p.key, p.value])),
  };
}

/** Engine settings from rulebook values (non-rulebook settings — labour, foundation length — keep their defaults). */
export function settingsBase(values: Record<string, number>): EstimateSettings {
  const out = { ...ESTIMATE_DEFAULTS } as Record<string, unknown>;
  for (const d of RULEBOOK_PARAMS) {
    if (d.scope !== 'SETTING' || !isSettingKey(d.key) || values[d.key] === undefined) continue;
    out[d.key] = toSettingValue(d, values[d.key]!);
  }
  return out as EstimateSettings;
}

/** Layer 3: every value with its source, after the project's own overrides. */
export function withProject(rb: ResolvedRulebook, overrides: EstimateSettingsInput): { params: Record<string, number>; sources: Record<string, { value: number; source: ParamSource }> } {
  const params = { ...rb.values };
  const sources: Record<string, { value: number; source: ParamSource }> = Object.fromEntries(rb.params.map((p) => [p.key, { value: p.value, source: p.source }]));
  for (const [k, v] of Object.entries(overrides)) {
    const d = PARAM_BY_KEY.get(k);
    if (!d || v === undefined || v === null) continue;
    const n = fromSettingValue(d, v);
    if (n === null) continue;
    params[k] = n;
    sources[k] = { value: n, source: 'PROJECT' };
  }
  // Phase 1 meaning of a project `wastagePercent`: every material except bricks
  if (typeof overrides.wastagePercent === 'number') {
    for (const k of ['cementWastagePercent', 'sandWastagePercent', 'steelWastagePercent']) {
      if (overrides[k] === undefined) {
        params[k] = overrides.wastagePercent;
        sources[k] = { value: overrides.wastagePercent, source: 'PROJECT' };
      }
    }
  }
  return { params, sources };
}

/** 400 OUT_OF_SAFE_RANGE unless min ≤ value ≤ max. */
export function assertSafe(key: string, value: number, safeMin: number, safeMax: number) {
  if (!(value >= safeMin && value <= safeMax)) {
    throw new BadRequest('OUT_OF_SAFE_RANGE', `${key} must be between ${safeMin} and ${safeMax}`, { key, value, safeMin, safeMax });
  }
}

/** Project overrides: every rulebook key sent must be project-overridable and inside the safe range. */
export function assertProjectOverrides(rb: ResolvedRulebook, input: EstimateSettingsInput) {
  for (const [k, v] of Object.entries(input)) {
    const p = rb.byKey.get(k);
    const d = PARAM_BY_KEY.get(k);
    if (!p || !d || v === undefined || v === null) continue;
    const n = fromSettingValue(d, v);
    if (n === null) continue;
    if (!p.projectOverridable) throw new BadRequest('UNKNOWN_PARAMETER', `${k} cannot be set per project`, { key: k });
    assertSafe(k, n, p.safeMin, p.safeMax);
  }
}
