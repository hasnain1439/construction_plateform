/**
 * Step 13 · schedule API: seeded DHA schedule, generate (needs an APPROVED estimate; off days and
 * holidays skipped), baseline immutability, re-plan keeps the baseline, milestone edits (dry run,
 * cycles), progress (status flow, stage-lock warning), stoppages (photo, overlap, approve pushes
 * successors), delay buckets, quotas planned vs used, sync (pull tables, idempotent mutations),
 * permissions (Munshi never sees money) and audit rows.
 */
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { weekdayOf } from '../../src/modules/schedule/calendar.js';
import { api, bearer, loginMobile, loginMunshi, pngBytes, SEED, upload, useFreshDatabase, withSeedSnapshot } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const munshi = async () => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const todayPk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Milestone = { id: string; key: string; status: string; progressPercent: number; plannedStart: string; plannedEnd: string; baselineEnd: string | null; curingDays: number; quotas: Array<{ materialId: string | null; plannedQty: number; usedQty: number; unit: string }>; dependsOn: Array<{ milestoneId: string; key: string; type: string; lagDays: number }>; billingStage: { id: string; label: string } | null };
type Detail = { schedule: { id: string; version: number } | null; canGenerate: boolean; milestones: Milestone[]; stages: Array<{ stageKey: string; status: string }>; stoppages: Array<{ id: string; reason: string; status: string }>; baseline: { id: string; plannedEnd: string } | null; plannedEnd: string; projectedEnd: string; calendar: { holidays: Array<{ date: string; name: string }> } };
const getSchedule = async (auth: Record<string, string>, projectId: string) => {
  const res = await api().get(`/api/v1/projects/${projectId}/schedule`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Detail;
};
const photo = async (token: Record<string, string>) => {
  const res = await upload(token['Authorization']!.slice(7), 'SITE_PHOTO', pngBytes(), 'site.png');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};
const noMoney = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/Paisa/);

describe('seeded schedule (DHA Phase 6 · 10 Marla)', () => {
  it('generated from the approved estimate with a frozen baseline, site progress and stoppages', async () => {
    const dha = seeded().projects.dha.id;
    const d = await getSchedule(await owner(), dha);
    expect(d.schedule).not.toBeNull();
    expect(d.schedule!.version).toBeGreaterThanOrEqual(2); // GENERATED + STOPPAGE_APPROVED
    const by = new Map(d.milestones.map((m) => [m.key, m]));
    expect(by.get('FOUNDATION_PLINTH.FOUNDATION')!.status).toBe('DONE');
    expect(by.get('GF_STRUCTURE.SLAB')!.status).toBe('DONE');
    expect(by.get('F1_STRUCTURE.WALLS')!.status).toBe('CURING');
    expect(by.get('F1_STRUCTURE.SLAB')).toMatchObject({ status: 'IN_PROGRESS', progressPercent: 20, curingDays: 14 });
    expect(by.get('F1_STRUCTURE.SLAB')!.dependsOn).toEqual([expect.objectContaining({ key: 'F1_STRUCTURE.WALLS', type: 'FS', lagDays: 7 })]);
    expect(by.get('F1_STRUCTURE.WALLS')!.billingStage!.label).toContain('first floor');
    expect(d.stoppages.map((s) => [s.reason, s.status]).sort()).toEqual([
      ['RAIN', 'APPROVED'],
      ['SMOG_BAN', 'PENDING'],
    ]);
    expect(d.baseline).not.toBeNull();
    expect(d.stages.find((s) => s.stageKey === 'GF_STRUCTURE')!.status).toBe('DONE');
    // the plan is behind the baseline
    expect(d.plannedEnd > d.baseline!.plannedEnd).toBe(true);
    // quotas from the estimate lines (steel converted to the material's unit)
    expect(by.get('GF_STRUCTURE.SLAB')!.quotas.find((q) => q.unit === 'ton')!.plannedQty).toBeGreaterThan(3);
  });

  it('the Munshi sees the schedule and Aaj without any money', async () => {
    const auth = await munshi();
    const dha = seeded().projects.dha.id;
    const d = await getSchedule(auth, dha);
    noMoney(d);
    const today = await api().get(`/api/v1/projects/${dha}/schedule/today`).set(auth);
    expect(today.status).toBe(200);
    expect(today.body.data.today.map((m: Milestone) => m.key)).toEqual(expect.arrayContaining(['F1_STRUCTURE.WALLS', 'F1_STRUCTURE.SLAB']));
    noMoney(today.body);
    for (const p of ['quotas', 'delays', 'baseline', 'versions']) {
      const r = await api().get(`/api/v1/projects/${dha}/schedule/${p}`).set(auth);
      expect(r.status, p).toBe(200);
      noMoney(r.body);
    }
    // ...but cannot plan or approve
    expect((await api().post(`/api/v1/projects/${dha}/schedule/replan`).set(auth).send({ note: 'try' })).body.error.code).toBe('PERMISSION_DENIED');
    const smog = (await getSchedule(auth, dha)).stoppages.find((s) => s.reason === 'SMOG_BAN')!;
    expect((await api().post(`/api/v1/stoppages/${smog.id}/approve`).set(auth).send({})).status).toBe(403);
  });
});

