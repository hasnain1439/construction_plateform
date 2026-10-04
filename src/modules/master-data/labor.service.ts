/** Labour rates (daily wages + sub-contract rates) and payment schedule templates. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, NotFound } from '../../core/errors/AppError.js';
import type { LaborRate, PaymentScheduleTemplate, Prisma } from '../../generated/prisma/client.js';
import { DAILY_KEYS, DEFAULT_LABOR_RATES, SUBCONTRACT_KEYS, type StageDef } from './catalog.js';
import type { CreateTemplateInput, SetLaborRatesInput, UpdateTemplateInput } from './master-data.schema.js';
import { audit, conflictOn, current } from './master-data.shared.js';

// ─── Labour rates ───────────────────────────────────────────────────────────

const KEYS = { DAILY: DAILY_KEYS as readonly string[], SUBCONTRACT: SUBCONTRACT_KEYS as readonly string[] };
const titleCase = (key: string) => key.charAt(0) + key.slice(1).toLowerCase().replace(/_/g, ' ');

function toLaborDto(r: LaborRate) {
  return {
    id: r.id,
    kind: r.kind,
    key: r.key,
    label: r.label,
    unit: r.unit,
    ratePaisa: r.ratePaisa.toString(),
    overtimeMultiplier: r.overtimeMultiplier === null ? null : Number(r.overtimeMultiplier),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const listLabor = (tx: Tx) => tx.laborRate.findMany({ orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }, { key: 'asc' }] });

export async function listLaborRates() {
  return withTenant(current().tenantId, async (tx) => (await listLabor(tx)).map(toLaborDto));
}

export async function setLaborRates(input: SetLaborRatesInput) {
  const { tenantId } = current();
  const invalid = input.rates.filter((r) => !KEYS[r.kind].includes(r.key)).map((r) => `${r.kind}:${r.key}`);
  if (invalid.length) throw new BadRequest('INVALID_LABOR_KEY', 'Unknown labour rate key for that kind', { invalid });
  const dailyNotPerDay = input.rates.filter((r) => r.kind === 'DAILY' && r.unit !== 'DAY').map((r) => r.key);
  if (dailyNotPerDay.length) throw new BadRequest('INVALID_LABOR_UNIT', 'Daily wages are per DAY', { keys: dailyNotPerDay });

  return withTenant(tenantId, async (tx) => {
    const existing = new Map((await tx.laborRate.findMany()).map((r) => [`${r.kind}:${r.key}`, r]));
    let changed = 0;
    for (const r of input.rates) {
      const cur = existing.get(`${r.kind}:${r.key}`);
      const label = r.label ?? cur?.label ?? DEFAULT_LABOR_RATES.find((d) => d.kind === r.kind && d.key === r.key)?.label ?? titleCase(r.key);
      const overtimeMultiplier = r.overtimeMultiplier === undefined ? (cur ? cur.overtimeMultiplier : null) : r.overtimeMultiplier;
      const same =
        cur &&
        cur.label === label &&
        cur.unit === r.unit &&
        cur.ratePaisa === r.ratePaisa &&
        (cur.overtimeMultiplier === null ? null : Number(cur.overtimeMultiplier)) === (overtimeMultiplier === null ? null : Number(overtimeMultiplier));
      if (same) continue;
      const data = { label, unit: r.unit, ratePaisa: r.ratePaisa, overtimeMultiplier };
      await tx.laborRate.upsert({
        where: { tenantId_kind_key: { tenantId, kind: r.kind, key: r.key } },
        create: { tenantId, kind: r.kind, key: r.key, ...data },
        update: data,
      });
      changed++;
    }
    await audit(tx, 'labor_rates.update', 'LaborRate', tenantId, {
      changed,
      unchanged: input.rates.length - changed,
      keys: input.rates.map((r) => `${r.kind}:${r.key}`),
    });
    return { changed, unchanged: input.rates.length - changed, rates: (await listLabor(tx)).map(toLaborDto) };
  });
}

// ─── Payment schedule templates ─────────────────────────────────────────────

const templateNotFound = () => new NotFound('TEMPLATE_NOT_FOUND', 'Payment template not found');
const templateExists = conflictOn('TEMPLATE_EXISTS', 'A payment template with this name already exists');

function toTemplateDto(t: PaymentScheduleTemplate) {
  return { id: t.id, name: t.name, billingModel: t.billingModel, stages: t.stages as unknown as StageDef[], isDefault: t.isDefault, updatedAt: t.updatedAt.toISOString() };
}

/** Validates stages (total exactly 100 %, at most one retention) and returns them as JSON. Shared with project billing stages. */
export function checkStages(stages: StageDef[]): Prisma.InputJsonValue {
  const total = Math.round(stages.reduce((sum, s) => sum + s.percent, 0) * 100) / 100;
  if (total !== 100) throw new BadRequest('PERCENT_TOTAL_INVALID', `Stage percentages must add up to 100 (now ${total})`, { total });
  if (stages.filter((s) => s.isRetention).length > 1) throw new BadRequest('RETENTION_STAGE_INVALID', 'Only one stage can be the retention');
  return stages.map((s) => ({ label: s.label, percent: s.percent, ...(s.isRetention ? { isRetention: true } : {}) }));
}

