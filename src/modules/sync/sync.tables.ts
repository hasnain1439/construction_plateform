/**
 * What a phone syncs, table by table: the caller's scope (assigned ACTIVE / CLOSEOUT projects —
 * every running project for the owner — their site stock locations and the caller's OWN cash
 * account) and one loader per table. Loaders always filter by scope (and a time window where
 * the spec has one) and return rows through the serializers in sync.serializers.ts.
 *
 * `sources` are the SyncChange table names that make a table change. `refresh` tables are
 * re-sent whole when any of their sources changed (they are small: own cash account, settings,
 * holidays); the others are loaded by the changed ids.
 */
import type { Tx } from '../../core/db/withTenant.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { totalsOf } from '../cashbook/cash.js';
import { addDays, today } from '../labor/labor.shared.js';
import * as S from './sync.serializers.js';

export interface SyncActor {
  tenantId: string;
  userId: string;
  role: 'THEKEDAR' | 'PM' | 'MUNSHI';
}

export interface SyncScope {
  a: SyncActor;
  viewer: S.SyncViewer;
  projectIds: string[];
  siteIds: string[];
  accountIds: string[];
  day: string;
}

export type SyncRow = { id: string } & Record<string, unknown>;

export interface TableDef {
  name: string;
  sources: string[];
  refresh?: boolean;
  /** Sent with full snapshots only (platform data without change tracking). */
  snapshotOnly?: boolean;
  load: (tx: Tx, sc: SyncScope, ids?: string[]) => Promise<SyncRow[]>;
}

const OPEN_STATUSES = ['ACTIVE', 'CLOSEOUT'] as const;

export async function syncScope(tx: Tx, a: SyncActor): Promise<SyncScope> {
  const projects = await tx.project.findMany({
    where: { tenantId: a.tenantId, status: { in: [...OPEN_STATUSES] }, ...(a.role === 'THEKEDAR' ? {} : { userAccess: { some: { userId: a.userId } } }) },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  const sites = await tx.stockLocation.findMany({ where: { tenantId: a.tenantId, type: 'SITE', projectId: { in: projectIds } }, select: { id: true } });
  const accounts = await tx.cashAccount.findMany({ where: { tenantId: a.tenantId, holderUserId: a.userId }, select: { id: true } });
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId: a.tenantId }, select: { blindCountEnabled: true } });
  return {
    a,
    viewer: { userId: a.userId, role: a.role, blindCount: settings?.blindCountEnabled ?? true },
    projectIds,
    siteIds: sites.map((s) => s.id),
    accountIds: accounts.map((x) => x.id),
    day: today(),
  };
}

const byIds = (ids?: string[]) => (ids ? { id: { in: ids } } : {});
const since = (sc: SyncScope, days: number) => dateOnly(addDays(sc.day, -days));