describe('generate', () => {
  it('needs an APPROVED estimate; skips off days (Friday off) and holidays; one schedule per project; audited', async () => {
    const s = seeded();
    const auth = await owner();
    const johar = s.projects.johar.id;
    const none = await api().post(`/api/v1/projects/${johar}/schedule/generate`).set(auth).send({});
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NO_APPROVED_ESTIMATE');
    expect((await getSchedule(auth, johar)).canGenerate).toBe(false);

    const est = await api().post(`/api/v1/projects/${johar}/estimates`).set(auth).send({});
    expect(est.status, JSON.stringify(est.body)).toBe(201);
    expect((await api().post(`/api/v1/estimates/${est.body.data.id}/approve`).set(auth).send({ confirmOutdatedRates: true })).status).toBe(200);
    expect((await getSchedule(auth, johar)).canGenerate).toBe(true);

    // Friday off + a company holiday
    expect((await api().patch('/api/v1/company/settings').set(auth).send({ workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'SATURDAY', 'SUNDAY'] })).status).toBe(200);
    await prismaAdmin.companyHoliday.create({ data: { tenantId: s.malik.id, name: 'Site picnic', startDate: new Date('2026-01-14T00:00:00Z') } }); // (the API only takes future holidays)

    const res = await api().post(`/api/v1/projects/${johar}/schedule/generate`).set(auth).send({ startDate: '2026-01-12', teams: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const d = res.body.data as Detail;
    expect(d.milestones.length).toBeGreaterThan(6);
    for (const m of d.milestones) {
      expect(weekdayOf(m.plannedStart), m.key).not.toBe('FRIDAY');
      expect(weekdayOf(m.plannedEnd), m.key).not.toBe('FRIDAY');
      expect(m.plannedStart).not.toBe('2026-01-14');
      expect(m.plannedEnd >= m.plannedStart).toBe(true);
    }
    expect(d.milestones[0]!.plannedStart).toBe('2026-01-12');
    expect(d.calendar.holidays).toEqual(expect.arrayContaining([expect.objectContaining({ date: '2026-01-14', name: 'Site picnic' })]));
    // dependencies hold (FS: start after the predecessor end + lag)
    const byId = new Map(d.milestones.map((m) => [m.id, m]));
    for (const m of d.milestones) {
      for (const dep of m.dependsOn) {
        const p = byId.get(dep.milestoneId)!;
        if (dep.type === 'FS') expect(m.plannedStart > plus(p.plannedEnd, dep.lagDays), `${m.key} after ${p.key}`).toBe(true);
        else expect(m.plannedStart >= plus(p.plannedStart, dep.lagDays)).toBe(true);
      }
    }
    expect(d.baseline!.plannedEnd).toBe(d.plannedEnd);
    const again = await api().post(`/api/v1/projects/${johar}/schedule/generate`).set(auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'SCHEDULE_EXISTS', details: { scheduleId: d.schedule!.id } });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'schedule.generate', entityId: d.schedule!.id } })).toBe(1);
  });
});

