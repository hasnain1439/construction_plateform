/**
 * Step 18 — tax rules (off by default). One place decides whether an invoice of a project gets
 * a sales tax line, on what base and at what rate, and how a client's WHT deduction is worked out.
 *
 * Every rate and rule here is a DEFAULT to be confirmed by the company's tax adviser:
 * - authority default rates (PRA 16 %, SRB 15 %, KPRA 15 %, ICT 16 %) only pre-fill the form;
 * - taxable base = invoice lines except owner-recoverable purchases (CASH_ENTRY, passed through
 *   at cost); change-order lines and the running-bill "less retention" line count, so every rupee
 *   is taxed once, when it is invoiced (the retention release invoice is taxed when issued);
 * - tax = round half-up (base × rate ÷ 100) to the paisa, once per invoice;
 * - WHT is a % of the gross receipt (cash + WHT).
 */
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import type { InvoiceLineSource, ProjectTaxMode, TaxAuthority } from '../../generated/prisma/client.js';
import { percentOf } from '../billing/billing.shared.js';

export const TAX_AUTHORITIES = ['PRA', 'SRB', 'KPRA', 'ICT'] as const satisfies readonly TaxAuthority[];

export const AUTHORITY_INFO: Record<TaxAuthority, { name: string; defaultRatePercent: number; defaultLabel: string }> = {
  PRA: { name: 'Punjab Revenue Authority (Punjab Sales Tax on Services)', defaultRatePercent: 16, defaultLabel: 'PRA Sales Tax' },
  SRB: { name: 'Sindh Revenue Board (Sindh Sales Tax on Services)', defaultRatePercent: 15, defaultLabel: 'SRB Sales Tax' },
  KPRA: { name: 'Khyber Pakhtunkhwa Revenue Authority', defaultRatePercent: 15, defaultLabel: 'KPRA Sales Tax' },
  ICT: { name: 'Islamabad Capital Territory (tax on services, FBR)', defaultRatePercent: 16, defaultLabel: 'ICT Sales Tax' },
};

export const ADVISER_NOTE =
  'Default rates and rules are a starting point only — verify the rate, the taxable base and WHT with your tax adviser before switching tax on.';

/** Lines that are not the contractor's service (owner purchases passed through at cost). */
export const UNTAXED_SOURCES: ReadonlySet<InvoiceLineSource> = new Set<InvoiceLineSource>(['CASH_ENTRY']);

export interface CompanyTax {
  enabled: boolean;
  authority: TaxAuthority | null;
  ratePercent: Prisma.Decimal;
  label: string | null;
  ntn: string | null;
  strn: string | null;
  whtDefaultRatePercent: Prisma.Decimal;
}

export interface EffectiveTax {
  /** Tax is switched on for this project (WHT may be recorded). */
  taxOn: boolean;
  /** Invoices get a tax line (on and rate > 0). */
  applies: boolean;
  authority: TaxAuthority | null;
  ratePercent: Prisma.Decimal;
  label: string | null;
  source: 'COMPANY' | 'PROJECT' | 'OFF';
}

export async function companyTax(tx: Tx, tenantId: string): Promise<CompanyTax> {
  const [s, t] = await Promise.all([tx.tenantSettings.findUnique({ where: { tenantId } }), tx.tenant.findUnique({ where: { id: tenantId }, select: { ntn: true } })]);
  return {
    enabled: s?.taxEnabled ?? false,
    authority: s?.taxAuthority ?? null,
    ratePercent: s?.taxRatePercent ?? new Prisma.Decimal(0),
    label: s?.taxLabel ?? null,
    ntn: t?.ntn ?? null,
    strn: s?.taxStrn ?? null,
    whtDefaultRatePercent: s?.whtDefaultRatePercent ?? new Prisma.Decimal(8),
  };
}

export interface ProjectTaxOverride {
  taxMode: ProjectTaxMode;
  taxAuthority: TaxAuthority | null;
  taxRatePercent: Prisma.Decimal | null;
}

/** Company setting + project override → what an invoice of the project uses. */
export function resolveTax(company: CompanyTax, project: ProjectTaxOverride): EffectiveTax {
  const taxOn = project.taxMode === 'ON' || (project.taxMode === 'INHERIT' && company.enabled);
  const authority = project.taxAuthority ?? company.authority;
  const ratePercent = project.taxRatePercent ?? company.ratePercent;
  const label = authority && authority !== company.authority ? AUTHORITY_INFO[authority].defaultLabel : (company.label ?? (authority ? AUTHORITY_INFO[authority].defaultLabel : null));
  const source = !taxOn ? 'OFF' : project.taxMode === 'ON' || project.taxAuthority || project.taxRatePercent ? 'PROJECT' : 'COMPANY';
  return { taxOn, applies: taxOn && ratePercent.gt(0), authority, ratePercent, label, source };
}

export async function effectiveTax(tx: Tx, tenantId: string, projectId: string): Promise<EffectiveTax & { company: CompanyTax }> {
  const [company, project] = await Promise.all([
    companyTax(tx, tenantId),
    tx.project.findFirstOrThrow({ where: { tenantId, id: projectId }, select: { taxMode: true, taxAuthority: true, taxRatePercent: true } }),
  ]);
  return { ...resolveTax(company, project), company };
}

/** Σ taxable lines (never below zero). */
export function taxableBase(lines: Array<{ amountPaisa: bigint; sourceType: InvoiceLineSource }>): bigint {
  const base = lines.filter((l) => !UNTAXED_SOURCES.has(l.sourceType)).reduce((s, l) => s + l.amountPaisa, 0n);
  return base > 0n ? base : 0n;
}

/** Tax on a base: round half-up to the paisa. */
export const taxOf = (basePaisa: bigint, ratePercent: Prisma.Decimal | number | string) => percentOf(basePaisa, ratePercent);

/** WHT from the cash received at r % of the gross: round(cash × r ÷ (100 − r)). */
export function whtFromRate(cashPaisa: bigint, ratePercent: Prisma.Decimal | number): bigint {
  const r = new Prisma.Decimal(ratePercent);
  return BigInt(new Prisma.Decimal(cashPaisa.toString()).mul(r).div(new Prisma.Decimal(100).minus(r)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

/** WHT as a % of the gross (2 dp). */
export function whtRateOf(cashPaisa: bigint, whtPaisa: bigint): Prisma.Decimal {
  const gross = cashPaisa + whtPaisa;
  return gross > 0n ? new Prisma.Decimal(whtPaisa.toString()).mul(100).div(gross.toString()).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) : new Prisma.Decimal(0);
}

/** Pakistan tax year containing `date`: 1 July – 30 June ("2026-27" = 1 Jul 2026 – 30 Jun 2027). */
export function taxYearOf(date: string): { from: string; to: string; label: string } {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 7 ? y : y - 1;
  return { from: `${start}-07-01`, to: `${start + 1}-06-30`, label: `${start}-${String(start + 1).slice(2)}` };
}
