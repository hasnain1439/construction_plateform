/**
 * Company rulebook: the platform rulebook of the company's region resolved with the company's own
 * overrides (`CompanyRulebookOverride`, each inside the parameter's safe range).
 * Read: rulebook.override.view · change: rulebook.override.manage. Every write is audited.
 */
import { writeAudit } from '../../core/audit/audit.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, NotFound } from '../../core/errors/AppError.js';
import { Prisma } from '../../generated/prisma/client.js';
import { assertSafe, loadRulebook, type ResolvedRulebook } from '../estimate/rulebook.js';
import { PARAM_BY_KEY } from '../estimate/rulebookDefs.js';
import { caller, type Caller } from '../projects/access.js';
import type { SetOverridesInput } from './rulebook.schema.js';

export function rulebookDto(rb: ResolvedRulebook) {
  return {
    region: rb.region,
    rulebook: rb.rulebook ? { ...rb.rulebook, publishedAt: rb.rulebook.publishedAt?.toISOString() ?? null } : null,
    parameters: rb.params.map((p) => ({
      key: p.key,
      group: p.group,
      label: p.label,
      unit: p.unit,
      description: p.description,
      platformValue: p.platformValue,
      companyValue: p.companyValue,
      companyNote: p.companyNote,
      value: p.value,
      source: p.source,
      safeMin: p.safeMin,
      safeMax: p.safeMax,
      reviewStatus: p.reviewStatus,
      projectOverridable: p.projectOverridable,
    })),
  };
}

const audit = (tx: Tx, c: Caller, action: string, details: Prisma.InputJsonValue) =>
  writeAudit(tx, { tenantId: c.tenantId, actorType: 'USER', actorId: c.userId, action, entityType: 'CompanyRulebookOverride', details });

export async function getRulebook() {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => rulebookDto(await loadRulebook(tx, c.tenantId)));
}

export async function listOverrides() {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const rows = await tx.companyRulebookOverride.findMany({ include: { updatedBy: { select: { id: true, name: true } } }, orderBy: { parameterKey: 'asc' } });
    return rows.map((o) => ({ key: o.parameterKey, value: Number(o.value), note: o.note, updatedAt: o.updatedAt.toISOString(), updatedBy: o.updatedBy }));
  });
}

/** Upserts the sent overrides (others untouched). Unknown key → 400 UNKNOWN_PARAMETER; outside the safe range → 400 OUT_OF_SAFE_RANGE. */
export async function setOverrides(input: SetOverridesInput) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const rb = await loadRulebook(tx, c.tenantId);
    for (const o of input.overrides) {
      const p = rb.byKey.get(o.key);
      if (!p) throw new BadRequest('UNKNOWN_PARAMETER', `Unknown rulebook parameter: ${o.key}`, { key: o.key });
      assertSafe(o.key, o.value, p.safeMin, p.safeMax);
      if (PARAM_BY_KEY.get(o.key)?.kind === 'FLAG' && o.value !== 0 && o.value !== 1) throw new BadRequest('OUT_OF_SAFE_RANGE', `${o.key} must be 0 or 1`, { key: o.key, value: o.value, safeMin: 0, safeMax: 1 });
    }
    const changes = [];
    for (const o of input.overrides) {
      const p = rb.byKey.get(o.key)!;
      await tx.companyRulebookOverride.upsert({
        where: { tenantId_parameterKey: { tenantId: c.tenantId, parameterKey: o.key } },
        create: { tenantId: c.tenantId, parameterKey: o.key, value: new Prisma.Decimal(o.value), note: o.note ?? null, updatedById: c.userId },
        update: { value: new Prisma.Decimal(o.value), note: o.note ?? null, updatedById: c.userId },
      });
      changes.push({ key: o.key, value: o.value, previous: p.companyValue, platformValue: p.platformValue });
    }
    await audit(tx, c, 'rulebook.override_set', { region: rb.region, changes });
    return rulebookDto(await loadRulebook(tx, c.tenantId));
  });
}

export async function deleteOverride(key: string) {
  const c = caller();
  return withTenant(c.tenantId, async (tx) => {
    const row = await tx.companyRulebookOverride.findUnique({ where: { tenantId_parameterKey: { tenantId: c.tenantId, parameterKey: key } } });
    if (!row) throw new NotFound('OVERRIDE_NOT_FOUND', 'The company has no own value for this parameter');
    await tx.companyRulebookOverride.delete({ where: { id: row.id } });
    await audit(tx, c, 'rulebook.override_delete', { key, previous: Number(row.value) });
    return rulebookDto(await loadRulebook(tx, c.tenantId));
  });
}
