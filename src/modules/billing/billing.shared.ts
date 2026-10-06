/**
 * Billing access and settings. Everything needs billing.view (THEKEDAR always; a PM with
 * financials on their projects; never a MUNSHI). A project outside the caller's reach is 404.
 */
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { Forbidden } from '../../core/errors/AppError.js';
import { todayIn } from '../../core/utils/dates.js';
import type { Project } from '../../generated/prisma/client.js';
import { audit } from '../inventory/stock.js';
import { findProjectFor } from '../projects/access.js';

export { audit };

export interface BillingActor {
  tenantId: string;
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
  seesFinancials: boolean;
  seesRates: boolean;
}

export function actor(): BillingActor {
  const ctx = getCtx();
  return {
    tenantId: ctx.tenantId!,
    userId: ctx.userId!,
    role: ctx.role as BillingActor['role'],
    seesFinancials: ctx.permissions.includes('billing.view'),
    seesRates: ctx.permissions.includes('rates.view'),
  };
}

export const today = () => todayIn('Asia/Karachi');
export const DAY_MS = 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const paisa = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

/** round(amount × percent / 100) half-up, on paisa. */
export function percentOf(amount: bigint, percent: Prisma.Decimal | number | string): bigint {
  return BigInt(new Prisma.Decimal(amount.toString()).mul(percent).div(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

/** A project the caller may see billing for (404 otherwise). */
export async function billingProject(tx: Tx, a: BillingActor, projectId: string): Promise<Project> {
  return findProjectFor(tx, a, projectId);
}

export function assertOwner(a: BillingActor, message = 'Only the owner can do this') {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', message);
}

export interface BillingSettings {
  paymentTermsDays: number;
  taxEnabled: boolean;
  taxRatePercent: Prisma.Decimal;
  taxLabel: string | null;
  pmCanRecordPayments: boolean;
}

export async function billingSettings(tx: Tx, tenantId: string): Promise<BillingSettings> {
  const s = await tx.tenantSettings.findUnique({ where: { tenantId } });
  return {
    paymentTermsDays: s?.paymentTermsDays ?? 7,
    taxEnabled: s?.taxEnabled ?? false,
    taxRatePercent: s?.taxRatePercent ?? new Prisma.Decimal(0),
    taxLabel: s?.taxLabel ?? null,
    pmCanRecordPayments: s?.pmCanRecordPayments ?? false,
  };
}

/** Letterhead + client details used by PDFs and share texts. */
export async function companyOf(tx: Tx, tenantId: string) {
  return tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, ntn: true, address: true, phone: true, logo: { select: { storageKey: true } } } });
}

export const NUMBER = { invoice: 'INV-{YYYY}-####', receipt: 'RV-{YYYY}-####' } as const;
