import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { SEED, useFreshDatabase } from '../helpers.js';
import { api, attachment, balanceOf, float, materialId, munshi, owner, pm, rs, supplierId } from '../labor/fixtures.js';

const seeded = useFreshDatabase();

async function setup() {
  const t = seeded().malik.id;
  const o = await owner();
  const m = await munshi(t);
  return { t, o, m, dha: seeded().projects.dha.id, rafaqat: seeded().users.rafaqatMalik.id, bilal: seeded().users.bilal.id };
}

const expense = (auth: Record<string, string>, body: Record<string, unknown>) => api().post('/api/v1/cash-expenses').set(auth).send(body);

describe('B6 — floats', () => {
  it('a float waits for the holder to acknowledge (SMS sent); only then is it in the balance', async () => {
    const s = await setup();
    const sent = await float(s.o, s.rafaqat, rs(50000));
    expect(lastSmsTo(SEED.malik.munshi.phone)?.body).toContain('Rs 50,000');
    const acc = await api().get(`/api/v1/cash-accounts/${sent.accountId}`).set(s.m);
    expect(acc.body.data).toMatchObject({ balancePaisa: '0', pendingAckPaisa: rs(50000), holder: { name: 'Rafaqat Ali' } });

    expect((await api().post(`/api/v1/cash-floats/${sent.id}/acknowledge`).set(s.o)).status).toBe(404); // not the holder
    expect((await api().post('/api/v1/cash-floats').set(s.m).send({ holderUserId: s.rafaqat, amountPaisa: rs(1), method: 'CASH' })).status).toBe(403);
    expect((await api().post(`/api/v1/cash-floats/${sent.id}/acknowledge`).set(s.m)).body.data.status).toBe('POSTED');
    expect((await api().post(`/api/v1/cash-floats/${sent.id}/acknowledge`).set(s.m)).body.error.code).toBe('ALREADY_ACKNOWLEDGED');
    expect(await balanceOf(s.m, sent.accountId)).toBe(rs(50000));
    const owner = await api().post('/api/v1/cash-floats').set(s.o).send({ holderUserId: seeded().users.khalid.id, amountPaisa: rs(1), method: 'CASH' });
    expect(owner.body.error.code).toBe('INVALID_HOLDER');
  });

  it('MUNSHI sees only their own account; PM sees their munshis; THEKEDAR all', async () => {
    const s = await setup();
    const raf = await float(s.o, s.rafaqat, rs(1000));
    const asif = await float(s.o, seeded().users.asif.id, rs(2000));
    expect((await api().get('/api/v1/cash-accounts').set(s.m)).body.data.items.map((a: { id: string }) => a.id)).toEqual([raf.accountId]);
    expect((await api().get(`/api/v1/cash-accounts/${asif.accountId}`).set(s.m)).status).toBe(404);
    // Bilal manages DHA (Rafaqat), not Bahria (Asif)
    expect((await api().get('/api/v1/cash-accounts').set(await pm())).body.data.items.map((a: { id: string }) => a.id)).toEqual([raf.accountId]);
    const all = await api().get('/api/v1/cash-accounts').set(s.o);
    expect(all.body.data.items).toHaveLength(2);
    expect(all.body.data.totals).toMatchObject({ balancePaisa: '0', pendingAckPaisa: rs(3000) });
  });
});

