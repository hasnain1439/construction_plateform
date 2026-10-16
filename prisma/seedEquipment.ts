/**
 * Demo equipment & shuttering for Malik & Sons (Phase 3 · Step 16). Idempotent: skipped when the
 * company already has equipment. Everything goes through the real services, so the ledger,
 * transfers, rental, supplier ledger, losses and daily charges are what the API would write.
 *
 * Timeline (relative to today): opening stock at the yard (45 days ago) → ET-0001 to DHA
 * (30 days ago, counted by Rafaqat) → ET-0002 to Johar Town (20 days ago, counted by Bilal) →
 * RNT-0001: 150 props from Punjab Shuttering Yard to DHA (15 days ago, Rs 20,000 deposit) →
 * EL-0001: 6 plates missing at DHA (5 days ago, waiting for the owner) → hire / rent posted
 * through yesterday.
 */
import type { Tx } from '../src/core/db/withTenant.js';
import { todayIn } from '../src/core/utils/dates.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { runAccrualTx } from '../src/modules/equipment/accrual.js';
import { createEquipmentTx, stockInTx } from '../src/modules/equipment/equipment.service.js';
import { reportLossTx } from '../src/modules/equipment/losses.service.js';
import { createRentalTx } from '../src/modules/equipment/rentals.service.js';
import { createTransferTx, receiveTransferTx } from '../src/modules/equipment/transfers.service.js';
import { D, type Actor } from '../src/modules/inventory/stock.js';
import { addDays } from '../src/modules/labor/labor.shared.js';

const rs = (rupees: number) => BigInt(Math.round(rupees * 100));
const DAY = 86_400_000;

export interface EquipmentSeedInput {
  tenantId: string;
  ownerId: string;
  bilalId: string;
  rafaqatId: string;
  projects: { dha: { id: string }; johar: { id: string } };
}

export async function seedMalikEquipment(db: PrismaClient, s: EquipmentSeedInput, now = new Date()): Promise<{ skipped: boolean }> {
  if ((await db.equipment.count({ where: { tenantId: s.tenantId } })) > 0) return { skipped: true };
  const khalid: Actor = { tenantId: s.tenantId, userId: s.ownerId, role: 'THEKEDAR', seesRates: true, seesFinancials: true };
  const bilal: Actor = { tenantId: s.tenantId, userId: s.bilalId, role: 'PM', seesRates: true, seesFinancials: false };
  const rafaqat: Actor = { tenantId: s.tenantId, userId: s.rafaqatId, role: 'MUNSHI', seesRates: false, seesFinancials: false };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => db.$transaction(fn, { timeout: 60_000 });
  const ago = (days: number, hourPkt = 10) => {
    const d = todayIn('Asia/Karachi', new Date(now.getTime() - days * DAY));
    return new Date(`${d}T${String(hourPkt - 5).padStart(2, '0')}:00:00.000Z`);
  };
  const today = todayIn('Asia/Karachi', now);

  const add = (input: Parameters<typeof createEquipmentTx>[2]) => run((tx) => createEquipmentTx(tx, khalid, input));
  const plates = await add({ name: 'Steel shuttering plate 2×3 ft', code: 'SP-23', kind: 'BULK', category: 'SHUTTERING_PLATE', hireRatePaisaPerDay: rs(5), replacementValuePaisa: rs(4500), coverageSqftPerUnit: D(6) });
  const props = await add({ name: 'Steel prop (adjustable 10–12 ft)', code: 'PR-01', kind: 'BULK', category: 'PROP', hireRatePaisaPerDay: rs(10), replacementValuePaisa: rs(3500) });
  const mixer = await add({ name: 'Concrete mixer 1 bag (diesel)', code: 'MX-01', kind: 'MACHINE', category: 'MIXER', serialNo: 'KM-77812', hireRatePaisaPerDay: rs(2500), replacementValuePaisa: rs(450000) });
  const vibrator = await add({ name: 'Needle vibrator (petrol)', code: 'VB-01', kind: 'MACHINE', category: 'VIBRATOR', serialNo: 'HV-2231', hireRatePaisaPerDay: rs(800), replacementValuePaisa: rs(65000) });

  // Opening stock at the yard (Central Store)
  for (const [e, qty] of [[plates, 400], [props, 100], [mixer, 1], [vibrator, 1]] as const) {
    await run((tx) => stockInTx(tx, khalid, e.id, { qty: D(qty), type: 'OPENING', note: 'Yard count when the app started' }, { at: ago(45, 9) }));
  }
  const store = await db.stockLocation.findFirstOrThrow({ where: { tenantId: s.tenantId, systemKey: 'CENTRAL_STORE' } });

  // ET-0001: plates, props, mixer and vibrator to DHA — counted by Rafaqat
  const toDha = await run((tx) =>
    createTransferTx(
      tx,
      khalid,
      {
        fromLocationId: store.id,
        toProjectId: s.projects.dha.id,
        vehicleNo: 'LES-4521',
        driverName: 'Nadeem',
        note: 'Ground floor slab shuttering',
        items: [
          { equipmentId: plates.id, qty: D(250) },
          { equipmentId: props.id, qty: D(60) },
          { equipmentId: mixer.id, qty: D(1) },
          { equipmentId: vibrator.id, qty: D(1) },
        ],
      },
      { at: ago(30, 8) },
    ),
  );
  await run((tx) => receiveTransferTx(tx, rafaqat, toDha.id, { items: toDha.items.map((i) => ({ itemId: i.id, receivedQty: D(i.sentQty!) })) }, { at: ago(30, 12) }));

  // ET-0002: plates to Johar Town — counted by Bilal
  const toJohar = await run((tx) =>
    createTransferTx(tx, khalid, { fromLocationId: store.id, toProjectId: s.projects.johar.id, vehicleNo: 'LEB-1180', driverName: 'Shaukat', items: [{ equipmentId: plates.id, qty: D(130) }] }, { at: ago(20, 8) }),
  );
  await run((tx) => receiveTransferTx(tx, bilal, toJohar.id, { items: toJohar.items.map((i) => ({ itemId: i.id, receivedQty: D(i.sentQty!) })) }, { at: ago(20, 13) }));

  // RNT-0001: 150 props from Punjab Shuttering Yard to DHA (Rs 15 / prop / day, Rs 20,000 deposit)
  const yard = await db.supplier.findUniqueOrThrow({ where: { tenantId_name: { tenantId: s.tenantId, name: 'Punjab Shuttering Yard' } } });
  await db.supplier.update({ where: { id: yard.id }, data: { isActive: true } });
  await run((tx) =>
    createRentalTx(tx, khalid, {
      supplierId: yard.id,
      projectId: s.projects.dha.id,
      startDate: addDays(today, -15),
      expectedEndDate: addDays(today, 10),
      depositPaisa: rs(20000),
      reference: 'PSY-2231',
      note: 'First floor slab — owned props not enough',
      items: [{ equipmentId: props.id, qty: D(150), ratePaisaPerDay: rs(15) }],
    }),
  );

  // EL-0001: 6 plates missing at DHA after de-shuttering (reported by Rafaqat, not charged yet)
  await run((tx) =>
    reportLossTx(tx, rafaqat, { projectId: s.projects.dha.id, equipmentId: plates.id, kind: 'MISSING', qty: D(6), note: '6 plates not found after the GF slab de-shuttering' }, { at: ago(5, 17) }),
  );

  // Internal hire and rent through yesterday → project P&L bucket EQUIPMENT
  await run((tx) => runAccrualTx(tx, s.tenantId));
  return { skipped: false };
}
