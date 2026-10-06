import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { useFreshDatabase } from '../helpers.js';
import { addDays, api, assign, balanceOf, float, lastWeek, mark, munshi, owner, pm, rs, subcontractorId, today, workerId } from './fixtures.js';

const seeded = useFreshDatabase();

async function setup() {
  const t = seeded().malik.id;
  const dha = seeded().projects.dha.id;
  const o = await owner();
  const m = await munshi(t);
  const akram = await workerId(t, 'Ustad Akram');
  const shahid = await workerId(t, 'Shahid');
  await assign(o, dha, akram, rs(2800), addDays(lastWeek(), -7));
  await assign(o, dha, shahid, undefined, addDays(lastWeek(), -7));
  const cash = await float(o, seeded().users.rafaqatMalik.id, rs(20000), m);
  return { t, dha, o, m, akram, shahid, account: cash.accountId };
}

describe('B3 — peshgi', () => {
  it('site cash leaves the cash book; MUNSHI only from site cash; replayed clientId → 200; not enough cash → 400', async () => {
    const s = await setup();
    const clientId = uuidv7();
    const body = { payeeType: 'WORKER', workerId: s.akram, amountPaisa: rs(5000), date: lastWeek(), paidFrom: 'SITE_CASH', clientId, deviceCreatedAt: new Date().toISOString() };
    const first = await api().post(`/api/v1/projects/${s.dha}/advances`).set(s.m).send(body);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ amountPaisa: rs(5000), status: 'OUTSTANDING', outstandingPaisa: rs(5000), cashAccountId: s.account });
    const replay = await api().post(`/api/v1/projects/${s.dha}/advances`).set(s.m).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await balanceOf(s.m, s.account)).toBe(rs(15000));

    const office = await api().post(`/api/v1/projects/${s.dha}/advances`).set(s.m).send({ ...body, clientId: undefined, paidFrom: 'OFFICE_CASH' });
    expect(office.body.error.code).toBe('PAID_FROM_NOT_ALLOWED');
    const tooMuch = await api().post(`/api/v1/projects/${s.dha}/advances`).set(s.m).send({ ...body, clientId: undefined, amountPaisa: rs(50000) });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatchObject({ code: 'INSUFFICIENT_CASH', details: { balancePaisa: rs(15000) } });
    const unassigned = await api()
      .post(`/api/v1/projects/${s.dha}/advances`)
      .set(s.o)
      .send({ ...body, clientId: undefined, paidFrom: 'OFFICE_CASH', workerId: await workerId(s.t, 'Riaz') });
    expect(unassigned.body.error.code).toBe('WORKER_NOT_ASSIGNED');

    const entries = await api().get(`/api/v1/cash-accounts/${s.account}/entries`).set(s.m);
    expect(entries.body.data[0]).toMatchObject({ type: 'PESHGI', amountPaisa: rs(-5000), runningBalancePaisa: rs(15000), refType: 'ADVANCE', refId: first.body.data.id });
  });
});

