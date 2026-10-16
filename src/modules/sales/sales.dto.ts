/**
 * Step 12 · Quote responses. Money follows the field permissions (keys are left out, not nulled):
 *   fields.contract            → the price (pricePaisa, perSqftPaisa, stage amounts, inputs.finalPricePaisa)
 *   fields.rates               → internal cost (costPaisa, section amounts, overheads, contingency …)
 *   fields.contract + profit   → margin (marginPaisa, marginPercent, finishing allowance %)
 */
import type { FieldAccess } from '../../core/auth/access.js';
import type { Quote, QuoteRevision } from '../../generated/prisma/client.js';
import type { PaymentStage, QuoteInputs, QuoteResult } from './quote.compute.js';

/** SENT with no activity for more than this many days → on the follow-up list. */
export const FOLLOW_UP_DAYS = 5;
const DAY_MS = 86_400_000;

const str = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const when = <T extends object>(cond: boolean, v: T): T | Record<string, never> => (cond ? v : {});

type Person = { id: string; name: string } | null;
export type QuoteRow = Quote & { client: { id: string; name: string; phone: string }; createdBy: Person };
export type RevisionRow = QuoteRevision & { createdBy: Person };
export type WonProject = { id: string; code: string; name: string; status: string } | null;

export const isFollowUp = (q: Pick<Quote, 'status' | 'lastActivityAt'>, now = new Date()) => q.status === 'SENT' && now.getTime() - q.lastActivityAt.getTime() > FOLLOW_UP_DAYS * DAY_MS;

export function summaryDto(q: QuoteRow, fa: FieldAccess, wonProject: WonProject, now = new Date()) {
  return {
    id: q.id,
    number: q.number,
    status: q.status,
    title: q.title,
    client: { id: q.client.id, name: q.client.name, phone: q.client.phone },
    siteAddress: q.siteAddress,
    city: q.city,
    revision: q.revision,
    contractType: q.contractType,
    coveredAreaSqft: Number(q.coveredAreaSqft),
    validUntil: ymd(q.validUntil)!,
    sentAt: iso(q.sentAt),
    lastActivityAt: q.lastActivityAt.toISOString(),
    daysSinceActivity: Math.floor((now.getTime() - q.lastActivityAt.getTime()) / DAY_MS),
    followUp: isFollowUp(q, now),
    wonAt: iso(q.wonAt),
    lostAt: iso(q.lostAt),
    expiredAt: iso(q.expiredAt),
    lostReason: q.lostReason,
    lostNote: q.lostNote,
    wonProject,
    createdBy: q.createdBy,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    ...when(fa.contract, { pricePaisa: str(q.pricePaisa), perSqftPaisa: str(q.perSqftPaisa) }),
  };
}

/** Inputs without the values the reader may not see. */
export function inputsDto(inputs: QuoteInputs, fa: FieldAccess) {
  const { marginPercent, finishingAllowancePercent, finalPricePaisa, ...rest } = inputs;
  return {
    ...rest,
    ...when(fa.contract, { finalPricePaisa }),
    ...when(fa.contract && fa.profit, { marginPercent, finishingAllowancePercent }),
  };
}

/** The money parts a revision (saved or preview) carries. */
export interface RevisionMoney {
  directCostPaisa: bigint;
  overheadPaisa: bigint;
  contingencyPaisa: bigint;
  costPaisa: bigint;
  finishingAllowancePaisa: bigint;
  computedPricePaisa: bigint | null;
  pricePaisa: bigint | null;
  perSqftPaisa: bigint | null;
  marginPaisa: bigint | null;
  marginPercent: number;
  finishingAllowancePercent: number;
  marginOnPricePercent: number | null;
  priceOverridden: boolean;
  costPerSqftPaisa: bigint | null;
}

