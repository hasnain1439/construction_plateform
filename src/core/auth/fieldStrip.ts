/**
 * THE field-stripping helper — REST serializers and the sync serializers both decide which
 * values a caller sees through these two functions, driven by the caller's field permissions
 * (`fields.rates`, `fields.amounts`, `fields.profit`, `fields.contract` → FieldAccess).
 *
 *   ...visible(fa, 'rates', { ratePaisa, valuePaisa })     // spread: the keys, or nothing
 *   stripFields(row, fa, { rates: ['ratePaisa'], amounts: ['totalPaisa'] })  // copy without hidden keys
 */
import type { FieldAccess } from './access.js';

export type FieldName = keyof FieldAccess;

/** `values` when the caller may see `field`, otherwise an empty object (for spreading). */
export function visible<T extends object>(fa: FieldAccess, field: FieldName, values: T): T | Record<string, never> {
  return fa[field] ? values : {};
}

/** A shallow copy of `row` without the keys of every field the caller may not see. */
export function stripFields<T extends Record<string, unknown>>(row: T, fa: FieldAccess, spec: Partial<Record<FieldName, ReadonlyArray<keyof T>>>): T {
  const out: Record<string, unknown> = { ...row };
  for (const [field, keys] of Object.entries(spec) as Array<[FieldName, ReadonlyArray<keyof T>]>) {
    if (fa[field]) continue;
    for (const k of keys) delete out[k as string];
  }
  return out as T;
}

/** FieldAccess with everything hidden (site-safe default). */
export const NO_FIELDS: FieldAccess = { rates: false, amounts: false, profit: false, contract: false };

/** FieldAccess of a module actor that carries the resolved flags (seesRates = fields.rates, seesFinancials = fields.amounts). */
export function fieldsOf(a: { seesRates: boolean; seesFinancials?: boolean; seesProfit?: boolean }): FieldAccess {
  const amounts = a.seesFinancials ?? false;
  return { rates: a.seesRates, amounts, profit: a.seesProfit ?? false, contract: amounts };
}