describe('B6 — kharcha', () => {
  it('within the limit → APPROVED; above → PENDING_APPROVAL (already out of the cash); reject → recoverable', async () => {
    const s = await setup();
    const acc = (await float(s.o, s.rafaqat, rs(60000), s.m)).accountId;
    const receipt = await attachment(s.m, 'RECEIPT');

    const clientId = uuidv7();
    const tea = { projectId: s.dha, category: 'TEA_WATER', amountPaisa: rs(1200), description: 'Chai for the labour', clientId };
    const first = await expense(s.m, tea);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ type: 'EXPENSE', status: 'APPROVED', costBucket: 'OVERHEAD', amountPaisa: rs(-1200) });
    expect((await expense(s.m, tea)).status).toBe(200);

    const sand = await expense(s.m, { projectId: s.dha, category: 'OTHER', amountPaisa: rs(28000), description: 'Sand trolley', attachmentId: receipt });
    expect(sand.body.data.status).toBe('PENDING_APPROVAL');
    const tiles = await expense(s.m, { projectId: s.dha, category: 'OWNER_PURCHASE', amountPaisa: rs(2800), description: 'Tile samples for Mrs. Hina' });
    expect(tiles.body.data.costBucket).toBe('RECOVERABLE_FROM_OWNER');
    expect((await expense(s.m, { ...tea, clientId: undefined, amountPaisa: rs(40000) })).body.error.code).toBe('INSUFFICIENT_CASH');
    expect((await expense(s.m, { ...tea, clientId: undefined, projectId: seeded().projects.bahria.id })).status).toBe(404);

    const account = await api().get(`/api/v1/cash-accounts/${acc}`).set(s.m);
    expect(account.body.data).toMatchObject({ balancePaisa: rs(60000 - 1200 - 28000 - 2800), pendingApprovalPaisa: rs(28000) });

    const pending = await api().get('/api/v1/cash-expenses').set(await pm()).query({ status: 'PENDING_APPROVAL' });
    expect(pending.body.data).toEqual([expect.objectContaining({ id: sand.body.data.id, amountPaisa: rs(28000), holder: { id: s.rafaqat, name: 'Rafaqat Ali' } })]);
    expect((await api().post(`/api/v1/cash-expenses/${sand.body.data.id}/approve`).set(s.m).send({})).status).toBe(403);
    expect((await api().post(`/api/v1/cash-expenses/${first.body.data.id}/approve`).set(s.o).send({})).body.error.code).toBe('EXPENSE_NOT_PENDING');
    expect((await api().post(`/api/v1/cash-expenses/${sand.body.data.id}/reject`).set(s.o).send({})).status).toBe(400);
    const rejected = await api().post(`/api/v1/cash-expenses/${sand.body.data.id}/reject`).set(await pm()).send({ note: 'No bill for this trolley' });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', recoverableFromHolder: true });
    expect((await api().get(`/api/v1/cash-accounts/${acc}`).set(s.m)).body.data).toMatchObject({ balancePaisa: rs(28000), recoverablePaisa: rs(28000), pendingApprovalPaisa: '0' });

    const book = await api().get(`/api/v1/projects/${s.dha}/cashbook`).set(s.o);
    expect(book.status).toBe(200);
    expect(book.body.data.summary.spentByCategory[0]).toEqual({ category: 'OTHER', amountPaisa: rs(28000) });
    expect(book.body.data.summary.kharchaThisWeekPaisa).toBe(rs(32000));
    expect(book.body.data.accounts).toHaveLength(1);
  });

  it('urgent material with items enters site stock (rates later); setting rates pays it from site cash without a second entry', async () => {
    const s = await setup();
    const acc = (await float(s.o, s.rafaqat, rs(10000), s.m)).accountId;
    const receipt = await attachment(s.m, 'RECEIPT');
    const cement = await materialId(s.t, 'Cement OPC');
    const res = await expense(s.m, {
      projectId: s.dha,
      category: 'URGENT_MATERIAL',
      amountPaisa: rs(4350),
      description: '3 bags cement — slab ran short',
      attachmentId: receipt,
      supplierId: await supplierId(s.t, 'Al-Madina Cement Agency'),
      items: [{ materialId: cement, qty: 3 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ costBucket: 'MATERIAL', refType: 'PURCHASE' });
    const purchase = await prismaAdmin.purchase.findUniqueOrThrow({ where: { id: res.body.data.refId } });
    expect(purchase).toMatchObject({ status: 'PENDING_RATE', paymentMode: 'UDHAAR', projectId: s.dha });

    const rates = await api()
      .patch(`/api/v1/purchases/${purchase.id}/rates`)
      .set(s.o)
      .send({ items: [{ materialId: cement, ratePaisa: rs(1450) }] });
    expect(rates.status).toBe(200);
    const after = await prismaAdmin.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(after).toMatchObject({ paymentMode: 'CASH', paidFrom: 'SITE_CASH', totalPaisa: 435000n, paidNowPaisa: 435000n });
    expect(await prismaAdmin.cashEntry.count({ where: { accountId: acc } })).toBe(2); // float + the kharcha only
    expect(await balanceOf(s.m, acc)).toBe(rs(5650));
  });
});

