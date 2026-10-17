/**
 * Step 16 part 2 demo for Malik & Sons (after the equipment and schedule demos):
 *   RNT-0002 — 100 props from Punjab Shuttering Yard to Johar Town 12 days ago (Rs 15 / prop / day,
 *   "slab next week"), but Johar Town has no milestone work since → idle 12 days ≥ 5 → the idle-rent
 *   alert (EQUIPMENT_IDLE to Khalid with the daily rent; Bilal is Johar's PM).
 * With the DHA schedule (first-floor slab running) the shuttering planner shows a plate / prop shortfall
 * at DHA, suggests moving Johar's plates, renting the rest and returning RNT-0002.
 * Idempotent: skipped without the equipment demo or when Johar Town already has a rental.
 */
import type { Tx } from '../src/core/db/withTenant.js';
import { todayIn } from '../src/core/utils/dates.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { runAccrualTx } from '../src/modules/equipment/accrual.js';
import { runIdleCheckTx } from '../src/modules/equipment/idle.js';
import { createRentalTx } from '../src/modules/equipment/rentals.service.js';
import { D, type Actor } from '../src/modules/inventory/stock.js';
import { addDays } from '../src/modules/labor/labor.shared.js';

export interface ShutteringSeedInput {
  tenantId: string;
  ownerId: string;
  projects: { johar: { id: string } };
}

export async function seedMalikShuttering(db: PrismaClient, s: ShutteringSeedInput, now = new Date()): Promise<{ skipped: boolean }> {
  const props = await db.equipment.findFirst({ where: { tenantId: s.tenantId, code: 'PR-01' } });
  if (!props) return { skipped: true };
  if (await db.equipmentRental.count({ where: { tenantId: s.tenantId, projectId: s.projects.johar.id } })) return { skipped: true };
  const yard = await db.supplier.findUnique({ where: { tenantId_name: { tenantId: s.tenantId, name: 'Punjab Shuttering Yard' } } });
  if (!yard) return { skipped: true };
  const khalid: Actor = { tenantId: s.tenantId, userId: s.ownerId, role: 'THEKEDAR', seesRates: true, seesFinancials: true };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => db.$transaction(fn, { timeout: 60_000 });
  const today = todayIn('Asia/Karachi', now);

  await run((tx) =>
    createRentalTx(tx, khalid, {
      supplierId: yard.id,
      projectId: s.projects.johar.id,
      startDate: addDays(today, -12),
      expectedEndDate: addDays(today, 18),
      depositPaisa: 1500000n,
      reference: 'PSY-2290',
      note: 'Ground floor slab next week — owner payment pending',
      items: [{ equipmentId: props.id, qty: D(100), ratePaisaPerDay: 1500n }],
    }),
  );
  await run((tx) => runAccrualTx(tx, s.tenantId));
  await run((tx) => runIdleCheckTx(tx, s.tenantId, now));
  return { skipped: false };
}