describe('baseline and re-plan', () => {
  it('the baseline and plan versions are immutable for the app role', async () => {
    const s = seeded();
    const b = await prismaAdmin.scheduleBaseline.findFirstOrThrow({ where: { projectId: s.projects.dha.id } });
    await expect(withTenant(s.malik.id, (tx) => tx.scheduleBaseline.update({ where: { id: b.id }, data: { plannedEnd: new Date('2030-01-01') } }))).rejects.toThrow(/permission denied/i);
    await expect(withTenant(s.malik.id, (tx) => tx.scheduleBaseline.delete({ where: { id: b.id } }))).rejects.toThrow(/permission denied/i);
    const v = await prismaAdmin.schedulePlanVersion.findFirstOrThrow({ where: { projectId: s.projects.dha.id } });
    await expect(withTenant(s.malik.id, (tx) => tx.schedulePlanVersion.update({ where: { id: v.id }, data: { note: 'x' } }))).rejects.toThrow(/permission denied/i);
  });

  it('re-plan from today records a new version and keeps the baseline; edits shift successors (dry run saves nothing)', async () => {
    const s = seeded();
    const auth = await pm();
    const dha = s.projects.dha.id;
    const before = await prismaAdmin.scheduleBaseline.findFirstOrThrow({ where: { projectId: dha } });
    const d0 = await getSchedule(auth, dha);
    const res = await api().post(`/api/v1/projects/${dha}/schedule/replan`).set(auth).send({ note: 'Rain week and late steel' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d1 = res.body.data as Detail;
    expect(d1.schedule!.version).toBe(d0.schedule!.version + 1);
    const today = todayPk();
    for (const m of d1.milestones.filter((x) => x.status === 'PLANNED')) expect(m.plannedStart >= today, m.key).toBe(true);
    const after = await prismaAdmin.scheduleBaseline.findFirstOrThrow({ where: { projectId: dha } });
    expect(after).toEqual(before);
    const versions = (await api().get(`/api/v1/projects/${dha}/schedule/versions`).set(auth)).body.data as Array<{ version: number; reason: string }>;
    expect(versions[0]).toMatchObject({ version: d1.schedule!.version, reason: 'REPLANNED' });

    // drag the mumty 10 days later: dry run first
    const mumty = d1.milestones.find((m) => m.key === 'MUMTY_ROOF.STRUCTURE')!;
    const waterproofing = d1.milestones.find((m) => m.key === 'MUMTY_ROOF.WATERPROOFING')!;
    const target = plus(mumty.plannedStart, 10);
    const dry = await api().patch(`/api/v1/milestones/${mumty.id}`).set(auth).send({ startNoEarlierThan: target, dryRun: true });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.data.dryRun).toBe(true);
    expect(dry.body.data.shifted.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['MUMTY_ROOF.STRUCTURE', 'MUMTY_ROOF.WATERPROOFING']));
    expect((await prismaAdmin.milestone.findUniqueOrThrow({ where: { id: mumty.id } })).plannedStart.toISOString().slice(0, 10)).toBe(mumty.plannedStart);
    const saved = await api().patch(`/api/v1/milestones/${mumty.id}`).set(auth).send({ startNoEarlierThan: target });
    expect(saved.status).toBe(200);
    expect(saved.body.data.milestone.plannedStart >= target).toBe(true);
    const wp = await prismaAdmin.milestone.findUniqueOrThrow({ where: { id: waterproofing.id } });
    expect(wp.plannedStart.toISOString().slice(0, 10) > waterproofing.plannedStart).toBe(true);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'milestone.update', entityId: mumty.id } })).toBe(1);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'schedule.replan' } })).toBe(1);
    expect(await prismaAdmin.scheduleBaseline.findFirstOrThrow({ where: { projectId: dha } })).toEqual(before);

    // a dependency loop is refused
    const loop = await api().patch(`/api/v1/milestones/${mumty.id}`).set(auth).send({ dependsOn: [{ milestoneId: waterproofing.id, type: 'FS', lagDays: 0 }] });
    expect(loop.status).toBe(400);
    expect(loop.body.error.code).toBe('DEPENDENCY_CYCLE');
    // a finished milestone's dates come from the site
    const done = d1.milestones.find((m) => m.status === 'DONE')!;
    expect((await api().patch(`/api/v1/milestones/${done.id}`).set(auth).send({ workDays: 3 })).body.error.code).toBe('MILESTONE_DONE');
  });
});

