/**
 * "Contract value from this estimate" — pure, Decimal-safe.
 *
 *   FULL                  value = cost × (1 + finishing %) × (1 + margin %)   → nearest Rs 1,000
 *   GREY_OWNER_FINISHING  value = cost × (1 + margin %)                       → nearest Rs 1,000
 *   LABOR_ONLY            rate  = labour × (1 + margin %) ÷ covered sq ft     → nearest Rs 5
 *
 * `cost` is the contractor's estimated cost (contractor-supplied materials + labour; owner-supplied
 * material is never part of it). The finishing allowance exists because the estimate covers the
 * grey structure only, while a FULL contract also includes finishing. Labour-only: the owner buys
 * the material, so only the labour is priced, per sq ft of covered area.
 */
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';

const D = (v: number | string | bigint) => new Prisma.Decimal(v.toString());
export const VALUE_ROUNDING_PAISA = 100_000n; // Rs 1,000
export const RATE_ROUNDING_PAISA = 500n; // Rs 5

export type ContractKind = 'FULL' | 'GREY_OWNER_FINISHING' | 'LABOR_ONLY';

function roundTo(value: Prisma.Decimal, step: bigint): bigint {
  return BigInt(value.div(D(step)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).mul(D(step)).toFixed(0));
}

/** Suggested contract value (paisa), or null without a cost. */
export function suggestContractValue(costPaisa: bigint, marginPercent: number, finishingAllowancePercent = 0): bigint | null {
  if (costPaisa <= 0n) return null;
  const v = D(costPaisa).mul(D(1).add(D(finishingAllowancePercent).div(100))).mul(D(1).add(D(marginPercent).div(100)));
  return roundTo(v, VALUE_ROUNDING_PAISA);
}

/** Suggested labour rate per sq ft (paisa), or null without labour cost or covered area. */
export function suggestLabourRate(labourPaisa: bigint, marginPercent: number, coveredAreaSqft: number | null): bigint | null {
  if (labourPaisa <= 0n || !coveredAreaSqft || coveredAreaSqft <= 0) return null;
  const v = D(labourPaisa).mul(D(1).add(D(marginPercent).div(100))).div(D(coveredAreaSqft));
  return roundTo(v, RATE_ROUNDING_PAISA);
}

export interface SuggestionInput {
  contractType: ContractKind;
  costPaisa: bigint;
  labourPaisa: bigint;
  coveredAreaSqft: number | null;
  marginPercent: number;
  finishingAllowancePercent: number;
}

/** What the suggestion sets: the contract value, or (labour-only) the rate per sq ft. */
export function suggest(i: SuggestionInput): { kind: 'CONTRACT_VALUE' | 'RATE_PER_SQFT'; basisPaisa: bigint; suggestedPaisa: bigint | null; finishingApplies: boolean } {
  if (i.contractType === 'LABOR_ONLY') {
    return { kind: 'RATE_PER_SQFT', basisPaisa: i.labourPaisa, suggestedPaisa: suggestLabourRate(i.labourPaisa, i.marginPercent, i.coveredAreaSqft), finishingApplies: false };
  }
  const finishingApplies = i.contractType === 'FULL';
  return {
    kind: 'CONTRACT_VALUE',
    basisPaisa: i.costPaisa,
    suggestedPaisa: suggestContractValue(i.costPaisa, i.marginPercent, finishingApplies ? i.finishingAllowancePercent : 0),
    finishingApplies,
  };
}

// ─── POST /projects/:id/contract/from-estimate ──────────────────────────────

export const contractFromEstimateBody = z
  .object({
    marginPercent: z
      .number()
      .min(0, 'Must be between 0 and 100')
      .max(100, 'Must be between 0 and 100')
      .multipleOf(0.01)
      .optional()
      .meta({ description: 'Profit margin %. Omitted = the project override, else the company default (TenantSettings.defaultMarginPercent)', example: 20 }),
    finishingAllowancePercent: z
      .number()
      .min(0, 'Must be between 0 and 200')
      .max(200, 'Must be between 0 and 200')
      .multipleOf(0.01)
      .optional()
      .meta({ description: 'FULL contracts only (ignored otherwise). Omitted = the project override, else the company default', example: 0 }),
    replace: z.boolean().default(false).meta({ description: 'Overwrite an existing contract value / rate (the user confirmed). Without it → 409 CONTRACT_VALUE_EXISTS' }),
  })
  .meta({ id: 'ContractFromEstimateInput' });