async function makeOnlyDefault(tx: Tx, id: string) {
  await tx.paymentScheduleTemplate.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
}

export async function listTemplates() {
  return withTenant(current().tenantId, async (tx) =>
    (await tx.paymentScheduleTemplate.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] })).map(toTemplateDto),
  );
}

export async function createTemplate(input: CreateTemplateInput) {
  const { tenantId } = current();
  const stages = checkStages(input.stages);
  return withTenant(tenantId, async (tx) => {
    const isDefault = input.isDefault || (await tx.paymentScheduleTemplate.count()) === 0;
    const template = await tx.paymentScheduleTemplate.create({ data: { tenantId, name: input.name, billingModel: input.billingModel, stages, isDefault } });
    if (isDefault) await makeOnlyDefault(tx, template.id);
    await audit(tx, 'payment_template.create', 'PaymentScheduleTemplate', template.id, { name: template.name, isDefault });
    return toTemplateDto(template);
  }).catch(templateExists);
}

export async function updateTemplate(id: string, input: UpdateTemplateInput) {
  const stages = input.stages ? checkStages(input.stages) : undefined;
  return withTenant(current().tenantId, async (tx) => {
    if (!(await tx.paymentScheduleTemplate.findUnique({ where: { id } }))) throw templateNotFound();
    if (input.isDefault) await makeOnlyDefault(tx, id);
    const updated = await tx.paymentScheduleTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.billingModel !== undefined ? { billingModel: input.billingModel } : {}),
        ...(stages !== undefined ? { stages } : {}),
        ...(input.isDefault ? { isDefault: true } : {}),
      },
    });
    const fields = Object.keys(input).filter((k) => input[k as keyof UpdateTemplateInput] !== undefined);
    await audit(tx, 'payment_template.update', 'PaymentScheduleTemplate', id, { name: updated.name, fields });
    return toTemplateDto(updated);
  }).catch(templateExists);
}

export async function deleteTemplate(id: string) {
  return withTenant(current().tenantId, async (tx) => {
    const template = await tx.paymentScheduleTemplate.findUnique({ where: { id } });
    if (!template) throw templateNotFound();
    if (template.isDefault) throw new BadRequest('TEMPLATE_IS_DEFAULT', 'Make another template the default before deleting this one');
    await tx.paymentScheduleTemplate.delete({ where: { id } });
    await audit(tx, 'payment_template.delete', 'PaymentScheduleTemplate', id, { name: template.name });
    return { id, deleted: true };
  });
}
