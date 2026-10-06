import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { api, float, materialId, munshi, owner, pm, rs, stockIn, storeOf, subcontractorId, today, type Auth } from './fixtures.js';

const seeded = useFreshDatabase();

async function setup() {
  const t = seeded().malik.id;
  const dha = seeded().projects.dha.id;
  const o = await owner();
  const sub = async (name: string, body: Record<string, unknown>) =>
    (await api().post(`/api/v1/projects/${dha}/labor/subcontracts`).set(o).send({ subcontractorId: await subcontractorId(t, name), ...body })).body.data as { id: string };
  return {
    t,
    dha,
    o,
    latif: await sub('Ustad Latif Steel Fixing', { scope: 'Steel fixing — slabs', rateType: 'PER_TON' }),
    haji: await sub('Haji Plumbing Works', { scope: 'Plumbing rough-in', rateType: 'LUMPSUM' }),
  };
}

const measure = async (auth: Auth, dha: string, assignmentId: string, quantity: string) => {
  const rec = await api().post(`/api/v1/projects/${dha}/work-measurements`).set(auth).send({ assignmentId, date: today(), description: 'Slab steel', quantity });
  await api().post(`/api/v1/work-measurements/${rec.body.data.id}/verify`).set(auth).expect(200);
};
const pay = (auth: Auth, id: string, body: Record<string, unknown>) => api().post(`/api/v1/subcontract-assignments/${id}/payments`).set(auth).send(body);