describe('progress from site', () => {
  it('status flow: start, curing at 100 %, blocked needs a note, invalid changes refused; audited', async () => {
    const s = seeded();
    const auth = await munshi();
    const d = await getSchedule(await owner(), s.projects.dha.id);
    const mumty = d.milestones.find((m) => m.key === 'MUMTY_ROOF.STRUCTURE')!;
    const url = `/api/v1/milestones/${mumty.id}/progress`;
    const start = await api().post(url).set(auth).send({ progressPercent: 10, note: 'Mumty columns started' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.data.milestone).toMatchObject({ status: 'IN_PROGRESS', progressPercent: 10, actualStart: todayPk() });
    noMoney(start.body);
    expect((await api().post(url).set(auth).send({ status: 'BLOCKED' })).body.error.code).toBe('NOTE_REQUIRED');
    expect((await api().post(url).set(auth).send({ progressPercent: 50, date: plus(todayPk(), 2) })).body.error.code).toBe('DATE_IN_FUTURE');
    const cast = await api().post(url).set(auth).send({ progressPercent: 100 });
    expect(cast.body.data.milestone).toMatchObject({ status: 'CURING', progressPercent: 100, actualEnd: todayPk() });
    const doneRes = await api().post(url).set(auth).send({ status: 'DONE' });
    expect(doneRes.body.data.milestone.status).toBe('DONE');
    const back = await api().post(url).set(auth).send({ status: 'IN_PROGRESS' });
    expect(back.status).toBe(409);
    expect(back.body.error).toMatchObject({ code: 'INVALID_STATUS_CHANGE', details: { from: 'DONE', to: 'IN_PROGRESS' } });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'milestone.progress', entityId: mumty.id } })).toBe(3);
    const detail = await api().get(`/api/v1/milestones/${mumty.id}`).set(auth);
    expect(detail.body.data.updates.map((u: { status: string }) => u.status)).toEqual(['DONE', 'CURING', 'IN_PROGRESS']);
  });

  it('stage-lock warning: starting the first-floor stage while the ground-floor invoice is unpaid (event + notification, never blocks)', async () => {
    const s = seeded();
    await withSeedSnapshot('malik_demo', s); // billing: the ground-floor slab invoice has a balance
    const dha = s.projects.dha.id;
    const walls = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: dha, key: 'F1_STRUCTURE.WALLS' } });
    expect(walls.billingStageId).not.toBeNull();
    await prismaAdmin.milestone.update({ where: { id: walls.id }, data: { status: 'PLANNED', progressPercent: 0, actualStart: null, actualEnd: null } });
    const res = await api().post(`/api/v1/milestones/${walls.id}/progress`).set(await munshi()).send({ status: 'IN_PROGRESS' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.milestone.status).toBe('IN_PROGRESS');
    const w = res.body.data.warnings.find((x: { code: string }) => x.code === 'PREVIOUS_STAGE_UNPAID');
    expect(w).toBeDefined();
    expect(w.details.stages[0].label).toContain('ground floor');
    expect(w.details.stages[0]).not.toHaveProperty('balancePaisa'); // the Munshi never sees money
    const ev = await prismaAdmin.billingEvent.findFirstOrThrow({ where: { refId: walls.id, type: 'PREVIOUS_STAGE_UNPAID' } });
    expect(ev.refType).toBe('MILESTONE');
    expect(await prismaAdmin.notification.count({ where: { refId: walls.id, type: 'PREVIOUS_STAGE_UNPAID', user: { role: 'THEKEDAR' } } })).toBeGreaterThan(0);
    expect(await prismaAdmin.notification.count({ where: { refId: walls.id, user: { role: 'MUNSHI' } } })).toBe(0);

    // the owner sees the balance
    await prismaAdmin.milestone.update({ where: { id: walls.id }, data: { status: 'PLANNED', progressPercent: 0, actualStart: null } });
    const asOwner = await api().post(`/api/v1/milestones/${walls.id}/progress`).set(await owner()).send({ status: 'IN_PROGRESS' });
    expect(asOwner.body.data.warnings.find((x: { code: string }) => x.code === 'PREVIOUS_STAGE_UNPAID').details.stages[0].balancePaisa).toMatch(/^\d+$/);
  });
});