export const TABLES: TableDef[] = [
  {
    name: 'projects',
    sources: ['Project'],
    load: async (tx, sc, ids) =>
      (await tx.project.findMany({ where: { tenantId: sc.a.tenantId, id: { in: ids ? ids.filter((i) => sc.projectIds.includes(i)) : sc.projectIds } } })).map(S.serializeProject),
  },
  {
    name: 'stock_locations',
    sources: ['StockLocation'],
    load: async (tx, sc, ids) => (await tx.stockLocation.findMany({ where: { tenantId: sc.a.tenantId, id: { in: ids ? ids.filter((i) => sc.siteIds.includes(i)) : sc.siteIds } } })).map(S.serializeLocation),
  },
  {
    name: 'materials',
    sources: ['Material'],
    load: async (tx, sc, ids) => (await tx.material.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids) }, orderBy: { name: 'asc' } })).map(S.serializeMaterial),
  },
  {
    name: 'material_groups',
    sources: [],
    snapshotOnly: true,
    load: async (tx) => (await tx.materialGroup.findMany({ orderBy: { sortOrder: 'asc' } })).map(S.serializeMaterialGroup),
  },
  {
    name: 'suppliers',
    sources: [],
    snapshotOnly: true,
    load: async (tx, sc) => (await tx.supplier.findMany({ where: { tenantId: sc.a.tenantId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })).map(S.serializeSupplier),
  },
  {
    name: 'workers',
    sources: ['Worker'],
    load: async (tx, sc, ids) =>
      (
        await tx.worker.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), OR: [{ projectWorkers: { some: { projectId: { in: sc.projectIds } } } }, { createdById: sc.a.userId }] },
          orderBy: { name: 'asc' },
        })
      ).map(S.serializeWorker),
  },
  {
    name: 'project_workers',
    sources: ['ProjectWorker'],
    load: async (tx, sc, ids) => (await tx.projectWorker.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds } } })).map(S.serializeProjectWorker),
  },
  {
    name: 'subcontract_assignments',
    sources: ['SubcontractAssignment'],
    load: async (tx, sc, ids) =>
      (
        await tx.subcontractAssignment.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds } },
          include: { subcontractor: { select: { id: true, name: true, trade: true } } },
        })
      ).map((r) => S.serializeAssignment(r, sc.viewer)),
  },
  {
    name: 'attendance',
    sources: ['Attendance'],
    load: async (tx, sc, ids) =>
      (await tx.attendance.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, date: { gte: since(sc, 21) } } })).map(S.serializeAttendance),
  },
  {
    name: 'settlements',
    sources: ['WageSettlement'],
    load: async (tx, sc, ids) =>
      (
        await tx.wageSettlement.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, weekStart: { gte: since(sc, 56) } },
          include: { lines: true },
        })
      ).map(S.serializeSettlement),
  },
  {
    name: 'advances',
    sources: ['Advance'],
    load: async (tx, sc, ids) => (await tx.advance.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, date: { gte: since(sc, 90) } } })).map(S.serializeAdvance),
  },
  {
    name: 'work_measurements',
    sources: ['WorkMeasurement'],
    load: async (tx, sc, ids) =>
      (await tx.workMeasurement.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, date: { gte: since(sc, 90) } } })).map(S.serializeMeasurement),
  },
  {
    name: 'dispatches',
    sources: ['Dispatch'],
    load: async (tx, sc, ids) =>
      (
        await tx.dispatch.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), toLocationId: { in: sc.siteIds }, OR: [{ status: 'ON_THE_WAY' }, { dispatchedAt: { gte: since(sc, 30) } }] },
          include: { fromLocation: { select: { name: true } }, toLocation: { select: { projectId: true } }, items: { orderBy: { sortOrder: 'asc' } } },
        })
      ).map((d) => S.serializeDispatch(d, sc.viewer)),
  },
  {
    name: 'purchases',
    sources: ['Purchase'],
    load: async (tx, sc, ids) =>
      (
        await tx.purchase.findMany({
          where: {
            tenantId: sc.a.tenantId,
            ...byIds(ids),
            locationId: { in: sc.siteIds },
            OR: [{ status: { in: ['PENDING_RECEIPT', 'PENDING_RATE'] } }, { purchaseDate: { gte: since(sc, 30) } }],
          },
          include: { supplier: { select: { id: true, name: true } }, items: true },
        })
      ).map((p) => S.serializePurchase(p, sc.viewer)),
  },
  {
    name: 'owner_deliveries',
    sources: ['OwnerDelivery'],
    load: async (tx, sc, ids) =>
      (
        await tx.ownerDelivery.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, deliveryDate: { gte: since(sc, 30) } }, include: { items: true } })
      ).map(S.serializeOwnerDelivery),
  },
  {
    name: 'material_usage',
    sources: ['MaterialUsage'],
    load: async (tx, sc, ids) =>
      (await tx.materialUsage.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, usageDate: { gte: since(sc, 30) } }, include: { items: true } })).map(S.serializeUsage),
  },
  {
    name: 'site_stock',
    sources: ['SiteStock'],
    // ids here are location ids (stock movements are tracked per location).
    load: async (tx, sc, ids) => {
      const locationIds = ids ? ids.filter((i) => sc.siteIds.includes(i)) : sc.siteIds;
      if (!locationIds.length) return [];
      const groups = await tx.stockMovement.groupBy({ by: ['locationId', 'materialId', 'ownerSupplied'], where: { tenantId: sc.a.tenantId, locationId: { in: locationIds } }, _sum: { quantity: true } });
      const rows = new Map<string, { locationId: string; materialId: string; quantity: number; ownerQuantity: number }>();
      for (const g of groups) {
        const key = `${g.locationId}:${g.materialId}`;
        const r = rows.get(key) ?? { locationId: g.locationId, materialId: g.materialId, quantity: 0, ownerQuantity: 0 };
        const q = Number((g._sum.quantity ?? 0).toFixed(3));
        r.quantity = Math.round((r.quantity + q) * 1000) / 1000;
        if (g.ownerSupplied) r.ownerQuantity = Math.round((r.ownerQuantity + q) * 1000) / 1000;
        rows.set(key, r);
      }
      return [...rows.values()].map(S.serializeSiteStock);
    },
  },
  {
    name: 'stock_counts',
    sources: ['StockCount'],
    load: async (tx, sc, ids) =>
      (await tx.stockCount.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), locationId: { in: sc.siteIds }, countedAt: { gte: since(sc, 30) } }, include: { items: true } })).map(S.serializeStockCount),
  },
  {
    name: 'daily_logs',
    sources: ['DailyLog'],
    load: async (tx, sc, ids) =>
      (
        await tx.dailyLog.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, logDate: { gte: since(sc, 30) } },
          include: { createdBy: { select: { name: true } } },
        })
      ).map(S.serializeDailyLog),
  },
  {
    name: 'cash_accounts',
    sources: ['CashAccount', 'CashEntry', 'TopupRequest'],
    refresh: true,
    load: async (tx, sc) => {
      const accounts = await tx.cashAccount.findMany({ where: { tenantId: sc.a.tenantId, holderUserId: sc.a.userId } });
      const totals = await totalsOf(
        tx,
        sc.a.tenantId,
        accounts.map((x) => x.id),
      );
      return accounts.map((x) => S.serializeCashAccount(x, totals.get(x.id)!));
    },
  },
  {
    name: 'cash_entries',
    sources: ['CashEntry'],
    load: async (tx, sc, ids) => {
      const where: Prisma.CashEntryWhereInput = {
        tenantId: sc.a.tenantId,
        ...byIds(ids),
        accountId: { in: sc.accountIds },
        OR: [{ occurredAt: { gte: since(sc, 60) } }, { status: { in: ['PENDING_ACK', 'PENDING_APPROVAL'] } }],
      };
      return (await tx.cashEntry.findMany({ where, orderBy: { occurredAt: 'desc' } })).map(S.serializeCashEntry);
    },
  },
  {
    name: 'topup_requests',
    sources: ['TopupRequest'],
    load: async (tx, sc, ids) =>
      (
        await tx.topupRequest.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), accountId: { in: sc.accountIds }, OR: [{ createdAt: { gte: since(sc, 60) } }, { status: 'PENDING' }] },
        })
      ).map(S.serializeTopup),
  },
  {
    name: 'settings',
    sources: ['TenantSettings'],
    refresh: true,
    load: async (tx, sc) => [S.serializeSettings(sc.a.tenantId, await tx.tenantSettings.findUnique({ where: { tenantId: sc.a.tenantId } }))],
  },
  {
    name: 'holidays',
    sources: ['CompanyHoliday'],
    refresh: true,
    load: async (tx, sc) => {
      const from = since(sc, 60);
      const platform = await tx.platformHoliday.findMany({ where: { startDate: { gte: from } } });
      const company = await tx.companyHoliday.findMany({ where: { tenantId: sc.a.tenantId, startDate: { gte: from } } });
      return [...platform.map((h) => S.serializeHoliday(h, 'PLATFORM')), ...company.map((h) => S.serializeHoliday(h, 'COMPANY'))];
    },
  },
  {
    name: 'notifications',
    sources: ['Notification'],
    load: async (tx, sc, ids) =>
      (await tx.notification.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids), userId: sc.a.userId, createdAt: { gte: since(sc, 30) } }, orderBy: { createdAt: 'desc' } })).map(S.serializeNotification),
  },
];
