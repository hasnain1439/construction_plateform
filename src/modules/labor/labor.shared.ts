/** Shared rules for the labour and cash-book modules: caller, weeks, settings, idempotency. */
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest, Forbidden } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly, todayIn } from '../../core/utils/dates.js';
import type { Project, WeekDay } from '../../generated/prisma/client.js';
import { actor, audit, type Actor } from '../inventory/stock.js';
import { assertEditable, findProjectFor } from '../projects/access.js';

export { actor, audit, type Actor };

const DAY_MS = 86_400_000;
export const WEEKDAYS: WeekDay[] = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
export const weekdayOf = (date: string): WeekDay => WEEKDAYS[dateOnly(date).getUTCDay()]!;
export const addDays = (date: string, days: number) => formatDateOnly(new Date(dateOnly(date).getTime() + days * DAY_MS));
export const today = () => todayIn('Asia/Karachi');
export const paisa = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
export const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d.toFixed(3)));

/** qty × rate rounded half-up to paisa. */
export function times(qty: Prisma.Decimal | number | string, ratePaisa: bigint): bigint {
  return BigInt(new Prisma.Decimal(qty).mul(ratePaisa.toString()).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));
}

export interface LaborSettings {
  weekStart: WeekDay;
  workingDays: WeekDay[];
  hoursPerDay: Prisma.Decimal;
  overtimeMultiplier: Prisma.Decimal;
  kharchaApprovalLimitPaisa: bigint;
  subcontractPaymentsByPm: boolean;
}

/** Company labour settings (overtime multiplier falls back to the DAILY labour rate's, then ×1.5). */
export async function laborSettings(tx: Tx, tenantId: string): Promise<LaborSettings> {
  const s = await tx.tenantSettings.findUnique({ where: { tenantId } });
  let multiplier = s?.overtimeMultiplier ?? null;
  if (!multiplier) {
    const rate = await tx.laborRate.findFirst({ where: { tenantId, kind: 'DAILY', overtimeMultiplier: { not: null } }, select: { overtimeMultiplier: true } });
    multiplier = rate?.overtimeMultiplier ?? new Prisma.Decimal(1.5);
  }
  return {
    weekStart: s?.settlementWeekStart ?? 'MONDAY',
    workingDays: s?.workingDays ?? ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
    hoursPerDay: s?.hoursPerDay ?? new Prisma.Decimal(8),
    overtimeMultiplier: multiplier,
    kharchaApprovalLimitPaisa: s?.kharchaApprovalLimitPaisa ?? 2_500_000n,
    subcontractPaymentsByPm: s?.subcontractPaymentsByPm ?? false,
  };
}

/** The settlement week containing `date`. */
export function weekOf(date: string, weekStart: WeekDay): { weekStart: string; weekEnd: string } {
  const shift = (WEEKDAYS.indexOf(weekdayOf(date)) - WEEKDAYS.indexOf(weekStart) + 7) % 7;
  const start = addDays(date, -shift);
  return { weekStart: start, weekEnd: addDays(start, 6) };
}

export function assertWeekStart(date: string, weekStart: WeekDay) {
  if (weekdayOf(date) !== weekStart) {
    throw new BadRequest('INVALID_WEEK_START', `Settlement weeks start on ${weekStart.toLowerCase()}`, { weekStart });
  }
}

/** A project the caller can see (404 otherwise); `open` also requires ACTIVE / CLOSEOUT. */
export async function projectFor(tx: Tx, a: Actor, projectId: string, open = false): Promise<Project> {
  const project = await findProjectFor(tx, a, projectId);
  if (open) assertEditable(project, ['ACTIVE', 'CLOSEOUT']);
  return project;
}

export function assertOffice(a: Actor, message = 'Only the owner or a project manager can do this') {
  if (a.role === 'MUNSHI') throw new Forbidden('FORBIDDEN', message);
}

/**
 * Offline-safe creates: a repeated `clientId` (UUID v7 from the phone) returns the record
 * that was already saved instead of a duplicate. `find` looks it up inside the tenant.
 */
export async function existingByClientId<T>(clientId: string | undefined, find: (clientId: string) => Promise<T | null>): Promise<T | null> {
  return clientId ? find(clientId) : null;
}

/** Result of an idempotent create: the controller answers 201 when created, 200 when replayed. */
export interface Created<T> {
  created: boolean;
  data: T;
}
