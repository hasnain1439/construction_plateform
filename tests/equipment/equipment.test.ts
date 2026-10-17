import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { bucketsOf, costRows } from '../../src/modules/billing/projectCost.service.js';
import { addDays } from '../../src/modules/labor/labor.shared.js';
import { bearer, loginMunshi, useFreshDatabase, withSeedSnapshot } from '../helpers.js';
import { api, attachment, owner, pm, type Auth } from '../inventory/fixtures.js';
import { todayIn } from '../../src/core/utils/dates.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  await withSeedSnapshot('malik_equipment', seeded());
});

const today = () => todayIn('Asia/Karachi');
const yesterday = () => addDays(today(), -1);
const tenant = () => seeded().malik.id;
const dha = () => seeded().projects.dha.id;
const johar = () => seeded().projects.johar.id;
const munshi = async (): Promise<Auth> => bearer((await loginMunshi(tenant())).accessToken);

const eq = async (code: string) => prismaAdmin.equipment.findFirstOrThrow({ where: { tenantId: tenant(), code } });
const store = async () => prismaAdmin.stockLocation.findFirstOrThrow({ where: { tenantId: tenant(), systemKey: 'CENTRAL_STORE' } });
const site = async (projectId: string) => prismaAdmin.stockLocation.findFirstOrThrow({ where: { tenantId: tenant(), projectId } });
async function balance(locationId: string, equipmentId: string, rentalId: string | null = null) {
  const agg = await prismaAdmin.equipmentMovement.aggregate({ where: { tenantId: tenant(), locationId, equipmentId, rentalId }, _sum: { quantity: true } });
  return Number(agg._sum.quantity ?? 0);
}
const charges = async (where: Record<string, unknown>) =>
  (await prismaAdmin.equipmentCharge.aggregate({ where: { tenantId: tenant(), ...where }, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0n;
const pnlBuckets = async (projectId: string) => bucketsOf(await prismaAdmin.$transaction((tx) => costRows(tx, tenant(), { projectIds: [projectId] })));

/** Every key anywhere in a payload. */
function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (out.add(k), keys(v, out));
  return out;
}
const MONEY = /Paisa/;

describe('equipment seed + allocation map', () => {
  it('balances per location follow the ledger; totals; internal hire + rent are in the DHA P&L EQUIPMENT bucket', async () => {
    const auth = await owner();
    const plates = await eq('SP-23');
    const props = await eq('PR-01');
    const yard = await store();
    const dhaSite = await site(dha());
    expect(await balance(yard.id, plates.id)).toBe(20);
    expect(await balance(dhaSite.id, plates.id)).toBe(244); // 250 sent, 6 reported missing
    expect(await balance((await site(johar())).id, plates.id)).toBe(130);
    const rental = await prismaAdmin.equipmentRental.findFirstOrThrow({ where: { tenantId: tenant() } });
    expect(await balance(dhaSite.id, props.id, rental.id)).toBe(150);

    const map = await api().get('/api/v1/equipment/balances').set(auth);
    expect(map.status).toBe(200);
    const dhaRow = map.body.data.locations.find((l: { location: { id: string } }) => l.location.id === dhaSite.id);
    expect(dhaRow.items.find((i: { equipment: { code: string } }) => i.equipment.code === 'PR-01')).toMatchObject({ ownedQty: 60, rentedQty: 150, totalQty: 210, rentals: [{ number: 'RNT-0001', qty: 150 }] });
    expect(map.body.data.totals.find((t: { equipment: { code: string } }) => t.equipment.code === 'SP-23')).toMatchObject({ ownedQty: 394, atYardQty: 20, atSitesQty: 374, inTransitQty: 0 });

    const list = await api().get('/api/v1/equipment').set(auth);
    expect(list.body.data.find((e: { code: string }) => e.code === 'SP-23')).toMatchObject({ ownedQty: 394, hireRatePaisaPerDay: '500', replacementValuePaisa: '450000' });

    // DHA: 25 days × 250 plates + 5 days × 244 plates at Rs 5, 30 days × 60 props at Rs 10, mixer Rs 2,500 and vibrator Rs 800 × 30 days
    const dhaHire = 25n * 250n * 500n + 5n * 244n * 500n + 30n * 60n * 1000n + 30n * 250000n + 30n * 80000n;
    expect(await charges({ projectId: dha(), kind: 'INTERNAL_HIRE' })).toBe(dhaHire);
    expect(await charges({ projectId: johar(), kind: 'INTERNAL_HIRE' })).toBe(20n * 130n * 500n);
    expect(await charges({ projectId: dha(), kind: 'RENTAL' })).toBe(15n * 150n * 1500n);
    expect((await pnlBuckets(dha())).EQUIPMENT).toBe(dhaHire + 15n * 150n * 1500n);

    const pnl = await api().get('/api/v1/finance/pnl').set(auth).query({ projectId: dha() });
    expect(pnl.status).toBe(200);
    expect(pnl.body.data.projects[0].cost.EQUIPMENT).toBe((dhaHire + 15n * 150n * 1500n).toString());

    const onSite = await api().get(`/api/v1/projects/${dha()}/equipment`).set(auth);
    expect(onSite.status).toBe(200);
    expect(onSite.body.data.rentals).toHaveLength(1);
    expect(onSite.body.data.openLosses).toHaveLength(1);
    expect(onSite.body.data.hireToDatePaisa).toBe(dhaHire.toString());
  });

  it('accrual run is idempotent (a second run posts nothing); today cannot be charged', async () => {
    const auth = await owner();
    const again = await api().post('/api/v1/equipment/accruals/run').set(auth).send({});
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ through: yesterday(), internalHire: { rows: 0, amountPaisa: '0' }, rental: { rows: 0, amountPaisa: '0' } });
    const todayRun = await api().post('/api/v1/equipment/accruals/run').set(auth).send({ through: today() });
    expect(todayRun.status).toBe(400);
    expect(todayRun.body.error.code).toBe('DATE_NOT_COMPLETE');
  });
});

