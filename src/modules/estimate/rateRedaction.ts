/**
 * Rupee rates never reach a caller without `fields.rates` — not even inside human-readable text.
 *
 * BoQ lump-sum lines carry their rulebook rate in the formula ("1125 cft × Rs 150 per cft",
 * "Lump sum Rs 85000") and the estimate `parameters` map holds the rulebook Rs rates
 * (excavationRsPerCft …). Those rows are stored with the revision, so the redaction happens when
 * a line / parameter map is serialized, for every line (live BoQ preview, saved revisions).
 */
import { PARAM_BY_KEY } from './rulebookDefs.js';

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const CURRENCY = String.raw`(?:Rs\.?|PKR|₨)`;
/** "× Rs 150 per cft" / "× Rs 2,500 per wet room" / "× Rs 150" → "× rulebook rate" */
const TIMES_RATE = new RegExp(String.raw`×\s*${CURRENCY}\s*${NUM}(?:\s*(?:per|/)\s*(?:sq\.? ?ft|sqft|cft|wet rooms?|rooms?|rft|ton|kg|nos|bags?|LS))?`, 'gi');
/** "Lump sum Rs 85000" → "Lump sum (rulebook rate)" */
const LUMP_SUM = new RegExp(String.raw`(Lump sum)\s+${CURRENCY}\s*${NUM}`, 'gi');
/** Anything else that still looks like an amount. */
const ANY_AMOUNT = new RegExp(String.raw`${CURRENCY}\s*${NUM}(?:\s*(?:lakh|crore|k)\b)?`, 'gi');

/** The text with every rupee amount replaced by a rate-free wording. */
export function withoutRupees(text: string): string {
  return text.replace(LUMP_SUM, '$1 (rulebook rate)').replace(TIMES_RATE, '× rulebook rate').replace(ANY_AMOUNT, '(rate hidden)');
}

/** Formula + trace of a line, rate-free unless the caller may see rates. */
export function lineTexts(formula: string, trace: readonly string[], rates: boolean): { formula: string; trace: string[] } {
  if (rates) return { formula, trace: [...trace] };
  return { formula: withoutRupees(formula), trace: trace.map(withoutRupees) };
}

/** Rulebook parameters measured in rupees (unit "Rs / …"). */
export const isRupeeParameter = (key: string) => (PARAM_BY_KEY.get(key)?.unit ?? '').startsWith('Rs');

/** The estimate `parameters` map without the rupee-rate parameters unless the caller may see rates. */
export function visibleParameters<T>(parameters: Record<string, T>, rates: boolean): Record<string, T> {
  if (rates) return parameters;
  return Object.fromEntries(Object.entries(parameters).filter(([key]) => !isRupeeParameter(key)));
}
