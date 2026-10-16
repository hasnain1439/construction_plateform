/**
 * Step 18 — tax settings (company) and the tax override of a project. Every change is audited
 * and recalculates DRAFT invoices; issued invoices keep their snapshot.
 */
import { assertPerm } from '../../core/auth/access.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest } from '../../core/errors/AppError.js';
import { actor, audit, billingProject } from '../billing/billing.shared.js';
import { recalcDrafts } from '../billing/invoices.service.js';
import type { ProjectTaxInput, TaxSettingsInput } from './tax.schema.js';
import { ADVISER_NOTE, AUTHORITY_INFO, companyTax, resolveTax, TAX_AUTHORITIES, type CompanyTax } from './tax.rules.js';

function settingsDto(c: CompanyTax) {
  return {
    enabled: c.enabled,
    authority: c.authority,
    ratePercent: Number(c.ratePercent),
    label: c.label,
    effectiveLabel: c.label ?? (c.authority ? AUTHORITY_INFO[c.authority].defaultLabel : null),
    ntn: c.ntn,
    strn: c.strn,
    whtDefaultRatePercent: Number(c.whtDefaultRatePercent),
    authorities: TAX_AUTHORITIES.map((code) => ({ code, ...AUTHORITY_INFO[code] })),
    adviserNote: ADVISER_NOTE,
  };
}

export async function getSettings() {
  const a = actor();
  assertPerm('tax.view', a);
  return withTenant(a.tenantId, async (tx) => settingsDto(await companyTax(tx, a.tenantId)));
}

const snapshotOf = (c: CompanyTax) => ({
  enabled: c.enabled,
  authority: c.authority,
  ratePercent: Number(c.ratePercent),
  label: c.label,
  ntn: c.ntn,
  strn: c.strn,
  whtDefaultRatePercent: Number(c.whtDefaultRatePercent),
});

export async function updateSettings(input: TaxSettingsInput) {
  const a = actor();
  assertPerm('tax.settings.manage', a);
  return withTenant(a.tenantId, async (tx) => {
    const before = await companyTax(tx, a.tenantId);
    const enabled = input.enabled ?? before.enabled;
    const authority = input.authority !== undefined ? input.authority : before.authority;
    const ratePercent = input.ratePercent !== undefined ? new Prisma.Decimal(input.ratePercent) : before.ratePercent;
    if (enabled) {
      const missing = [...(!authority ? ['authority'] : []), ...(ratePercent.lte(0) ? ['ratePercent'] : [])];
      if (missing.length) throw new BadRequest('TAX_SETTINGS_INCOMPLETE', 'Choose the tax authority and rate before switching tax on', { missing });
    }
    const data: Prisma.TenantSettingsUncheckedUpdateInput = {
      ...(input.enabled !== undefined ? { taxEnabled: input.enabled } : {}),
      ...(input.authority !== undefined ? { taxAuthority: input.authority } : {}),
      ...(input.ratePercent !== undefined ? { taxRatePercent: input.ratePercent } : {}),
      ...(input.label !== undefined ? { taxLabel: input.label } : {}),
      ...(input.strn !== undefined ? { taxStrn: input.strn } : {}),
      ...(input.whtDefaultRatePercent !== undefined ? { whtDefaultRatePercent: input.whtDefaultRatePercent } : {}),
    };
    if (Object.keys(data).length) await tx.tenantSettings.upsert({ where: { tenantId: a.tenantId }, create: { ...(data as Prisma.TenantSettingsUncheckedCreateInput), tenantId: a.tenantId }, update: data });
    if (input.ntn !== undefined) await tx.tenant.update({ where: { id: a.tenantId }, data: { ntn: input.ntn } });
    const after = await companyTax(tx, a.tenantId);
    const drafts = await recalcDrafts(tx, a.tenantId);
    const changed = Object.keys(input) as Array<keyof ReturnType<typeof snapshotOf>>;
    const [b, n] = [snapshotOf(before), snapshotOf(after)];
    await audit(tx, a, 'tax.settings.update', 'TenantSettings', a.tenantId, {
      before: Object.fromEntries(changed.map((k) => [k, b[k]])),
      after: Object.fromEntries(changed.map((k) => [k, n[k]])),
      draftsRecalculated: drafts,
    });
    return settingsDto(after);
  });
}

async function projectTaxDto(tx: Tx, tenantId: string, projectId: string) {
  const [company, p] = await Promise.all([
    companyTax(tx, tenantId),
    tx.project.findFirstOrThrow({ where: { tenantId, id: projectId }, select: { id: true, taxMode: true, taxAuthority: true, taxRatePercent: true } }),
  ]);
  const eff = resolveTax(company, p);
  return {
    projectId: p.id,
    mode: p.taxMode,
    authority: p.taxAuthority,
    ratePercent: p.taxRatePercent === null ? null : Number(p.taxRatePercent),
    effective: { taxOn: eff.taxOn, applies: eff.applies, authority: eff.authority, ratePercent: Number(eff.ratePercent), label: eff.label, source: eff.source },
    company: { enabled: company.enabled, authority: company.authority, ratePercent: Number(company.ratePercent), whtDefaultRatePercent: Number(company.whtDefaultRatePercent) },
  };
}

export async function getProjectTax(projectId: string) {
  const a = actor();
  assertPerm('billing.invoice.view', a);
  return withTenant(a.tenantId, async (tx) => {
    await billingProject(tx, a, projectId);
    return projectTaxDto(tx, a.tenantId, projectId);
  });
}

export async function updateProjectTax(projectId: string, input: ProjectTaxInput) {
  const a = actor();
  assertPerm('tax.settings.manage', a);
  return withTenant(a.tenantId, async (tx) => {
    const project = await billingProject(tx, a, projectId);
    const before = await projectTaxDto(tx, a.tenantId, projectId);
    const next = {
      taxMode: input.mode ?? project.taxMode,
      taxAuthority: input.authority !== undefined ? input.authority : project.taxAuthority,
      taxRatePercent: input.ratePercent !== undefined ? (input.ratePercent === null ? null : new Prisma.Decimal(input.ratePercent)) : project.taxRatePercent,
    };
    const eff = resolveTax(await companyTax(tx, a.tenantId), next);
    if (next.taxMode === 'ON') {
      const missing = [...(!eff.authority ? ['authority'] : []), ...(eff.ratePercent.lte(0) ? ['ratePercent'] : [])];
      if (missing.length) throw new BadRequest('TAX_SETTINGS_INCOMPLETE', 'Choose the tax authority and rate for this project (or in the company tax settings)', { missing });
    }
    await tx.project.update({ where: { id: project.id }, data: next });
    const drafts = await recalcDrafts(tx, a.tenantId, project.id);
    const after = await projectTaxDto(tx, a.tenantId, projectId);
    await audit(tx, a, 'project.tax.update', 'Project', project.id, {
      before: { mode: before.mode, authority: before.authority, ratePercent: before.ratePercent },
      after: { mode: after.mode, authority: after.authority, ratePercent: after.ratePercent },
      draftsRecalculated: drafts,
    });
    return after;
  });
}
