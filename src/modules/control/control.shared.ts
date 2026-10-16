/**
 * Step 14 · control — shared pieces: the caller, project access (control.view in scope), money
 * visibility, company thresholds and small number helpers.
 *
 * Money visibility (keys are LEFT OUT, never null, without the field permission):
 *   material variance rates / PKR impact      fields.rates
 *   cost variance (actual cost + estimate)    fields.amounts + fields.rates
 *   burn rate cost                            fields.amounts (contract value: fields.contract; spent % of contract: both)
 *   projected margin                          fields.amounts + fields.rates + fields.contract + fields.profit
 */
import { assertPerm, fieldAccess, type FieldAccess } from '../../core/auth/access.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import type { Tx } from '../../core/db/withTenant.js';
import { todayIn } from '../../core/utils/dates.js';
import type { Prisma, Project } from '../../generated/prisma/client.js';
import { findProjectFor } from '../projects/access.js';

export const CONTROL_VIEW = 'control.view';
export const CONTROL_MANAGE = 'control.manage';
export const today = () => todayIn('Asia/Karachi');

export interface ControlCaller {
  tenantId: string;
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
  fields: FieldAccess;
}

export function controlCaller(): ControlCaller {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId!, role: ctx.role as ControlCaller['role'], fields: fieldAccess() };
}

/** The project, if the caller holds control.view with it in scope (403 / 404). */
export async function controlProject(tx: Tx, c: ControlCaller, projectId: string): Promise<Project> {
  assertPerm(CONTROL_VIEW, c);
  return findProjectFor(tx, c, projectId, CONTROL_VIEW);
}

export interface MoneyView {
  /** material rates / PKR impact */
  rates: boolean;
  /** cost variance money (actual + estimate) */
  cost: boolean;
  /** burn-rate cost */
  amounts: boolean;
  contract: boolean;
  /** spent % of contract, gap points */
  spent: boolean;
  /** projected margin */
  margin: boolean;
}

export function moneyView(f: FieldAccess): MoneyView {
  return {
    rates: f.rates,
    cost: f.amounts && f.rates,
    amounts: f.amounts,
    contract: f.contract,
    spent: f.amounts && f.contract,
    margin: f.amounts && f.rates && f.contract && f.profit,
  };
}

/** Field permissions of a recipient (alert engine) as a FieldAccess. */
export const ALL_FIELDS: FieldAccess = { rates: true, amounts: true, profit: true, contract: true };

// ─── Thresholds ─────────────────────────────────────────────────────────────

export interface ControlSettings {
  overuseAlertPercent: number;
  behindPlanAlertPoints: number;
  lateFinishGraceDays: number;
  quotaAlertPercent: number;
  spendAheadAlertPoints: number;
  controlAlertsEnabled: boolean;
}

export const DEFAULT_CONTROL_SETTINGS: ControlSettings = {
  overuseAlertPercent: 10,
  behindPlanAlertPoints: 15,
  lateFinishGraceDays: 3,
  quotaAlertPercent: 100,
  spendAheadAlertPoints: 10,
  controlAlertsEnabled: true,
};

export async function controlSettings(tx: Tx, tenantId: string): Promise<ControlSettings> {
  const s = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { overuseAlertPercent: true, behindPlanAlertPoints: true, lateFinishGraceDays: true, quotaAlertPercent: true, spendAheadAlertPoints: true, controlAlertsEnabled: true },
  });
  return s ?? { ...DEFAULT_CONTROL_SETTINGS };
}

// ─── Numbers ────────────────────────────────────────────────────────────────

/** Quantity, 3 dp. */
export const q3 = (n: number) => Math.round(n * 1000) / 1000;
/** Percentage, 1 dp. */
export const p1 = (n: number) => Math.round(n * 10) / 10;
export const str = (v: bigint) => v.toString();
/** Whole paisa of a (possibly fractional) number. */
export const paisaOf = (n: number): bigint => BigInt(Math.round(n));
/** part ÷ whole × 100 (1 dp), null when whole is 0. */
export const pctOf = (part: number, whole: number): number | null => (whole > 0 ? p1((part / whole) * 100) : null);
export const bigPct = (part: bigint, whole: bigint): number | null => (whole > 0n ? Number((part * 10000n) / whole) / 100 : null);

export const ref = (p: Pick<Project, 'id' | 'code' | 'name'>) => ({ id: p.id, code: p.code, name: p.name });

export const audit = (tx: Tx, c: Pick<ControlCaller, 'tenantId' | 'userId'>, action: string, entityType: string, entityId: string, details: Prisma.InputJsonValue) =>
  writeAudit(tx, { tenantId: c.tenantId, actorType: 'USER', actorId: c.userId, action, entityType, entityId, details });
