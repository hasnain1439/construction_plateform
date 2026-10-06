/** Caller + period helpers shared by approvals, dashboard, finance and reports. */
import { getCtx } from '../../core/context/requestContext.js';
import type { Tx } from '../../core/db/withTenant.js';
import { addDays, today } from '../billing/billing.shared.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { projectScope } from '../projects/access.js';

export interface ReadActor {
  tenantId: string;
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
  /** billing.view — owner money, receivables, company money KPIs */
  seesFinancials: boolean;
  /** profit.view — P&L */
  seesProfit: boolean;
  /** rates.view — material values */
  seesRates: boolean;
}

export function readActor(): ReadActor {
  const ctx = getCtx();
  return {
    tenantId: ctx.tenantId!,
    userId: ctx.userId!,
    role: ctx.role as ReadActor['role'],
    seesFinancials: ctx.permissions.includes('billing.view'),
    seesProfit: ctx.permissions.includes('profit.view'),
    seesRates: ctx.permissions.includes('rates.view'),
  };
}

export interface Period {
  from: string;
  to: string;
  /** [fromAt, toAt) in UTC for timestamp columns */
  fromAt: Date;
  toAt: Date;
}

/** Inclusive Karachi dates; default = the last 30 days. */
export function periodOf(q: { from?: string | undefined; to?: string | undefined }, defaultDays = 30): Period {
  const to = q.to ?? today();
  const from = q.from ?? addDays(to, -(defaultDays - 1));
  return { from, to, fromAt: pktDayStart(from), toAt: pktDayEnd(to) };
}

/** Projects the caller may see, in the given statuses. */
export function scopedProjects(tx: Tx, a: ReadActor, statuses: Array<'DRAFT' | 'ACTIVE' | 'CLOSEOUT' | 'HANDED_OVER' | 'CLOSED' | 'READ_ONLY'>, projectId?: string) {
  return tx.project.findMany({
    where: { tenantId: a.tenantId, ...projectScope(a), status: { in: statuses }, ...(projectId ? { id: projectId } : {}) },
    include: { client: { select: { id: true, name: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
}

export const percent = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1000n) / whole) / 10 : 0);
export const str = (v: bigint) => v.toString();
