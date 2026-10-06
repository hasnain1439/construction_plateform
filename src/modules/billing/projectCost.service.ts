/**
 * What a project has cost the contractor so far (cash basis). One place for the rule — the
 * receivables "own money invested", the dashboard and the project P&L all use it.
 *
 *   material   contractor stock that reached the site (RECEIPT_IN from the store + direct
 *              PURCHASE_IN, less returns) at the value it carried — owner-supplied stock is 0
 *   wages      weekly settlement lines paid
 *   advances   peshgi given (workers and sub-contractors)
 *   subcontract running payments + retention released to sub-contractors
 *   kharcha    site cash expenses, except owner-recoverable and rejected ones
 *   losses     shortages written off (ACCEPT_LOSS)
 *
 * Every amount is one row of `costRows` (project × month × source), read in a single query.
 * P&L buckets regroup the same rows, so they always add up to the total:
 *   MATERIALS      material + kharcha marked MATERIAL (urgent material)
 *   LABOR_WAGES    wages + worker peshgi + kharcha marked LABOR (unloading)
 *   SUBCONTRACT    sub-contract payments + sub-contractor advances
 *   SITE_OVERHEAD  other kharcha (tea / water, transport, other)
 *   EQUIPMENT      kharcha marked EQUIPMENT (fuel, repairs, small tools)
 *   LOSSES         written-off shortages
 */
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';

export interface ProjectCost {
  materialPaisa: bigint;
  wagesPaisa: bigint;
  advancesPaisa: bigint;
  subcontractPaisa: bigint;
  kharchaPaisa: bigint;
  lossesPaisa: bigint;
  totalPaisa: bigint;
}