describe('B4 — weekly settlement', () => {
  it('maths, oldest-first peshgi, override, submit → approve (locks) → pay from site cash', async () => {
    const s = await setup();
    const w = lastWeek();
    const adv = (workerId: string, amount: string, date: string, paidFrom = 'OFFICE_CASH', auth = s.o) =>
      api().post(`/api/v1/projects/${s.dha}/advances`).set(auth).send({ payeeType: 'WORKER', workerId, amountPaisa: amount, date, paidFrom });
    const old = await adv(s.akram, rs(1000), addDays(w, -3));
    const site = await adv(s.akram, rs(5000), addDays(w, 1), 'SITE_CASH', s.m);
    await adv(s.shahid, rs(3000), w);
    await adv(s.akram, rs(700), addDays(w, 8)); // after the week: not cut

    await mark(s.o, s.dha, w, [
      { workerId: s.akram, status: 'FULL', overtimeHours: 2 },
      { workerId: s.shahid, status: 'FULL' },
    ]);
    await mark(s.o, s.dha, addDays(w, 1), [{ workerId: s.akram, status: 'FULL' }]);
    await mark(s.o, s.dha, addDays(w, 2), [
      { workerId: s.akram, status: 'HALF' },
      { workerId: s.shahid, status: 'ABSENT' },
    ]);

    expect((await api().post(`/api/v1/projects/${s.dha}/settlements/generate`).set(s.m).send({ weekStart: addDays(w, 1) })).body.error.code).toBe('INVALID_WEEK_START');
    expect((await api().post(`/api/v1/projects/${s.dha}/settlements/generate`).set(s.m).send({ weekStart: addDays(w, 14) })).body.error.code).toBe('FUTURE_WEEK');
    const gen = await api().post(`/api/v1/projects/${s.dha}/settlements/generate`).set(s.m).send({ weekStart: w });
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    const id = gen.body.data.id;
    const line = (body: { lines: Array<{ worker: { id: string } }> }, workerId: string) => body.lines.find((l) => l.worker.id === workerId) as Record<string, unknown>;
    // Akram: 2.5 days × 2,800 = 7,000 + OT 2h × 2,800 / 8 × 1.5 = 1,050 → 8,050; peshgi 1,000 + 5,000
    expect(line(gen.body.data, s.akram)).toMatchObject({
      fullDays: 2,
      halfDays: 1,
      daysWorked: 2.5,
      overtimeHours: 2,
      overtimePaisa: rs(1050),
      grossPaisa: rs(8050),
      advanceAdjustedPaisa: rs(6000),
      netPaisa: rs(2050),
    });
    // Shahid: 1 day = 1,600; peshgi 3,000 is cut only up to the wages
    expect(line(gen.body.data, s.shahid)).toMatchObject({ grossPaisa: rs(1600), advanceAdjustedPaisa: rs(1600), netPaisa: '0' });
    expect(gen.body.data).toMatchObject({ status: 'DRAFT', workers: 2, grossPaisa: rs(9650), advancePaisa: rs(7600), netPaisa: rs(2050), weekEnd: addDays(w, 6) });

    // Office keeps only Rs 2,000 of Akram's peshgi this week (note required); regenerating keeps it
    const akramLine = line(gen.body.data, s.akram).id as string;
    expect((await api().patch(`/api/v1/settlements/${id}/lines/${akramLine}`).set(s.o).send({ advanceAdjustedPaisa: rs(2000) })).status).toBe(400);
    expect((await api().patch(`/api/v1/settlements/${id}/lines/${akramLine}`).set(s.o).send({ advanceAdjustedPaisa: rs(9000), note: 'too much' })).body.error.code).toBe(
      'ADVANCE_TOO_HIGH',
    );
    const adj = await api().patch(`/api/v1/settlements/${id}/lines/${akramLine}`).set(s.o).send({ advanceAdjustedPaisa: rs(2000), note: 'Wedding at home' });
    expect(line(adj.body.data, s.akram)).toMatchObject({ advanceAdjustedPaisa: rs(2000), netPaisa: rs(6050), advanceOverride: true });
    expect((line(adj.body.data, s.akram).advances as unknown[]).length).toBe(2); // 1,000 (oldest) + 1,000
    const regen = await api().post(`/api/v1/projects/${s.dha}/settlements/generate`).set(s.m).send({ weekStart: w });
    expect(line(regen.body.data, s.akram)).toMatchObject({ advanceAdjustedPaisa: rs(2000), overrideNote: 'Wedding at home' });
    const id2 = regen.body.data.id;
    const akramLine2 = line(regen.body.data, s.akram).id as string;

    expect((await api().post(`/api/v1/settlements/${id2}/submit`).set(s.m)).body.data.status).toBe('SUBMITTED');
    expect((await api().post(`/api/v1/settlements/${id2}/approve`).set(s.m)).status).toBe(403);
    expect((await api().post(`/api/v1/settlements/${id2}/pay`).set(s.m).send({ lineIds: [akramLine2], paidFrom: 'SITE_CASH' })).body.error.code).toBe('SETTLEMENT_NOT_APPROVED');
    const approved = await api().post(`/api/v1/settlements/${id2}/approve`).set(await pm());
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', approvedBy: { name: 'Bilal Ahmed' }, submittedBy: { name: 'Rafaqat Ali' } });
    expect((await api().post(`/api/v1/projects/${s.dha}/settlements/generate`).set(s.o).send({ weekStart: w })).body.error.code).toBe('SETTLEMENT_LOCKED');

    const advances = await api().get(`/api/v1/projects/${s.dha}/advances`).set(s.m).query({ workerId: s.akram });
    const byId = (x: string) => advances.body.data.find((a: { id: string }) => a.id === x);
    expect(byId(old.body.data.id)).toMatchObject({ status: 'ADJUSTED', outstandingPaisa: '0' });
    expect(byId(site.body.data.id)).toMatchObject({ status: 'PARTLY_ADJUSTED', adjustedPaisa: rs(1000), outstandingPaisa: rs(4000) });

    // Pay Akram from Rafaqat's site cash: 20,000 − 5,000 peshgi − 6,050 wages
    expect((await api().post(`/api/v1/settlements/${id2}/pay`).set(s.m).send({ lineIds: [akramLine2], paidFrom: 'BANK' })).body.error.code).toBe('PAID_FROM_NOT_ALLOWED');
    const paid = await api().post(`/api/v1/settlements/${id2}/pay`).set(s.m).send({ lineIds: [akramLine2], paidFrom: 'SITE_CASH' });
    expect(paid.body.data).toMatchObject({ paidPaisa: rs(6050), fullyPaid: false });
    expect(await balanceOf(s.m, s.account)).toBe(rs(8950));
    expect((await api().post(`/api/v1/settlements/${id2}/pay`).set(s.m).send({ lineIds: [akramLine2], paidFrom: 'SITE_CASH' })).body.error.code).toBe('ALREADY_PAID');
    expect((await api().post(`/api/v1/settlements/${id2}/return`).set(s.o).send({ comment: 'recheck please' })).body.error.code).toBe('SETTLEMENT_PAID');
    const entry = await prismaAdmin.cashEntry.findFirstOrThrow({ where: { type: 'WAGE_PAYMENT' } });
    expect(entry).toMatchObject({ amountPaisa: -605000n, refType: 'SETTLEMENT_LINE', refId: akramLine2, costBucket: 'LABOR' });

    const list = await api().get('/api/v1/settlements').set(s.o).query({ status: 'APPROVED' });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).not.toHaveProperty('lines');
    expect((await api().get('/api/v1/settlements').set(s.m)).status).toBe(403);
  });
});

