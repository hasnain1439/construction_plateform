/**
 * Offline sync for equipment (Munshi app): pull tables and their serializers. Money keys only with
 * fields.rates (stripFields, like every other table). Push handlers live in sync.push.ts
 * (EQUIPMENT_RECEIVE, EQUIPMENT_LOSS_REPORT) and call the REST services.
 */
import { stripFields } from '../../core/auth/fieldStrip.js';
import type { Tx } from '../../core/db/withTenant.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { SyncRow, SyncScope, TableDef } from '../sync/sync.tables.js';
import { addDays } from '../labor/labor.shared.js';

const n = (d: { toFixed(n: number): string } | null) => (d === null ? null : Number(d.toFixed(3)));
const byIds = (ids?: string[]) => (ids ? { id: { in: ids } } : {});
const since = (sc: SyncScope, days: number) => dateOnly(addDays(sc.day, -days));

async function blindCount(tx: Tx, tenantId: string) {
  return (await tx.tenantSettings.findUnique({ where: { tenantId }, select: { blindCountEnabled: true } }))?.blindCountEnabled ?? true;
}

export const EQUIPMENT_TABLES: TableDef[] = [
  {
    name: 'equipment',
    sources: ['Equipment'],
    load: async (tx, sc, ids) =>
      (await tx.equipment.findMany({ where: { tenantId: sc.a.tenantId, ...byIds(ids) }, orderBy: { name: 'asc' } })).map((e) =>
        stripFields(
          {
            id: e.id,
            code: e.code,
            name: e.name,
            kind: e.kind,
            category: e.category,
            unit: e.unit,
            isActive: e.isActive,
            hireRatePaisaPerDay: e.hireRatePaisaPerDay.toString(),
            replacementValuePaisa: e.replacementValuePaisa.toString(),
          } as SyncRow,
          sc.viewer.fields,
          { rates: ['hireRatePaisaPerDay', 'replacementValuePaisa'] },
        ),
      ),
  },
  {
    // Per site location × equipment × rental (ids from SyncChange are location ids).
    name: 'equipment_stock',
    sources: ['EquipmentStock'],
    keyOf: (r) => String(r['locationId']),
    load: async (tx, sc, ids) => {
      const locationIds = ids ? ids.filter((i) => sc.siteIds.includes(i)) : sc.siteIds;
      if (!locationIds.length) return [];
      const groups = await tx.equipmentMovement.groupBy({ by: ['locationId', 'equipmentId', 'rentalId'], where: { tenantId: sc.a.tenantId, locationId: { in: locationIds } }, _sum: { quantity: true } });
      return groups.map((g) => ({
        id: `${g.locationId}:${g.equipmentId}:${g.rentalId ?? 'own'}`,
        locationId: g.locationId,
        equipmentId: g.equipmentId,
        rentalId: g.rentalId,
        quantity: n(g._sum.quantity) ?? 0,
      }));
    },
  },
  {
    name: 'equipment_transfers',
    sources: ['EquipmentTransfer'],
    load: async (tx, sc, ids) => {
      const blind = sc.viewer.role === 'MUNSHI' && (await blindCount(tx, sc.a.tenantId));
      const rows = await tx.equipmentTransfer.findMany({
        where: {
          tenantId: sc.a.tenantId,
          ...byIds(ids),
          AND: [{ OR: [{ toLocationId: { in: sc.siteIds } }, { fromLocationId: { in: sc.siteIds } }] }, { OR: [{ status: 'ON_THE_WAY' }, { sentAt: { gte: since(sc, 30) } }] }],
        },
        include: { fromLocation: { select: { name: true, projectId: true } }, toLocation: { select: { projectId: true } }, items: { orderBy: { sortOrder: 'asc' } } },
      });
      return rows.map((t) => {
        const hide = blind && t.status === 'ON_THE_WAY';
        return {
          id: t.id,
          number: t.number,
          kind: t.kind,
          status: t.status,
          fromLocationId: t.fromLocationId,
          toLocationId: t.toLocationId,
          projectId: t.toLocation.projectId ?? t.fromLocation.projectId,
          from: t.fromLocation.name,
          sentAt: t.sentAt.toISOString(),
          blindCount: hide,
          items: t.items.map((i) => ({
            id: i.id,
            equipmentId: i.equipmentId,
            rentalId: i.rentalId,
            ...(hide ? {} : { sentQty: n(i.sentQty) }),
            receivedQty: n(i.receivedQty),
            damagedQty: n(i.damagedQty),
            note: i.note,
          })),
        };
      });
    },
  },
  {
    name: 'equipment_rentals',
    sources: ['EquipmentRental'],
    load: async (tx, sc, ids) =>
      (
        await tx.equipmentRental.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, OR: [{ status: 'ACTIVE' }, { updatedAt: { gte: since(sc, 30) } }] },
          include: { supplier: { select: { name: true } }, items: { orderBy: { sortOrder: 'asc' } } },
        })
      ).map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        supplierName: r.supplier.name,
        projectId: r.projectId,
        locationId: r.locationId,
        startDate: formatDateOnly(r.startDate),
        expectedEndDate: r.expectedEndDate ? formatDateOnly(r.expectedEndDate) : null,
        items: r.items.map((i) => ({ id: i.id, equipmentId: i.equipmentId, qty: n(i.qty), returnedQty: n(i.returnedQty), missingQty: n(i.missingQty) })),
      })),
  },
  {
    name: 'equipment_losses',
    sources: ['EquipmentLoss'],
    load: async (tx, sc, ids) =>
      (
        await tx.equipmentLoss.findMany({
          where: { tenantId: sc.a.tenantId, ...byIds(ids), projectId: { in: sc.projectIds }, OR: [{ status: 'REPORTED' }, { reportedAt: { gte: since(sc, 60) } }] },
          orderBy: { reportedAt: 'desc' },
        })
      ).map((l) =>
        stripFields(
          {
            id: l.id,
            number: l.number,
            kind: l.kind,
            status: l.status,
            source: l.source,
            equipmentId: l.equipmentId,
            rentalId: l.rentalId,
            locationId: l.locationId,
            projectId: l.projectId,
            transferId: l.transferId,
            qty: n(l.qty),
            note: l.note,
            reportedAt: l.reportedAt.toISOString(),
            valuePaisa: l.valuePaisa.toString(),
          } as SyncRow,
          sc.viewer.fields,
          { rates: ['valuePaisa'] },
        ),
      ),
  },
];

export const EQUIPMENT_TABLE_PERMISSIONS: Record<string, string[]> = {
  equipment: ['equipment.view'],
  equipment_stock: ['equipment.view'],
  equipment_transfers: ['equipment.view'],
  equipment_rentals: ['equipment.view'],
  equipment_losses: ['equipment.view'],
};