export const COST_SOURCES = [
  'MATERIAL',
  'WAGES',
  'ADVANCE_WORKER',
  'ADVANCE_SUBCONTRACTOR',
  'SUBCONTRACT',
  'KHARCHA_OVERHEAD',
  'KHARCHA_LABOR',
  'KHARCHA_MATERIAL',
  'KHARCHA_EQUIPMENT',
  'LOSSES',
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const PNL_BUCKETS = ['MATERIALS', 'LABOR_WAGES', 'SUBCONTRACT', 'SITE_OVERHEAD', 'EQUIPMENT', 'LOSSES'] as const;
export type PnlBucket = (typeof PNL_BUCKETS)[number];

export const BUCKET_OF: Record<CostSource, PnlBucket> = {
  MATERIAL: 'MATERIALS',
  KHARCHA_MATERIAL: 'MATERIALS',
  WAGES: 'LABOR_WAGES',
  ADVANCE_WORKER: 'LABOR_WAGES',
  KHARCHA_LABOR: 'LABOR_WAGES',
  SUBCONTRACT: 'SUBCONTRACT',
  ADVANCE_SUBCONTRACTOR: 'SUBCONTRACT',
  KHARCHA_OVERHEAD: 'SITE_OVERHEAD',
  KHARCHA_EQUIPMENT: 'EQUIPMENT',
  LOSSES: 'LOSSES',
};

export interface CostRow {
  projectId: string;
  /** YYYY-MM (Asia/Karachi) */
  month: string;
  source: CostSource;
  amountPaisa: bigint;
}

/**
 * Cost rows for some projects (default: all), optionally within [from, to) — grouped by
 * project, Karachi month and source. Dates: movement / payment / entry time; wages use the
 * paid time (or the week end); peshgi its date; losses when they were written off.
 */
export async function costRows(tx: Tx, tenantId: string, opts: { projectIds?: string[]; from?: Date; to?: Date } = {}): Promise<CostRow[]> {
  if (opts.projectIds && !opts.projectIds.length) return [];
  const where = Prisma.join(
    [
      Prisma.sql`r.project IS NOT NULL`,
      opts.projectIds ? Prisma.sql`r.project = ANY(${opts.projectIds}::uuid[])` : Prisma.sql`TRUE`,
      opts.from ? Prisma.sql`r.at >= ${opts.from}` : Prisma.sql`TRUE`,
      opts.to ? Prisma.sql`r.at < ${opts.to}` : Prisma.sql`TRUE`,
    ],
    ' AND ',
  );
  const rows = await tx.$queryRaw<Array<{ project: string; month: string; source: CostSource; amount: bigint }>>`
    WITH r AS (
      SELECT l."projectId" AS project, m."occurredAt" AS at, 'MATERIAL' AS source, m."valuePaisa" AS amount
        FROM "StockMovement" m JOIN "StockLocation" l ON l.id = m."locationId"
       WHERE m."tenantId" = ${tenantId}::uuid AND l.type = 'SITE' AND m."ownerSupplied" = false
         AND m.type IN ('RECEIPT_IN', 'PURCHASE_IN', 'PURCHASE_RETURN_OUT')
      UNION ALL
      SELECT s."projectId", COALESCE(x."paidAt", s."weekEnd"::timestamptz), 'WAGES', x."netPaisa"
        FROM "WageSettlementLine" x JOIN "WageSettlement" s ON s.id = x."settlementId"
       WHERE x."tenantId" = ${tenantId}::uuid AND x."paymentStatus" = 'PAID'
      UNION ALL
      SELECT a."projectId", a.date::timestamptz, CASE WHEN a."payeeType" = 'WORKER' THEN 'ADVANCE_WORKER' ELSE 'ADVANCE_SUBCONTRACTOR' END, a."amountPaisa"
        FROM "Advance" a
       WHERE a."tenantId" = ${tenantId}::uuid
      UNION ALL
      SELECT g."projectId", e."occurredAt", 'SUBCONTRACT', -e."amountPaisa"
        FROM "SubcontractLedgerEntry" e JOIN "SubcontractAssignment" g ON g.id = e."assignmentId"
       WHERE e."tenantId" = ${tenantId}::uuid AND e.type IN ('RUNNING_PAYMENT', 'RETENTION_RELEASE')
      UNION ALL
      SELECT c."projectId", c."occurredAt",
             CASE c."costBucket" WHEN 'LABOR' THEN 'KHARCHA_LABOR' WHEN 'MATERIAL' THEN 'KHARCHA_MATERIAL' WHEN 'EQUIPMENT' THEN 'KHARCHA_EQUIPMENT' ELSE 'KHARCHA_OVERHEAD' END,
             -c."amountPaisa"
        FROM "CashEntry" c
       WHERE c."tenantId" = ${tenantId}::uuid AND c.type = 'EXPENSE' AND c.status <> 'REJECTED'
         AND (c."costBucket" IS NULL OR c."costBucket" <> 'RECOVERABLE_FROM_OWNER')
      UNION ALL
      SELECT sh."projectId", COALESCE(sh."resolvedAt", sh."createdAt"), 'LOSSES', sh."valuePaisa"
        FROM "Shortage" sh
       WHERE sh."tenantId" = ${tenantId}::uuid AND sh.resolution = 'ACCEPT_LOSS'
    )
    SELECT r.project, to_char(r.at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM') AS month, r.source, SUM(r.amount)::bigint AS amount
      FROM r
     WHERE ${where}
     GROUP BY 1, 2, 3`;
  return rows.map((r) => ({ projectId: r.project, month: r.month, source: r.source, amountPaisa: BigInt(r.amount) }));
}

const emptyCost = (): ProjectCost => ({ materialPaisa: 0n, wagesPaisa: 0n, advancesPaisa: 0n, subcontractPaisa: 0n, kharchaPaisa: 0n, lossesPaisa: 0n, totalPaisa: 0n });

const FIELD_OF: Record<CostSource, keyof Omit<ProjectCost, 'totalPaisa'>> = {
  MATERIAL: 'materialPaisa',
  WAGES: 'wagesPaisa',
  ADVANCE_WORKER: 'advancesPaisa',
  ADVANCE_SUBCONTRACTOR: 'advancesPaisa',
  SUBCONTRACT: 'subcontractPaisa',
  KHARCHA_OVERHEAD: 'kharchaPaisa',
  KHARCHA_LABOR: 'kharchaPaisa',
  KHARCHA_MATERIAL: 'kharchaPaisa',
  KHARCHA_EQUIPMENT: 'kharchaPaisa',
  LOSSES: 'lossesPaisa',
};

export function costOf(rows: CostRow[]): ProjectCost {
  const c = emptyCost();
  for (const r of rows) {
    c[FIELD_OF[r.source]] += r.amountPaisa;
    c.totalPaisa += r.amountPaisa;
  }
  return c;
}

export function bucketsOf(rows: CostRow[]): Record<PnlBucket, bigint> {
  const b = Object.fromEntries(PNL_BUCKETS.map((k) => [k, 0n])) as Record<PnlBucket, bigint>;
  for (const r of rows) b[BUCKET_OF[r.source]] += r.amountPaisa;
  return b;
}

/** Cost per project (one query for all of them). */
export async function projectCosts(tx: Tx, tenantId: string, projectIds: string[], range: { from?: Date; to?: Date } = {}): Promise<Map<string, { cost: ProjectCost; rows: CostRow[] }>> {
  const rows = await costRows(tx, tenantId, { projectIds, ...range });
  return new Map(
    projectIds.map((id) => {
      const mine = rows.filter((r) => r.projectId === id);
      return [id, { cost: costOf(mine), rows: mine }];
    }),
  );
}

export async function projectCost(tx: Tx, tenantId: string, projectId: string): Promise<ProjectCost> {
  return costOf(await costRows(tx, tenantId, { projectIds: [projectId] }));
}

export const costDto = (c: ProjectCost) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.toString()])) as Record<keyof ProjectCost, string>;
export const bucketsDto = (b: Record<PnlBucket, bigint>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toString()])) as Record<PnlBucket, string>;