describe('B6 — top-ups, counts, handovers', () => {
  it('top-up approve creates a float; counts book the difference; handover moves cash; open cash blocks deactivation', async () => {
    const s = await setup();
    const acc = (await float(s.o, s.rafaqat, rs(9400), s.m)).accountId;

    const req = await api().post('/api/v1/topup-requests').set(s.m).send({ amountPaisa: rs(40000), note: 'Wages on Saturday' });
    expect(req.status).toBe(201);
    expect((await api().post('/api/v1/topup-requests').set(s.m).send({ amountPaisa: rs(1000) })).body.error.code).toBe('TOPUP_PENDING');
    expect((await api().post(`/api/v1/topup-requests/${req.body.data.id}/approve`).set(await pm()).send({ method: 'CASH' })).status).toBe(403);
    const ok = await api().post(`/api/v1/topup-requests/${req.body.data.id}/approve`).set(s.o).send({ amountPaisa: rs(30000), method: 'JAZZCASH', reference: 'JC-77' });
    expect(ok.body.data).toMatchObject({ status: 'APPROVED', floatEntryId: expect.any(String) });
    expect((await api().get(`/api/v1/cash-accounts/${acc}`).set(s.m)).body.data).toMatchObject({ balancePaisa: rs(9400), pendingAckPaisa: rs(30000) });

    const noNote = await api().post('/api/v1/cash-counts').set(s.m).send({ countedPaisa: rs(9300) });
    expect(noNote.body.error.code).toBe('NOTE_REQUIRED');
    const count = await api().post('/api/v1/cash-counts').set(s.m).send({ countedPaisa: rs(9300), note: 'Change to tea boy' });
    expect(count.body.data).toMatchObject({ systemPaisa: rs(9400), countedPaisa: rs(9300), differencePaisa: rs(-100) });
    expect(await balanceOf(s.m, acc)).toBe(rs(9300));
    expect((await api().get('/api/v1/cash-counts').set(s.o)).body.data).toHaveLength(1);

    // Rafaqat can't be deactivated while holding cash
    const blocked = await api().delete(`/api/v1/users/${s.rafaqat}`).set(s.o);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'CASH_BALANCE_OPEN', details: { accountId: acc, balancePaisa: rs(9300) } });

    // Hand everything to Bilal; the pending top-up float is cancelled by acknowledging and handing it over too
    const ackFloat = await prismaAdmin.cashEntry.findFirstOrThrow({ where: { accountId: acc, status: 'PENDING_ACK' } });
    await api().post(`/api/v1/cash-floats/${ackFloat.id}/acknowledge`).set(s.m).expect(200);
    const tooMuch = await api().post('/api/v1/cash-handovers').set(s.m).send({ toUserId: s.bilal, amountPaisa: rs(50000) });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_CASH');
    const ho = await api().post('/api/v1/cash-handovers').set(s.m).send({ toUserId: s.bilal, amountPaisa: rs(39300), note: 'Leaving the site' });
    expect(ho.status).toBe(201);
    expect(await balanceOf(s.m, acc)).toBe('0');
    const bilal = (await api().get('/api/v1/cash-accounts').set(await pm())).body.data.items.find((a: { holder: { id: string } }) => a.holder.id === s.bilal);
    expect(bilal.balancePaisa).toBe(rs(39300));
    expect((await api().delete(`/api/v1/users/${s.rafaqat}`).set(s.o)).status).toBe(200);
  });
});
