import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { addDays, api, assign, lastWeek, mark, munshi, owner, pm, rs, subcontractorId, thisWeek, today, workerId } from './fixtures.js';

const seeded = useFreshDatabase();

const ids = async () => {
  const t = seeded().malik.id;
  return {
    t,
    dha: seeded().projects.dha.id,
    bahria: seeded().projects.bahria.id,
    akram: await workerId(t, 'Ustad Akram'),
    shahid: await workerId(t, 'Shahid'),
    riaz: await workerId(t, 'Riaz'),
    pervaiz: await workerId(t, 'Pervaiz'),
  };
};

describe('B1 — team on site', () => {
  it('office overrides the rate; a munshi assigns at the default rate only; duplicates → 409; outside → 404', async () => {
    const s = await ids();
    const o = await owner();
    const m = await munshi(s.t);

    const akram = await assign(o, s.dha, s.akram, rs(2800));
    expect(akram).toMatchObject({ dailyRatePaisa: rs(2800), defaultRatePaisa: rs(3000), rateOverridden: true, startDate: today(), isActive: true });

    const changed = await api().post(`/api/v1/projects/${s.dha}/labor/workers`).set(m).send({ workerId: s.shahid, dailyRatePaisa: rs(1700) });
    expect(changed.status).toBe(403);
    expect(changed.body.error.code).toBe('RATE_CHANGE_NOT_ALLOWED');
    const same = await api().post(`/api/v1/projects/${s.dha}/labor/workers`).set(m).send({ workerId: s.shahid, dailyRatePaisa: rs(1600) });
    expect(same.status).toBe(201);
    expect(same.body.data).toMatchObject({ dailyRatePaisa: rs(1600), rateOverridden: false });

    const dup = await api().post(`/api/v1/projects/${s.dha}/labor/workers`).set(m).send({ workerId: s.shahid });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WORKER_ALREADY_ASSIGNED');
    const inactive = await api().post(`/api/v1/projects/${s.dha}/labor/workers`).set(o).send({ workerId: s.pervaiz });
    expect(inactive.body.error.code).toBe('INVALID_WORKER');

    // Rafaqat is not on Bahria; a munshi can't edit / remove assignments
    expect((await api().post(`/api/v1/projects/${s.bahria}/labor/workers`).set(m).send({ workerId: s.riaz })).status).toBe(404);
    expect((await api().get(`/api/v1/projects/${s.bahria}/labor/workers`).set(m)).status).toBe(404);
    expect((await api().patch(`/api/v1/project-workers/${akram.id}`).set(m).send({ dailyRatePaisa: rs(5000) })).status).toBe(403);

    const list = await api().get(`/api/v1/projects/${s.dha}/labor/workers`).set(m);
    expect(list.body.data.map((w: { worker: { name: string } }) => w.worker.name)).toEqual(['Shahid', 'Ustad Akram']);

    const patched = await api().patch(`/api/v1/project-workers/${akram.id}`).set(await pm()).send({ dailyRatePaisa: rs(2900) });
    expect(patched.body.data.dailyRatePaisa).toBe(rs(2900));
    expect(await prismaAdmin.auditLog.count({ where: { action: { startsWith: 'labor.worker' } } })).toBe(3);
  });

  it('removing: never worked → deleted; with hazri → taken off (kept for history)', async () => {
    const s = await ids();
    const o = await owner();
    const shahid = await assign(o, s.dha, s.shahid);
    const riaz = await assign(o, s.dha, s.riaz);
    await mark(o, s.dha, today(), [{ workerId: s.riaz, status: 'FULL' }]);

    expect((await api().delete(`/api/v1/project-workers/${shahid.id}`).set(o)).body.data).toMatchObject({ removed: true });
    const kept = await api().delete(`/api/v1/project-workers/${riaz.id}`).set(o);
    expect(kept.body.data).toMatchObject({ removed: false, deactivated: true, assignment: { isActive: false, endDate: today() } });
    // Back-filling a day before they left still works; after → not assigned
    expect((await mark(o, s.dha, today(), [{ workerId: s.riaz, status: 'HALF' }])).status).toBe(200);
    expect((await mark(o, s.dha, today(), [{ workerId: s.shahid, status: 'FULL' }])).body.error.code).toBe('WORKER_NOT_ASSIGNED');
  });

  it('sub-contracts: rate from the labour rate list, lump-sum value too; MUNSHI sees no money and cannot assign', async () => {
    const s = await ids();
    const o = await owner();
    const sharif = await subcontractorId(s.t, 'Ustad Sharif Shuttering');
    const haji = await subcontractorId(s.t, 'Haji Plumbing Works');

    const res = await api().post(`/api/v1/projects/${s.dha}/labor/subcontracts`).set(o).send({ subcontractorId: sharif, scope: 'Slab shuttering', rateType: 'PER_SQFT' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ rateType: 'PER_SQFT', unit: 'sqft', ratePaisa: rs(45), contractValuePaisa: null, retentionPercent: 5 });
    const lump = await api().post(`/api/v1/projects/${s.dha}/labor/subcontracts`).set(o).send({ subcontractorId: haji, scope: 'Plumbing rough-in', rateType: 'LUMPSUM' });
    expect(lump.body.data).toMatchObject({ ratePaisa: null, contractValuePaisa: rs(120000), unit: '%' });
    const wrongUnit = await api().post(`/api/v1/projects/${s.dha}/labor/subcontracts`).set(o).send({ subcontractorId: sharif, scope: 'x shuttering', rateType: 'PER_TON' });
    expect(wrongUnit.body.error.code).toBe('RATE_REQUIRED');

    const m = await munshi(s.t);
    expect((await api().post(`/api/v1/projects/${s.dha}/labor/subcontracts`).set(m).send({ subcontractorId: sharif, scope: 'Slab', rateType: 'PER_SQFT' })).status).toBe(403);
    const seen = await api().get(`/api/v1/projects/${s.dha}/labor/subcontracts`).set(m);
    expect(seen.body.data).toHaveLength(2);
    for (const row of seen.body.data) {
      expect(row).not.toHaveProperty('ratePaisa');
      expect(row).not.toHaveProperty('contractValuePaisa');
    }
    const upd = await api().patch(`/api/v1/subcontract-assignments/${res.body.data.id}`).set(o).send({ ratePaisa: rs(48), retentionPercent: 10 });
    expect(upd.body.data).toMatchObject({ ratePaisa: rs(48), retentionPercent: 10 });
    expect((await api().patch(`/api/v1/subcontract-assignments/${lump.body.data.id}`).set(o).send({ ratePaisa: rs(5) })).body.error.code).toBe('LUMPSUM_HAS_NO_RATE');
  });
});