describe('transfers', () => {
  it('yard → site goes through transit; receive with a gap creates MISSING + DAMAGED losses', async () => {
    const auth = await owner();
    const plates = await eq('SP-23');
    const yard = await store();
    const joharSite = await site(johar());
    const sent = await api().post('/api/v1/equipment/transfers').set(auth).send({ fromLocationId: yard.id, toProjectId: johar(), items: [{ equipmentId: plates.id, qty: 15 }] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.data).toMatchObject({ kind: 'DISPATCH', status: 'ON_THE_WAY' });
    const transit = await prismaAdmin.stockLocation.findFirstOrThrow({ where: { tenantId: tenant(), systemKey: 'TRANSIT' } });
    expect(await balance(yard.id, plates.id)).toBe(5);
    expect(await balance(transit.id, plates.id)).toBe(15);

    const tooMany = await api().post('/api/v1/equipment/transfers').set(auth).send({ fromLocationId: yard.id, toProjectId: johar(), items: [{ equipmentId: plates.id, qty: 6 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatchObject({ code: 'INSUFFICIENT_EQUIPMENT', details: { available: 5 } });

    const itemId = sent.body.data.items[0].id;
    const noNote = await api().post(`/api/v1/equipment/transfers/${sent.body.data.id}/receive`).set(await pm()).send({ items: [{ itemId, receivedQty: 12 }] });
    expect(noNote.body.error.code).toBe('NOTE_REQUIRED');
    const got = await api()
      .post(`/api/v1/equipment/transfers/${sent.body.data.id}/receive`)
      .set(await pm())
      .send({ items: [{ itemId, receivedQty: 12, damagedQty: 1, note: '3 short, 1 bent' }] });
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.data).toMatchObject({ status: 'RECEIVED_WITH_GAP', items: [{ sentQty: 15, receivedQty: 12, damagedQty: 1, gapQty: 3 }] });
    expect(await balance(transit.id, plates.id)).toBe(0);
    expect(await balance(joharSite.id, plates.id)).toBe(142);
    const losses = await prismaAdmin.equipmentLoss.findMany({ where: { tenantId: tenant(), transferId: sent.body.data.id }, orderBy: { number: 'asc' } });
    expect(losses.map((l) => [l.kind, Number(l.qty), l.valuePaisa, l.source, l.projectId])).toEqual([
      ['MISSING', 3, 3n * 450000n, 'TRANSFER_GAP', johar()],
      ['DAMAGED', 1, 450000n, 'TRANSFER_GAP', johar()],
    ]);
    const twice = await api().post(`/api/v1/equipment/transfers/${sent.body.data.id}/receive`).set(auth).send({ items: [{ itemId, receivedQty: 15 }] });
    expect(twice.body.error.code).toBe('ALREADY_RECEIVED');
    expect(await prismaAdmin.auditLog.count({ where: { tenantId: tenant(), entityId: sent.body.data.id, action: { in: ['equipment.transfer.create', 'equipment.transfer.receive'] } } })).toBe(2);
  });

  it('cancel puts the units back; the ledger is append-only for the app', async () => {
    const auth = await owner();
    const props = await eq('PR-01');
    const yard = await store();
    const sent = await api().post('/api/v1/equipment/transfers').set(auth).send({ fromLocationId: yard.id, toProjectId: johar(), items: [{ equipmentId: props.id, qty: 40 }] });
    expect(sent.status).toBe(201);
    const cancel = await api().post(`/api/v1/equipment/transfers/${sent.body.data.id}/cancel`).set(auth);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(await balance(yard.id, props.id)).toBe(40);
    await expect(withTenant(tenant(), (tx) => tx.$executeRaw`UPDATE "EquipmentMovement" SET quantity = 0`)).rejects.toThrow(/permission denied/);
    await expect(withTenant(tenant(), (tx) => tx.$executeRaw`DELETE FROM "EquipmentCharge"`)).rejects.toThrow(/permission denied/);
  });
});

describe('rentals', () => {
  it('rent accrues days × qty × rate (idempotent); a back-dated partial return corrects posted days; full return → supplier ledger; close refunds the deposit', async () => {
    const auth = await owner();
    const props = await eq('PR-01');
    const yardSupplier = await prismaAdmin.supplier.findFirstOrThrow({ where: { tenantId: tenant(), name: 'Punjab Shuttering Yard' } });
    const created = await api()
      .post('/api/v1/equipment/rentals')
      .set(auth)
      .send({ supplierId: yardSupplier.id, projectId: johar(), startDate: addDays(today(), -6), depositPaisa: '1000000', items: [{ equipmentId: props.id, qty: 10, ratePaisaPerDay: '2000' }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const r = created.body.data;
    expect(r).toMatchObject({ status: 'ACTIVE', number: 'RNT-0002', accruedToDatePaisa: String(7 * 10 * 2000), daysOnRent: 7 });

    const run1 = await api().post('/api/v1/equipment/accruals/run').set(auth).send({});
    expect(run1.body.data.rental.amountPaisa).toBe(String(6 * 10 * 2000)); // 6 complete days
    expect((await api().post('/api/v1/equipment/accruals/run').set(auth).send({})).body.data.rental.rows).toBe(0);
    expect(await charges({ rentalId: r.id })).toBe(120000n);

    // 4 props went back 3 days ago (recorded late): days −3, −2, −1 are corrected (6 props each)
    const part = await api()
      .post(`/api/v1/equipment/rentals/${r.id}/return`)
      .set(auth)
      .send({ returnDate: addDays(today(), -3), items: [{ rentalItemId: r.items[0].id, qty: 4 }] });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect(part.body.data.status).toBe('ACTIVE');
    await api().post('/api/v1/equipment/accruals/run').set(auth).send({});
    expect(await charges({ rentalId: r.id })).toBe(3n * 10n * 2000n + 3n * 6n * 2000n);
    expect(await prismaAdmin.equipmentCharge.count({ where: { tenantId: tenant(), rentalId: r.id, seq: 1 } })).toBe(3);

    // Missing props must be reported first
    const site = await prismaAdmin.stockLocation.findFirstOrThrow({ where: { tenantId: tenant(), projectId: johar() } });
    const missingFirst = await api().post(`/api/v1/equipment/rentals/${r.id}/return`).set(auth).send({ returnDate: today(), items: [{ rentalItemId: r.items[0].id, qty: 5, missingQty: 1 }] });
    expect(missingFirst.body.error.code).toBe('MISSING_NOT_REPORTED');
    const lost = await api().post('/api/v1/equipment/losses').set(auth).send({ locationId: site.id, equipmentId: props.id, rentalId: r.id, kind: 'MISSING', qty: 1, note: 'Prop stolen at night' });
    expect(lost.status, JSON.stringify(lost.body)).toBe(201);

    const done = await api()
      .post(`/api/v1/equipment/rentals/${r.id}/return`)
      .set(auth)
      .send({ returnDate: today(), items: [{ rentalItemId: r.items[0].id, qty: 5, damagedQty: 1, missingQty: 1 }], damageChargesPaisa: '500000' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const rent = 3n * 10n * 2000n + 3n * 6n * 2000n;
    expect(done.body.data).toMatchObject({ status: 'RETURNED', returnedDate: today(), rentChargedPaisa: rent.toString(), damageChargesPaisa: '500000' });
    expect(await balance(site.id, props.id, r.id)).toBe(0);
    const ledger = await prismaAdmin.supplierLedgerEntry.findMany({ where: { tenantId: tenant(), supplierId: yardSupplier.id, refType: { startsWith: 'RENTAL' }, projectId: johar() }, orderBy: { createdAt: 'asc' } });
    expect(ledger.map((e) => [e.refType, e.amountPaisa])).toEqual([
      ['RENTAL_DEPOSIT', -1000000n],
      ['RENTAL_DAMAGE', 500000n],
      ['RENTAL_CHARGE', rent],
    ]);

    const tooMuch = await api().post(`/api/v1/equipment/rentals/${r.id}/close`).set(auth).send({ depositRefundPaisa: '2000000' });
    expect(tooMuch.body.error.code).toBe('REFUND_EXCEEDS_DEPOSIT');
    const closed = await api().post(`/api/v1/equipment/rentals/${r.id}/close`).set(auth).send({ depositRefundPaisa: '300000' });
    expect(closed.body.data.status).toBe('CLOSED');
    const refund = await prismaAdmin.supplierLedgerEntry.findFirstOrThrow({ where: { tenantId: tenant(), refType: 'RENTAL_DEPOSIT_REFUND', refId: r.id } });
    expect(refund.amountPaisa).toBe(300000n);
    // Rent on the project's P&L (EQUIPMENT) equals what the yard billed.
    expect(await charges({ projectId: johar(), kind: 'RENTAL' })).toBe(rent);
    expect(await prismaAdmin.auditLog.count({ where: { tenantId: tenant(), entityId: r.id, action: { startsWith: 'equipment.rental.' } } })).toBe(4);
  });
});

describe('losses', () => {
  it('charge to the project → P&L LOSSES; to a sub-contractor → sub-contract DEDUCTION; never twice', async () => {
    const auth = await owner();
    const loss = await prismaAdmin.equipmentLoss.findFirstOrThrow({ where: { tenantId: tenant(), number: 'EL-0001' } });
    expect((await api().post(`/api/v1/equipment/losses/${loss.id}/charge`).set(await pm()).send({ chargedTo: 'PROJECT', note: 'Project bears it' })).body.error.code).toBe('PERMISSION_DENIED');
    const before = (await pnlBuckets(dha())).LOSSES;
    const charged = await api().post(`/api/v1/equipment/losses/${loss.id}/charge`).set(auth).send({ chargedTo: 'PROJECT', valuePaisa: '2400000', note: 'Lost in the storm' });
    expect(charged.status, JSON.stringify(charged.body)).toBe(200);
    expect(charged.body.data).toMatchObject({ status: 'CHARGED', chargedTo: 'PROJECT', valuePaisa: '2400000' });
    expect((await pnlBuckets(dha())).LOSSES - before).toBe(2400000n);
    const again = await api().post(`/api/v1/equipment/losses/${loss.id}/charge`).set(auth).send({ chargedTo: 'WRITE_OFF', note: 'again' });
    expect(again.body.error.code).toBe('LOSS_ALREADY_CHARGED');

    const sub = await prismaAdmin.subcontractor.findFirstOrThrow({ where: { tenantId: tenant() } });
    const assignment = await prismaAdmin.subcontractAssignment.create({
      data: { tenantId: tenant(), projectId: dha(), subcontractorId: sub.id, scope: 'Shuttering', rateType: 'PER_SQFT', ratePaisa: 3000n, startDate: new Date('2026-09-01') },
    });
    const plates = await eq('SP-23');
    const reported = await api().post('/api/v1/equipment/losses').set(auth).send({ projectId: dha(), equipmentId: plates.id, kind: 'DAMAGED', qty: 2, note: 'Bent by careless de-shuttering' });
    expect(reported.status).toBe(201);
    expect(await balance((await site(dha())).id, plates.id)).toBe(244); // damaged stay on site
    const toSub = await api().post(`/api/v1/equipment/losses/${reported.body.data.id}/charge`).set(auth).send({ chargedTo: 'SUBCONTRACTOR', subcontractAssignmentId: assignment.id, note: 'His team' });
    expect(toSub.status, JSON.stringify(toSub.body)).toBe(200);
    const entry = await prismaAdmin.subcontractLedgerEntry.findFirstOrThrow({ where: { tenantId: tenant(), refType: 'EQUIPMENT_LOSS', refId: reported.body.data.id } });
    expect(entry).toMatchObject({ type: 'DEDUCTION', amountPaisa: -900000n, assignmentId: assignment.id });
    expect(await prismaAdmin.auditLog.count({ where: { tenantId: tenant(), action: 'equipment.loss.charge' } })).toBe(2);
  });
});

describe('permissions and field gating', () => {
  it('Munshi: his site only, no money fields; may receive and report, never send, manage or charge', async () => {
    const auth = await munshi();
    const map = await api().get('/api/v1/equipment/balances').set(auth);
    expect(map.status).toBe(200);
    expect(map.body.data.locations.map((l: { location: { projectId: string | null } }) => l.location.projectId)).toEqual([dha()]);
    for (const url of ['/api/v1/equipment', '/api/v1/equipment/rentals', '/api/v1/equipment/losses', `/api/v1/projects/${dha()}/equipment`, '/api/v1/equipment/charges']) {
      const res = await api().get(url).set(auth);
      expect(res.status, url).toBe(200);
      expect([...keys(res.body.data)].filter((k) => MONEY.test(k)), url).toEqual([]);
    }
    expect((await api().get(`/api/v1/projects/${johar()}/equipment`).set(auth)).status).toBe(404);
    const plates = await eq('SP-23');
    expect((await api().post('/api/v1/equipment').set(auth).send({ name: 'X plate', kind: 'BULK', category: 'OTHER' })).body.error.code).toBe('PERMISSION_DENIED');
    expect((await api().post('/api/v1/equipment/transfers').set(auth).send({ fromLocationId: (await site(dha())).id, toProjectId: johar(), items: [{ equipmentId: plates.id, qty: 1 }] })).body.error.code).toBe('PERMISSION_DENIED');
    expect((await api().post('/api/v1/equipment/accruals/run').set(auth).send({})).body.error.code).toBe('PERMISSION_DENIED');

    const photo = await attachment(auth, 'SITE_PHOTO');
    const loss = await api().post('/api/v1/equipment/losses').set(auth).send({ projectId: dha(), equipmentId: plates.id, kind: 'MISSING', qty: 2, note: 'Two plates gone', photoAttachmentId: photo });
    expect(loss.status, JSON.stringify(loss.body)).toBe(201);
    expect(loss.body.data.valuePaisa).toBeUndefined();
    expect(loss.body.data.photoUrl).toBeTruthy();
    expect((await api().post(`/api/v1/equipment/losses/${loss.body.data.id}/charge`).set(auth).send({ chargedTo: 'WRITE_OFF', note: 'x' })).body.error.code).toBe('PERMISSION_DENIED');
    // Johar is not his project
    expect((await api().post('/api/v1/equipment/losses').set(auth).send({ projectId: johar(), equipmentId: plates.id, kind: 'MISSING', qty: 1, note: 'not mine' })).status).toBe(404);
  });

  it('PM: sees rates (fields.rates in the template); sends from his site but not from the yard', async () => {
    const auth = await pm();
    const list = await api().get('/api/v1/equipment').set(auth);
    expect(list.body.data[0]).toHaveProperty('hireRatePaisaPerDay');
    const plates = await eq('SP-23');
    const fromYard = await api().post('/api/v1/equipment/transfers').set(auth).send({ fromLocationId: (await store()).id, toProjectId: dha(), items: [{ equipmentId: plates.id, qty: 1 }] });
    expect(fromYard.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'equipment.manage' } });
    const fromSite = await api().post('/api/v1/equipment/transfers').set(auth).send({ fromLocationId: (await site(dha())).id, toProjectId: johar(), items: [{ equipmentId: plates.id, qty: 10 }] });
    expect(fromSite.status, JSON.stringify(fromSite.body)).toBe(201);
    expect(fromSite.body.data.kind).toBe('TRANSFER');
  });
});

describe('offline sync', () => {
  it('pull: equipment tables of his site without money; push: receive + loss report, idempotent', async () => {
    const auth = await owner();
    const plates = await eq('SP-23');
    const sent = await api().post('/api/v1/equipment/transfers').set(auth).send({ fromLocationId: (await store()).id, toProjectId: dha(), items: [{ equipmentId: plates.id, qty: 10 }] });
    const m = await munshi();
    const pull = await api().get('/api/v1/sync/pull').set(m);
    expect(pull.status).toBe(200);
    const ch = pull.body.data.changes;
    for (const t of ['equipment', 'equipment_stock', 'equipment_transfers', 'equipment_rentals', 'equipment_losses']) expect(ch[t].upserts.length, t).toBeGreaterThan(0);
    expect([...keys([ch.equipment, ch.equipment_losses, ch.equipment_rentals])].filter((k) => MONEY.test(k))).toEqual([]);
    const incoming = ch.equipment_transfers.upserts.find((t: { id: string }) => t.id === sent.body.data.id);
    expect(incoming).toMatchObject({ status: 'ON_THE_WAY', blindCount: true });
    expect(incoming.items[0].sentQty).toBeUndefined();
    const dhaSite = await site(dha());
    expect(ch.equipment_stock.upserts).toContainEqual(expect.objectContaining({ id: `${dhaSite.id}:${plates.id}:own`, quantity: 244 }));

    const batch = [
      { clientId: uuidv7(), type: 'EQUIPMENT_RECEIVE', payload: { transferId: sent.body.data.id, items: [{ itemId: incoming.items[0].id, receivedQty: 10 }] }, deviceCreatedAt: new Date().toISOString() },
      { clientId: uuidv7(), type: 'EQUIPMENT_LOSS_REPORT', payload: { projectId: dha(), equipmentId: plates.id, kind: 'DAMAGED', qty: 1, note: 'Bent plate' }, deviceCreatedAt: new Date().toISOString() },
    ];
    const push = await api().post('/api/v1/sync/push').set(m).send({ mutations: batch });
    expect(push.status, JSON.stringify(push.body)).toBe(200);
    expect(push.body.data.results.map((r: { status: string }) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    const replay = await api().post('/api/v1/sync/push').set(m).send({ mutations: batch });
    expect(replay.body.data.results.map((r: { status: string }) => r.status)).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(await balance(dhaSite.id, plates.id)).toBe(254);
    expect(await prismaAdmin.equipmentLoss.count({ where: { tenantId: tenant(), note: 'Bent plate' } })).toBe(1);
  });
});