describe('B5 — sub-contractor accounts', () => {
  it('value − retention − paid − deductions; paying more than due needs allowAdvance; overpaid is flagged', async () => {
    const s = await setup();
    await measure(s.o, s.dha, s.latif.id, '14.2'); // 14.2 t × 9,000 = 1,27,800; retention 5% = 6,390

    const over = await pay(s.o, s.latif.id, { type: 'RUNNING', amountPaisa: rs(145000), paidFrom: 'BANK', reference: 'HBL-221' });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatchObject({ code: 'EXCEEDS_BALANCE', details: { balanceDuePaisa: rs(121410) } });
    const ok = await pay(s.o, s.latif.id, { type: 'RUNNING', amountPaisa: rs(145000), paidFrom: 'BANK', reference: 'HBL-221', allowAdvance: true });
    expect(ok.status).toBe(201);
    expect(ok.body.data.account).toMatchObject({
      valuePaisa: rs(127800),
      retentionHeldPaisa: rs(6390),
      paidPaisa: rs(145000),
      balanceDuePaisa: rs(-23590),
      overpaid: true,
      overpaidPaisa: rs(23590),
    });

    const accounts = await api().get(`/api/v1/projects/${s.dha}/subcontract-accounts`).set(s.o);
    const latif = accounts.body.data.items.find((x: { id: string }) => x.id === s.latif.id);
    expect(latif).toMatchObject({ verifiedQty: 14.2, unit: 'ton', account: { overpaid: true } });
    expect(accounts.body.data.totals).toMatchObject({ overpaidCount: 1 });
    expect((await api().get(`/api/v1/projects/${s.dha}/subcontract-accounts`).set(await munshi(s.t))).status).toBe(403);

    const tooMuchRetention = await pay(s.o, s.latif.id, { type: 'RETENTION_RELEASE', amountPaisa: rs(7000), paidFrom: 'BANK' });
    expect(tooMuchRetention.body.error.code).toBe('EXCEEDS_RETENTION');
    const released = await pay(s.o, s.latif.id, { type: 'RETENTION_RELEASE', amountPaisa: rs(6390), paidFrom: 'BANK' });
    expect(released.body.data.account).toMatchObject({ retentionHeldPaisa: '0', retentionReleasedPaisa: rs(6390), balanceDuePaisa: rs(-23590) });

    const ledger = await api().get(`/api/v1/subcontract-assignments/${s.latif.id}/ledger`).set(s.o);
    expect(ledger.body.data.entries.map((e: { type: string; amountPaisa: string }) => [e.type, e.amountPaisa])).toEqual([
      ['RETENTION_RELEASE', rs(-6390)],
      ['RUNNING_PAYMENT', rs(-145000)],
      ['WORK_VALUE', rs(127800)],
    ]);
  });

  it('LUMPSUM: cumulative % progress; PM pays only when the company allows it; deductions are THEKEDAR only', async () => {
    const s = await setup();
    const p = await pm();
    expect((await api().post(`/api/v1/subcontract-assignments/${s.haji.id}/progress`).set(p).send({ percent: 40 })).body.data.account).toMatchObject({
      valuePaisa: rs(48000),
      retentionHeldPaisa: rs(2400),
      balanceDuePaisa: rs(45600),
    });
    expect((await api().post(`/api/v1/subcontract-assignments/${s.haji.id}/progress`).set(p).send({ percent: 30 })).body.error.code).toBe('PROGRESS_NOT_AHEAD');
    expect((await api().post(`/api/v1/subcontract-assignments/${s.latif.id}/progress`).set(p).send({ percent: 30 })).body.error.code).toBe('NOT_LUMPSUM');
    expect((await api().post(`/api/v1/subcontract-assignments/${s.haji.id}/progress`).set(p).send({ percent: 101 })).status).toBe(400);

    expect((await pay(p, s.haji.id, { type: 'RUNNING', amountPaisa: rs(30000), paidFrom: 'BANK' })).status).toBe(403);
    await api().patch('/api/v1/company/settings').set(s.o).send({ subcontractPaymentsByPm: true }).expect(200);
    const paid = await pay(p, s.haji.id, { type: 'RUNNING', amountPaisa: rs(30000), paidFrom: 'BANK' });
    expect(paid.body.data.account).toMatchObject({ paidPaisa: rs(30000), balanceDuePaisa: rs(15600) });

    expect((await api().post(`/api/v1/subcontract-assignments/${s.haji.id}/deductions`).set(p).send({ amountPaisa: rs(500), reason: 'Broken fitting' })).status).toBe(403);
    const ded = await api().post(`/api/v1/subcontract-assignments/${s.haji.id}/deductions`).set(s.o).send({ amountPaisa: rs(500), reason: 'Broken fitting' });
    expect(ded.body.data.account).toMatchObject({ deductionsPaisa: rs(500), balanceDuePaisa: rs(15100) });

    const fin = await pay(s.o, s.haji.id, { type: 'FINAL', amountPaisa: rs(15100), paidFrom: 'OFFICE_CASH' });
    expect(fin.body.data).toMatchObject({ assignment: { isActive: false }, account: { balanceDuePaisa: '0' } });
  });

  it('site-cash payment leaves the cash book; a shortage loss can be charged to a sub-contract', async () => {
    const s = await setup();
    const m = await munshi(s.t);
    const cash = await float(s.o, seeded().users.rafaqatMalik.id, rs(10000), m);
    await measure(s.o, s.dha, s.latif.id, '1');
    await pay(s.o, s.latif.id, { type: 'RUNNING', amountPaisa: rs(5000), paidFrom: 'SITE_CASH', cashAccountId: cash.accountId }).expect(201);
    expect((await api().get(`/api/v1/cash-accounts/${cash.accountId}`).set(m)).body.data.balancePaisa).toBe(rs(5000));
    expect(await prismaAdmin.cashEntry.findFirstOrThrow({ where: { type: 'SUBCONTRACT_PAYMENT' } })).toMatchObject({ amountPaisa: -500000n, projectId: s.dha });

    // 5 bags short on a store → DHA dispatch: the loss goes to Latif
    const { store } = await storeOf(s.t);
    const cement = await materialId(s.t, 'Cement OPC');
    await stockIn(s.t, store.id, cement, 200, 145333n);
    const d = (
      await api()
        .post('/api/v1/dispatches')
        .set(s.o)
        .send({ fromLocationId: store.id, toProjectId: s.dha, vehicleNo: 'LES-4521', items: [{ materialId: cement, qty: 100 }] })
    ).body.data;
    await api().post(`/api/v1/dispatches/${d.id}/receive`).set(s.o).send({ items: [{ materialId: cement, receivedQty: 95, note: '5 short' }] }).expect(200);
    const short = (await api().get('/api/v1/shortages').set(s.o)).body.data[0];
    const wrong = await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.o).send({ resolution: 'RECOVER_FROM_DRIVER', note: 'x driver', recoveredAmountPaisa: '1', chargeToAssignmentId: s.latif.id });
    expect(wrong.status).toBe(400);
    const res = await api().post(`/api/v1/shortages/${short.id}/resolve`).set(s.o).send({ resolution: 'ACCEPT_LOSS', note: 'Bags torn by the steel team', chargeToAssignmentId: s.latif.id });
    expect(res.status).toBe(200);
    const ledger = await api().get(`/api/v1/subcontract-assignments/${s.latif.id}/ledger`).set(s.o);
    expect(ledger.body.data.entries[0]).toMatchObject({ type: 'DEDUCTION', amountPaisa: '-726665', refType: 'SHORTAGE', refId: short.id });
  });
});
