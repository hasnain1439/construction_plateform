/**
 * Worker types — the company's DAILY labour rates (Mason, Labourer, Electrician, ...). Each has an
 * English / Roman Urdu / Urdu name, a default daily wage, an overtime multiplier and an active flag.
 * `Worker.type` holds the type's `key` (or OTHER, always allowed). No hard delete: deactivating a
 * type only stops it being given to new workers; existing workers keep it.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import type { LaborRate } from '../../generated/prisma/client.js';
import { OTHER_WORKER_TYPE } from './catalog.js';
import type { CreateWorkerTypeInput, ListWorkerTypesQuery, UpdateWorkerTypeInput } from './master-data.schema.js';
import { audit, conflictOn, current } from './master-data.shared.js';

export const DEFAULT_OVERTIME_MULTIPLIER = 1.5;

export interface TypeLabels {
  label: string;
  labelRoman: string | null;
  labelUrdu: string | null;
}

const typeNotFound = () => new NotFound('WORKER_TYPE_NOT_FOUND', 'Worker type not found');
const typeExists = () => new Conflict('WORKER_TYPE_EXISTS', 'An active worker type with this name already exists');

export function toWorkerTypeDto(r: LaborRate, workerCount: number) {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    labelRoman: r.labelRoman,
    labelUrdu: r.labelUrdu,
    ratePaisa: r.ratePaisa.toString(),
    overtimeMultiplier: r.overtimeMultiplier === null ? null : Number(r.overtimeMultiplier),
    isActive: r.isActive,
    workerCount,
  };
}

/** UPPER_SNAKE key from an English name: "Steel-fixer (helper)" → STEEL_FIXER_HELPER. */
export function keyFromLabel(label: string): string {
  const base = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/g, '');
  return base || 'TYPE';
}

/** A key not used by any DAILY rate of the company (active or not) and never OTHER. */
function uniqueKey(label: string, taken: Set<string>): string {
  const base = keyFromLabel(label);
  if (base !== OTHER_WORKER_TYPE && !taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const key = `${base}_${n}`;
    if (!taken.has(key)) return key;
  }
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function assertNameFree(tx: Tx, label: string, exceptId?: string) {
  const active = await tx.laborRate.findMany({ where: { kind: 'DAILY', isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { label: true } });
  if (active.some((r) => sameName(r.label, label))) throw typeExists();
}

async function workerCounts(tx: Tx): Promise<Map<string, number>> {
  const groups = await tx.worker.groupBy({ by: ['type'], _count: { _all: true } });
  return new Map(groups.map((g) => [g.type, g._count._all]));
}

const sortTypes = <T extends { isActive: boolean; label: string }>(rows: T[]) =>
  rows.sort((x, y) => Number(y.isActive) - Number(x.isActive) || x.label.localeCompare(y.label, 'en', { sensitivity: 'base' }));

export async function listWorkerTypes(query: ListWorkerTypesQuery) {
  return withTenant(current().tenantId, async (tx) => {
    const rows = await tx.laborRate.findMany({ where: { kind: 'DAILY', ...(query.includeInactive ? {} : { isActive: true }) } });
    const counts = await workerCounts(tx);
    return sortTypes(rows.map((r) => toWorkerTypeDto(r, counts.get(r.key) ?? 0)));
  });
}

export async function createWorkerType(input: CreateWorkerTypeInput) {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    await assertNameFree(tx, input.label);
    const taken = new Set((await tx.laborRate.findMany({ where: { kind: 'DAILY' }, select: { key: true } })).map((r) => r.key));
    const type = await tx.laborRate.create({
      data: {
        tenantId,
        kind: 'DAILY',
        key: uniqueKey(input.label, taken),
        label: input.label,
        labelRoman: input.labelRoman ?? null,
        labelUrdu: input.labelUrdu ?? null,
        unit: 'DAY',
        ratePaisa: input.ratePaisa,
        overtimeMultiplier: input.overtimeMultiplier === undefined ? DEFAULT_OVERTIME_MULTIPLIER : input.overtimeMultiplier,
      },
    });
    await audit(tx, 'worker_type.create', 'LaborRate', type.id, { key: type.key, label: type.label, ratePaisa: type.ratePaisa.toString() });
    return toWorkerTypeDto(type, 0);
  }).catch(conflictOn('WORKER_TYPE_EXISTS', 'A worker type with this key already exists — try again'));
}

export async function updateWorkerType(id: string, input: UpdateWorkerTypeInput) {
  return withTenant(current().tenantId, async (tx) => {
    const type = await tx.laborRate.findUnique({ where: { id } });
    if (!type || type.kind !== 'DAILY') throw typeNotFound();
    const label = input.label ?? type.label;
    const isActive = input.isActive ?? type.isActive;
    if (isActive && (!sameName(label, type.label) || !type.isActive)) await assertNameFree(tx, label, id);

    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const updated = await tx.laborRate.update({ where: { id }, data });
    const fields = Object.keys(data);
    const action = input.isActive === undefined || input.isActive === type.isActive ? 'worker_type.update' : input.isActive ? 'worker_type.activate' : 'worker_type.deactivate';
    await audit(tx, action, 'LaborRate', id, { key: updated.key, label: updated.label, fields });
    return toWorkerTypeDto(updated, (await workerCounts(tx)).get(updated.key) ?? 0);
  });
}

// ─── Used by workers / sync / dashboard ─────────────────────────────────────

/** key → names of every DAILY type of the company (active or not). RLS scopes it; pass tenantId to filter explicitly too. */
export async function typeLabels(tx: Tx, tenantId?: string): Promise<Map<string, TypeLabels>> {
  const rows = await tx.laborRate.findMany({ where: { kind: 'DAILY', ...(tenantId ? { tenantId } : {}) }, select: { key: true, label: true, labelRoman: true, labelUrdu: true } });
  return new Map(rows.map((r) => [r.key, { label: r.label, labelRoman: r.labelRoman, labelUrdu: r.labelUrdu }]));
}

/** Names for a key; OTHER and unknown keys fall back to a readable form of the key. */
export function labelsOf(labels: Map<string, TypeLabels>, key: string): TypeLabels {
  const known = labels.get(key);
  if (known) return known;
  if (key === OTHER_WORKER_TYPE) return { label: 'Other', labelRoman: 'Other', labelUrdu: 'دیگر' };
  const readable = key.charAt(0) + key.slice(1).toLowerCase().replace(/_/g, ' ');
  return { label: readable, labelRoman: null, labelUrdu: null };
}

/**
 * Checks a worker type for a new worker (or a type change): an ACTIVE DAILY key of the company or
 * OTHER. `keep` = the worker's current type, which may stay even if it was deactivated since.
 * Returns the type's row (null for OTHER).
 */
export async function checkWorkerType(tx: Tx, key: string, keep?: string): Promise<LaborRate | null> {
  if (key === OTHER_WORKER_TYPE) return null;
  const type = await tx.laborRate.findFirst({ where: { kind: 'DAILY', key } });
  if (type && (type.isActive || key === keep)) return type;
  throw new BadRequest(
    'INVALID_WORKER_TYPE',
    type ? 'This worker type is no longer active' : 'Unknown worker type — pick one of the company’s worker types',
    { type: key },
  );
}