describe('stoppage days and delays', () => {
  it('photo required (except HOLIDAY), overlaps refused, approval pushes the not-done milestones; audited', async () => {
    const s = seeded();
    const dha = s.projects.dha.id;
    const m = await munshi();
    const day = plus(todayPk(), -1); // inside the in-progress first-floor slab
    const noPhoto = await api().post(`/api/v1/projects/${dha}/stoppages`).set(m).send({ dates: [day], reason: 'RAIN' });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.error.code).toBe('PHOTO_REQUIRED');
    const created = await api().post(`/api/v1/projects/${dha}/stoppages`).set(m).send({ from: day, to: plus(day, 1), reason: 'LABOUR_SHORT', note: 'Mistris went home for Eid', photoAttachmentIds: [await photo(m)] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'PENDING', category: 'CONTRACTOR', dates: [day, plus(day, 1)] });
    const overlap = await api().post(`/api/v1/projects/${dha}/stoppages`).set(m).send({ dates: [plus(day, 1)], reason: 'HOLIDAY' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toMatchObject({ code: 'STOPPAGE_OVERLAP', details: { dates: [plus(day, 1)] } });
    const holiday = await api().post(`/api/v1/projects/${dha}/stoppages`).set(m).send({ dates: [plus(todayPk(), 3)], reason: 'HOLIDAY', note: 'Local Urs' });
    expect(holiday.status).toBe(201);

    const auth = await owner();
    const slab = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: dha, key: 'F1_STRUCTURE.SLAB' } });
    const mumty = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: dha, key: 'MUMTY_ROOF.STRUCTURE' } });
    const approve = await api().post(`/api/v1/stoppages/${created.body.data.id}/approve`).set(auth).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.data.stoppage.status).toBe('APPROVED');
    const keys = approve.body.data.shifted.map((x: { key: string }) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['F1_STRUCTURE.SLAB', 'MUMTY_ROOF.STRUCTURE']));
    expect((await prismaAdmin.milestone.findUniqueOrThrow({ where: { id: slab.id } })).plannedEnd > slab.plannedEnd).toBe(true);
    expect((await prismaAdmin.milestone.findUniqueOrThrow({ where: { id: mumty.id } })).plannedStart > mumty.plannedStart).toBe(true);
    // done milestones never move
    expect(keys).not.toContain('GF_STRUCTURE.SLAB');
    expect((await api().post(`/api/v1/stoppages/${created.body.data.id}/approve`).set(auth).send({})).body.error.code).toBe('STOPPAGE_NOT_PENDING');
    const reject = await api().post(`/api/v1/stoppages/${holiday.body.data.id}/reject`).set(auth).send({ note: 'Site worked that day' });
    expect(reject.body.data.status).toBe('REJECTED');
    for (const action of ['stoppage.create', 'stoppage.approve', 'stoppage.reject']) expect(await prismaAdmin.auditLog.count({ where: { action, details: { path: ['projectId'], equals: dha } } }), action).toBeGreaterThan(0);
  });

  it('delay buckets: owner / excusable days move the revised end, contractor = projected past revised', async () => {
    const s = seeded();
    const dha = s.projects.dha.id;
    const auth = await owner();
    const before = (await api().get(`/api/v1/projects/${dha}/schedule/delays`).set(auth)).body.data;
    expect(before.originalEnd).toBe('2027-02-15'); // contract end
    expect(before.days.excusable).toBe(2); // the seeded rain (2 working days)
    expect(before.categories.find((c: { category: string }) => c.category === 'EXCUSABLE').reasons[0]).toMatchObject({ reason: 'RAIN', days: 2 });
    expect(before.pending.map((p: { reason: string }) => p.reason)).toEqual(['SMOG_BAN']);
    expect(before.revisedEnd > before.originalEnd).toBe(true);

    const hold = await api()
      .post(`/api/v1/projects/${dha}/stoppages`)
      .set(auth)
      .send({ dates: [plus(todayPk(), -20), plus(todayPk(), -19), plus(todayPk(), -18)], reason: 'OWNER_HOLD', note: 'Owner stopped work for the design change', photoAttachmentIds: [await photo(auth)] });
    expect(hold.status, JSON.stringify(hold.body)).toBe(201);
    expect((await api().post(`/api/v1/stoppages/${hold.body.data.id}/approve`).set(auth).send({})).status).toBe(200);
    const after = (await api().get(`/api/v1/projects/${dha}/schedule/delays`).set(auth)).body.data;
    expect(after.days.owner).toBe(hold.body.data.days);
    expect(after.days.owner).toBeGreaterThan(0);
    expect(after.revisedEnd > before.revisedEnd).toBe(true);
    expect(after.days.contractor).toBe(Math.max(0, after.days.contractor));
    expect(after.days.total).toBe(after.days.owner + after.days.excusable + after.days.contractor + after.days.changeOrders);
    if (after.projectedEnd > after.revisedEnd) expect(after.days.contractor).toBeGreaterThan(0);
  });
});

