/**
 * Daily idle-rent alert (Step 16, 09:00 Asia/Karachi): for every company with an ACTIVE rental, rented
 * units at a site with no milestone activity for `equipmentIdleDays` days → EQUIPMENT_IDLE to the
 * holders of equipment.rental.manage for the project + its PMs (dedupe per rental per week).
 * Cross-tenant, so it runs as prismaAdmin like the other jobs; every query in runIdleCheckTx filters
 * by tenantId explicitly.
 */
import { prismaAdmin } from '../core/db/prisma.js';
import { runIdleCheckTx } from '../modules/equipment/idle.js';

export async function runEquipmentIdleCheck(now = new Date()): Promise<{ companies: number; idle: number; notified: number }> {
  const tenants = await prismaAdmin.equipmentRental.findMany({ where: { status: 'ACTIVE' }, distinct: ['tenantId'], select: { tenantId: true } });
  let idle = 0;
  let notified = 0;
  for (const { tenantId } of tenants) {
    const r = await prismaAdmin.$transaction((tx) => runIdleCheckTx(tx, tenantId, now), { timeout: 120_000 });
    idle += r.idle;
    notified += r.notified.length;
  }
  return { companies: tenants.length, idle, notified };
}