describe('B3 — work measurements', () => {
  it('munshi records (idempotent, no money shown); office verifies → WORK_VALUE in the ledger; reject needs a note', async () => {
    const s = await setup();
    const sharif = await subcontractorId(s.t, 'Ustad Sharif Shuttering');
    const haji = await subcontractorId(s.t, 'Haji Plumbing Works');
    const sub = (await api().post(`/api/v1/projects/${s.dha}/labor/subcontracts`).set(s.o).send({ subcontractorId: sharif, scope: 'Slab shuttering', rateType: 'PER_SQFT' })).body.data;
    const lump = (await api().post(`/api/v1/projects/${s.dha}/labor/subcontracts`).set(s.o).send({ subcontractorId: haji, scope: 'Plumbing', rateType: 'LUMPSUM' })).body.data;

    const clientId = uuidv7();
    const body = { assignmentId: sub.id, date: today(), description: 'First floor slab', quantity: '1250.5', clientId };
    const rec = await api().post(`/api/v1/projects/${s.dha}/work-measurements`).set(s.m).send(body);
    expect(rec.status).toBe(201);
    expect(rec.body.data).toMatchObject({ quantity: 1250.5, unit: 'sqft', status: 'RECORDED' });
    expect(rec.body.data).not.toHaveProperty('valuePaisa');
    expect((await api().post(`/api/v1/projects/${s.dha}/work-measurements`).set(s.m).send(body)).status).toBe(200);
    expect((await api().post(`/api/v1/projects/${s.dha}/work-measurements`).set(s.m).send({ ...body, clientId: undefined, assignmentId: lump.id })).body.error.code).toBe(
      'LUMPSUM_USES_PROGRESS',
    );
    const second = await api().post(`/api/v1/projects/${s.dha}/work-measurements`).set(s.m).send({ ...body, clientId: undefined, quantity: 10 });

    expect((await api().post(`/api/v1/work-measurements/${rec.body.data.id}/verify`).set(s.m)).status).toBe(403);
    const ok = await api().post(`/api/v1/work-measurements/${rec.body.data.id}/verify`).set(await pm());
    expect(ok.body.data).toMatchObject({ status: 'VERIFIED', valuePaisa: '5627250' }); // 1,250.5 × 45
    expect((await api().post(`/api/v1/work-measurements/${rec.body.data.id}/verify`).set(s.o)).body.error.code).toBe('MEASUREMENT_NOT_PENDING');
    expect((await api().post(`/api/v1/work-measurements/${second.body.data.id}/reject`).set(s.o).send({})).status).toBe(400);
    expect((await api().post(`/api/v1/work-measurements/${second.body.data.id}/reject`).set(s.o).send({ note: 'Measured twice' })).body.data.status).toBe('REJECTED');

    const ledger = await api().get(`/api/v1/subcontract-assignments/${sub.id}/ledger`).set(s.o);
    expect(ledger.body.data.entries).toEqual([expect.objectContaining({ type: 'WORK_VALUE', amountPaisa: '5627250', refType: 'MEASUREMENT' })]);
    expect(ledger.body.data.account).toMatchObject({ valuePaisa: '5627250', retentionHeldPaisa: '281363', balanceDuePaisa: '5345887' });
    const list = await api().get(`/api/v1/projects/${s.dha}/work-measurements`).set(s.o).query({ status: 'VERIFIED' });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.pendingCount).toBe(0);
  });
});