describe('B2 — hazri', () => {
  it('bulk upsert by the munshi; unassigned / future / too old → 400; grid and today totals', async () => {
    const s = await ids();
    const o = await owner();
    const m = await munshi(s.t);
    await assign(o, s.dha, s.akram, rs(2800));
    await assign(o, s.dha, s.shahid);

    const first = await mark(m, s.dha, today(), [
      { workerId: s.akram, status: 'FULL', overtimeHours: 2 },
      { workerId: s.shahid, status: 'HALF' },
    ]);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ created: 2, updated: 0, day: { assigned: 2, marked: 2, full: 1, half: 1, unmarked: 0, overtimeHours: 2 } });
    const again = await mark(m, s.dha, today(), [{ workerId: s.shahid, status: 'ABSENT', overtimeHours: 3 }]);
    expect(again.body.data).toMatchObject({ created: 0, updated: 1, day: { full: 1, absent: 1 } });
    expect(again.body.data.day.workers.find((w: { worker: { id: string } }) => w.worker.id === s.shahid)).toMatchObject({ status: 'ABSENT', overtimeHours: 0 });

    expect((await mark(m, s.dha, today(), [{ workerId: s.riaz, status: 'FULL' }])).body.error).toMatchObject({ code: 'WORKER_NOT_ASSIGNED', details: { workerIds: [s.riaz] } });
    expect((await mark(m, s.dha, addDays(today(), 1), [{ workerId: s.akram, status: 'FULL' }])).body.error.code).toBe('FUTURE_DATE');
    expect((await mark(m, s.dha, addDays(today(), -8), [{ workerId: s.akram, status: 'FULL' }])).body.error.code).toBe('DATE_TOO_OLD');
    expect((await mark(o, s.dha, addDays(today(), -8), [{ workerId: s.akram, status: 'FULL' }])).status).toBe(200); // the office can
    expect((await mark(m, s.bahria, today(), [{ workerId: s.akram, status: 'FULL' }])).status).toBe(404);

    const todayRes = await api().get(`/api/v1/projects/${s.dha}/attendance/today`).set(m);
    expect(todayRes.body.data).toMatchObject({ date: today(), assigned: 2, full: 1, absent: 1, locked: false });

    const grid = await api().get(`/api/v1/projects/${s.dha}/attendance`).set(m).query({ from: thisWeek() });
    expect(grid.status).toBe(200);
    expect(grid.body.data.dates).toHaveLength(7);
    const akram = grid.body.data.workers.find((w: { worker: { id: string } }) => w.worker.id === s.akram);
    expect(akram.days[today()]).toEqual({ status: 'FULL', overtimeHours: 2, note: null, lateSync: false });
    expect(akram.totals).toMatchObject({ full: 1, daysWorked: 1, overtimeHours: 2 });
    expect((await api().get(`/api/v1/projects/${s.dha}/attendance`).set(m).query({ from: '2026-01-01', to: '2026-06-01' })).body.error.code).toBe('RANGE_TOO_LONG');
  });

  it('a submitted / approved week is locked (409 WEEK_LOCKED); returning it unlocks', async () => {
    const s = await ids();
    const o = await owner();
    await assign(o, s.dha, s.akram, rs(2800), lastWeek());
    const monday = lastWeek();
    expect((await mark(o, s.dha, monday, [{ workerId: s.akram, status: 'FULL' }])).status).toBe(200);
    const gen = await api().post(`/api/v1/projects/${s.dha}/settlements/generate`).set(o).send({ weekStart: monday });
    await api().post(`/api/v1/settlements/${gen.body.data.id}/submit`).set(o);

    const locked = await mark(o, s.dha, addDays(monday, 2), [{ workerId: s.akram, status: 'FULL' }]);
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatchObject({ code: 'WEEK_LOCKED', details: { weekStart: monday, status: 'SUBMITTED' } });
    await api().post(`/api/v1/settlements/${gen.body.data.id}/return`).set(o).send({ comment: 'Akram was on leave Wednesday' });
    expect((await mark(o, s.dha, addDays(monday, 2), [{ workerId: s.akram, status: 'ABSENT' }])).status).toBe(200);
  });
});