export function computedDto(
  parts: { inputs: QuoteInputs; result: QuoteResult; paymentStages: PaymentStage[]; paymentTemplate: { id: string; name: string } | null } & RevisionMoney,
  fa: FieldAccess,
) {
  const r = parts.result;
  return {
    inputs: inputsDto(parts.inputs, fa),
    rulebook: r.rulebook,
    basis: r.basis,
    quantities: r.quantities,
    sections: r.sections.map((s) => ({ section: s.section, ...when(fa.rates, { amountPaisa: s.amountPaisa }) })),
    specifications: r.specifications,
    paymentStages: parts.paymentStages.map((s) => ({ label: s.label, percent: s.percent, isRetention: s.isRetention, ...when(fa.contract, { amountPaisa: s.amountPaisa }) })),
    paymentTemplate: parts.paymentTemplate,
    warnings: r.warnings,
    ...when(fa.rates, {
      costPaisa: parts.costPaisa.toString(),
      directCostPaisa: parts.directCostPaisa.toString(),
      overheadPaisa: parts.overheadPaisa.toString(),
      contingencyPaisa: parts.contingencyPaisa.toString(),
      finishingAllowancePaisa: parts.finishingAllowancePaisa.toString(),
      costPerSqftPaisa: str(parts.costPerSqftPaisa),
    }),
    ...when(fa.contract, {
      pricePaisa: str(parts.pricePaisa),
      computedPricePaisa: str(parts.computedPricePaisa),
      perSqftPaisa: str(parts.perSqftPaisa),
      priceOverridden: parts.priceOverridden,
    }),
    ...when(fa.contract && fa.profit, {
      marginPercent: parts.marginPercent,
      finishingAllowancePercent: parts.finishingAllowancePercent,
      marginPaisa: str(parts.marginPaisa),
      marginOnPricePercent: parts.marginOnPricePercent,
    }),
  };
}

/** Money of a stored revision in the shape computedDto takes. */
export function storedMoney(r: QuoteRevision): RevisionMoney {
  const price = r.pricePaisa;
  return {
    directCostPaisa: r.directCostPaisa,
    overheadPaisa: r.overheadPaisa,
    contingencyPaisa: r.contingencyPaisa,
    costPaisa: r.costPaisa,
    finishingAllowancePaisa: r.finishingAllowancePaisa,
    computedPricePaisa: r.computedPricePaisa,
    pricePaisa: price,
    perSqftPaisa: r.perSqftPaisa,
    marginPaisa: r.marginPaisa,
    marginPercent: Number(r.marginPercent),
    finishingAllowancePercent: Number(r.finishingAllowancePercent),
    marginOnPricePercent: price > 0n ? Math.round((Number(r.marginPaisa) / Number(price)) * 10_000) / 100 : null,
    priceOverridden: (r.inputs as unknown as QuoteInputs).finalPricePaisa !== null,
    costPerSqftPaisa: Number(r.coveredAreaSqft) > 0 ? BigInt(Math.round(Number(r.costPaisa) / Number(r.coveredAreaSqft))) : null,
  };
}

export function revisionDto(r: RevisionRow, fa: FieldAccess) {
  return {
    id: r.id,
    revision: r.revision,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    ...computedDto(
      {
        inputs: r.inputs as unknown as QuoteInputs,
        result: r.result as unknown as QuoteResult,
        paymentStages: r.paymentStages as unknown as PaymentStage[],
        paymentTemplate: r.paymentTemplateId ? { id: r.paymentTemplateId, name: r.paymentTemplateName ?? '' } : null,
        ...storedMoney(r),
      },
      fa,
    ),
  };
}

export function revisionListItem(r: RevisionRow, fa: FieldAccess) {
  return {
    revision: r.revision,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    note: r.note,
    ...when(fa.contract, { pricePaisa: r.pricePaisa.toString(), perSqftPaisa: str(r.perSqftPaisa) }),
    ...when(fa.rates, { costPaisa: r.costPaisa.toString() }),
  };
}

/** Audit details without money the reader may not see (any `*Paisa` key needs fields.contract). */
export function activityDetails(details: unknown, fa: FieldAccess): unknown {
  if (!details || typeof details !== 'object' || Array.isArray(details) || fa.contract) return details ?? null;
  return Object.fromEntries(Object.entries(details as Record<string, unknown>).filter(([k]) => !k.endsWith('Paisa') && k !== 'marginPercent'));
}