describe('quotas: planned vs used', () => {
  it('usage linked to a milestone counts as used; another project’s milestone is refused', async () => {
    const s = seeded();
    await withSeedSnapshot('malik_stock_labor', s); // site stock at DHA
    const dha = s.projects.dha.id;
    const m = await munshi();
    const slab = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: dha, key: 'F1_STRUCTURE.SLAB' }, include: { quotas: true } });
    const stock = await prismaAdmin.stockMovement.groupBy({ by: ['materialId'], where: { location: { projectId: dha } }, _sum: { quantity: true } });
    const quota = slab.quotas.find((q) => q.materialId && stock.some((x) => x.materialId === q.materialId && Number(x._sum.quantity) >= 5))!;
    expect(quota).toBeDefined();
    const used = await api().post(`/api/v1/projects/${dha}/material-usage`).set(m).send({ usageDate: todayPk(), items: [{ materialId: quota.materialId, qty: 5 }], milestoneId: slab.id });
    expect(used.status, JSON.stringify(used.body)).toBe(201);
    const q = (await api().get(`/api/v1/projects/${dha}/schedule/quotas`).set(m)).body.data;
    const row = q.milestones.find((x: { milestone: { id: string } }) => x.milestone.id === slab.id).quotas.find((x: { materialId: string }) => x.materialId === quota.materialId);
    expect(row.usedQty).toBeGreaterThanOrEqual(5);
    expect(row.remainingQty).toBeCloseTo(Math.max(0, row.plannedQty - row.usedQty), 3);
    noMoney(q);

    // a milestone of another project
    const other = await prismaAdmin.milestone.findFirst({ where: { projectId: { not: dha } } });
    const fake = other?.id ?? uuidv7();
    const bad = await api().post(`/api/v1/projects/${dha}/material-usage`).set(m).send({ usageDate: todayPk(), items: [{ materialId: quota.materialId, qty: 1 }], milestoneId: fake });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_MILESTONE');
  });
});

describe('sync', () => {
  it('pull: milestones (quota, no money) and stoppages for the Munshi’s projects', async () => {
    const s = await loginMunshi(seeded().malik.id);
    const res = await api().get('/api/v1/sync/pull').set(bearer(s.accessToken));
    expect(res.status).toBe(200);
    const ms = res.body.data.changes.milestones.upserts as Array<Record<string, unknown>>;
    expect(ms.length).toBeGreaterThan(3);
    expect(ms.every((x) => x['projectId'] === seeded().projects.dha.id)).toBe(true);
    expect(ms.find((x) => x['key'] === 'F1_STRUCTURE.SLAB')).toMatchObject({ status: 'IN_PROGRESS', quotas: expect.arrayContaining([expect.objectContaining({ plannedQty: expect.any(Number), usedQty: 0 })]) });
    expect(res.body.data.changes.stoppages.upserts.map((x: { reason: string }) => x.reason).sort()).toEqual(['RAIN', 'SMOG_BAN']);
    noMoney(res.body.data.changes.milestones);
    noMoney(res.body.data.changes.stoppages);
  });

  it('push: MILESTONE_PROGRESS and STOPPAGE_LOG are idempotent by clientId; incremental pull sends the change', async () => {
    const s = await loginMunshi(seeded().malik.id);
    const auth = bearer(s.accessToken);
    const dha = seeded().projects.dha.id;
    const first = await api().get('/api/v1/sync/pull').set(auth);
    const cursor = first.body.data.cursor as string;
    const slab = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: dha, key: 'F1_STRUCTURE.SLAB' } });
    // photo uploaded offline with its own clientId
    const photoClient = uuidv7();
    const up = await api().post('/api/v1/attachments').set(auth).field('kind', 'SITE_PHOTO').field('clientId', photoClient).attach('file', pngBytes(), { filename: 'rain.png', contentType: 'image/png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const batch = [
      { clientId: uuidv7(), type: 'MILESTONE_PROGRESS', payload: { milestoneId: slab.id, progressPercent: 45, note: 'Steel binding' }, deviceCreatedAt: new Date().toISOString() },
      { clientId: uuidv7(), type: 'STOPPAGE_LOG', payload: { projectId: dha, dates: [plus(todayPk(), -12)], reason: 'RAIN', photoAttachmentIds: [photoClient] }, deviceCreatedAt: new Date().toISOString() },
    ];
    const r1 = await api().post('/api/v1/sync/push').set(auth).send({ mutations: batch });
    expect(r1.status).toBe(200);
    expect(r1.body.data.results.map((x: { status: string }) => x.status), JSON.stringify(r1.body)).toEqual(['APPLIED', 'APPLIED']);
    const r2 = await api().post('/api/v1/sync/push').set(auth).send({ mutations: batch });
    expect(r2.body.data.results.map((x: { status: string }) => x.status)).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(r2.body.data.results.map((x: { serverId: string }) => x.serverId)).toEqual(r1.body.data.results.map((x: { serverId: string }) => x.serverId));
    expect(await prismaAdmin.milestoneUpdate.count({ where: { clientId: batch[0]!.clientId } })).toBe(1);
    expect(await prismaAdmin.stoppageDay.count({ where: { clientId: batch[1]!.clientId } })).toBe(1);
    expect((await prismaAdmin.milestone.findUniqueOrThrow({ where: { id: slab.id } })).progressPercent).toBe(45);
    const st = await prismaAdmin.stoppageDay.findFirstOrThrow({ where: { clientId: batch[1]!.clientId } });
    expect(st.photoAttachmentIds).toEqual([up.body.data.id]);

    const inc = await api().get(`/api/v1/sync/pull?cursor=${cursor}`).set(auth);
    expect(inc.body.data.changes.milestones.upserts.map((x: { id: string }) => x.id)).toContain(slab.id);
    expect(inc.body.data.changes.stoppages.upserts.map((x: { id: string }) => x.id)).toContain(st.id);
  });

  it('push without the permission is REJECTED (Store-Keeper-like role has no schedule keys)', async () => {
    const s = seeded();
    const munshiUser = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: s.malik.id, phone: SEED.malik.munshi.phone } });
    await prismaAdmin.userPermissionOverride.create({ data: { tenantId: s.malik.id, userId: munshiUser.id, permissionKey: 'schedule.progress.edit', effect: 'DENY' } });
    await prismaAdmin.user.update({ where: { id: munshiUser.id }, data: { permVersion: { increment: 1 } } });
    const auth = bearer((await loginMunshi(s.malik.id)).accessToken);
    const slab = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: s.projects.dha.id, key: 'F1_STRUCTURE.SLAB' } });
    const r = await api().post('/api/v1/sync/push').set(auth).send({ mutations: [{ clientId: uuidv7(), type: 'MILESTONE_PROGRESS', payload: { milestoneId: slab.id, progressPercent: 50 } }] });
    expect(r.body.data.results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'PERMISSION_DENIED' } });
  });
});
