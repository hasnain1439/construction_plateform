import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { dateOnly, todayIn } from '../../src/core/utils/dates.js';
import { runEquipmentIdleCheck } from '../../src/jobs/equipmentIdle.js';
import { weekStartOf } from '../../src/modules/equipment/shuttering.js';
import { bearer, loginMunshi, useFreshDatabase, withSeedSnapshot } from '../helpers.js';
import { api, owner, pm, type Auth } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  await withSeedSnapshot('malik_shuttering', seeded());
});

const today = () => todayIn('Asia/Karachi');
const tenant = () => seeded().malik.id;
const dha = () => seeded().projects.dha.id;
const johar = () => seeded().projects.johar.id;
const munshi = async (): Promise<Auth> => bearer((await loginMunshi(tenant())).accessToken);
const DAY = 86_400_000;

/** Every key anywhere in a payload. */
function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (out.add(k), keys(v, out));
  return out;
}

type Week = { weekStart: string; needed: number; ownedAvailable: number; onRent: number; available: number; shortfall: number; surplus: number };
type Suggestion = { type: string; category: string; qty: number; fromWeek: string; toWeek: string; from: { name: string } | null; fromProject: { id: string } | null; toProject: { id: string } | null; rental: { number: string } | null; equipment: { code: string } | null };
const series = (body: { data: { series: Array<{ category: string; weeks: Week[] }> } }, category: string) => body.data.series.find((s) => s.category === category)!.weeks;

describe('shuttering demand planner (Malik demo: DHA first-floor slab running, Johar Town idle)', () => {
  it('company view: slab milestones with area from the BoQ, weekly need vs owned / rented, a prop shortfall, no money', async () => {
    const res = await api().get('/api/v1/equipment/shuttering-demand').set(await owner());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ scope: 'COMPANY', project: null, from: weekStartOf(today()), weeks: 8 });
    expect(d.parameters).toEqual({ plateCoverageSqft: 6, plateCoverageSource: 'EQUIPMENT', propsPerPlate: 0.75, sparePercent: 5, beamSidesPercent: 20, defaultStrikeDays: 14 });
    expect(d.warnings).toContainEqual({ code: 'NO_SCHEDULE', project: expect.objectContaining({ id: johar() }) });

    const f1 = d.milestones.find((m: { milestone: { key: string } }) => m.milestone.key === 'F1_STRUCTURE.SLAB');
    expect(f1).toMatchObject({ project: { id: dha() }, milestone: { status: 'IN_PROGRESS', stageKey: 'F1_STRUCTURE' }, area: { source: 'BOQ' } });
    // plates = ceil(total ÷ 6 × 1.05), props = ceil(plates × 0.75); slab soffit + 20 % beam sides (frame line, % method)
    expect(f1.area.beamSqft).toBeCloseTo(f1.area.slabSqft * 0.2, 1);
    expect(f1.plates).toBe(Math.ceil((f1.area.totalSqft / 6) * 1.05 - 1e-9));
    expect(f1.props).toBe(Math.ceil(f1.plates * 0.75 - 1e-9));
    expect(f1.plates).toBe(391);
    // held from the actual start (2 days ago) through the curing lag
    expect(f1.holdFrom).toBe(new Date(Date.parse(`${today()}T00:00:00Z`) - 2 * DAY).toISOString().slice(0, 10));
    expect(f1.holdUntil > f1.milestone.plannedEnd).toBe(true);

    const plates = series(res.body, 'SHUTTERING_PLATE');
    expect(plates[0]).toMatchObject({ needed: 391, ownedAvailable: 394, onRent: 0, shortfall: 0, surplus: 3 }); // 400 − 6 missing
    const props = series(res.body, 'PROP');
    expect(props[0]).toMatchObject({ needed: 294, ownedAvailable: 100, onRent: 250, available: 350, shortfall: 0, surplus: 56 });
    // RNT-0001 (150 props, DHA) ends in 10 days → props run short while the slab is still propped
    expect(props.some((w: Week) => w.shortfall > 0)).toBe(true);
    expect(props.find((w: Week) => w.shortfall > 0)!.onRent).toBeLessThan(250);

    // Suggestions: extend RNT-0001, yard plates + props to DHA, Johar's idle plates / rented props to DHA, return the rest of RNT-0002
    const s: Suggestion[] = d.suggestions;
    const find = (type: string, category: string, pred: (x: Suggestion) => boolean = () => true) => s.find((x) => x.type === type && x.category === category && pred(x));
    expect(find('EXTEND_RENTAL', 'PROP')).toMatchObject({ qty: 150, rental: { number: 'RNT-0001' }, toProject: { id: dha() } });
    expect(find('TRANSFER', 'SHUTTERING_PLATE', (x) => x.from?.name === 'Central Store')).toMatchObject({ qty: 20, toProject: { id: dha() }, equipment: { code: 'SP-23' } });
    expect(find('TRANSFER', 'SHUTTERING_PLATE', (x) => x.fromProject?.id === johar())).toMatchObject({ qty: 127, toProject: { id: dha() } }); // 391 − 244 − 20
    expect(find('TRANSFER', 'PROP', (x) => x.from?.name === 'Central Store')).toMatchObject({ qty: 40 });
    expect(find('TRANSFER', 'PROP', (x) => x.fromProject?.id === johar())).toMatchObject({ qty: 44 }); // 294 − 210 − 40
    expect(find('RETURN_RENTAL', 'PROP')).toMatchObject({ qty: 56, rental: { number: 'RNT-0002' }, fromProject: { id: johar() } });
    expect(find('RENT', 'SHUTTERING_PLATE')).toBeUndefined();
    expect([...keys(res.body)].filter((k) => /paisa|rate/i.test(k))).toEqual([]);
  });

  it('project view (both routes): owned at the site + the yard, rented at the site; that project only', async () => {
    const auth = await owner();
    const a = await api().get(`/api/v1/projects/${dha()}/shuttering-demand`).query({ weeks: 4 }).set(auth);
    const b = await api().get('/api/v1/equipment/shuttering-demand').query({ projectId: dha(), weeks: 4 }).set(auth);
    expect(a.status).toBe(200);
    expect(b.body.data).toEqual(a.body.data);
    expect(a.body.data).toMatchObject({ scope: 'PROJECT', project: { id: dha() }, weeks: 4 });
    expect(series(a.body, 'SHUTTERING_PLATE')).toHaveLength(4);
    expect(series(a.body, 'SHUTTERING_PLATE')[0]).toMatchObject({ needed: 391, ownedAvailable: 264, onRent: 0, shortfall: 127 }); // 244 at DHA + 20 at the yard
    expect(series(a.body, 'PROP')[0]).toMatchObject({ ownedAvailable: 100, onRent: 150 });
    expect(a.body.data.milestones.every((m: { project: { id: string } }) => m.project.id === dha())).toBe(true);
    expect(a.body.data.suggestions.every((x: Suggestion) => x.toProject?.id === dha() || x.fromProject?.id === dha())).toBe(true);

    const johars = await api().get(`/api/v1/projects/${johar()}/shuttering-demand`).set(auth);
    expect(johars.body.data.milestones).toEqual([]);
    expect(johars.body.data.warnings).toEqual([{ code: 'NO_SCHEDULE', project: expect.objectContaining({ id: johar() }) }]);
    expect(series(johars.body, 'SHUTTERING_PLATE')[0]).toMatchObject({ needed: 0, ownedAvailable: 150, surplus: 150 }); // 130 at Johar + 20 at the yard
  });

  it('validation, scope and the Munshi (his project, no money)', async () => {
    const auth = await owner();
    expect((await api().get('/api/v1/equipment/shuttering-demand').query({ weeks: 27 }).set(auth)).status).toBe(400);
    expect((await api().get('/api/v1/equipment/shuttering-demand').query({ from: '16-10-2026' }).set(auth)).status).toBe(400);
    expect((await api().get('/api/v1/equipment/shuttering-demand').query({ projectId: '0199a8c0-0000-7000-8000-00000000ffff' }).set(auth)).status).toBe(404);
    const past = await api().get('/api/v1/equipment/shuttering-demand').query({ from: '2026-06-17', weeks: 2 }).set(auth);
    expect(past.status).toBe(200);
    expect(past.body.data.from).toBe('2026-06-15'); // snapped to Monday

    const m = await munshi();
    const res = await api().get('/api/v1/equipment/shuttering-demand').set(m);
    expect(res.status).toBe(200);
    const projectIds = new Set(res.body.data.milestones.map((x: { project: { id: string } }) => x.project.id));
    expect([...projectIds]).toEqual([dha()]);
    expect([...keys(res.body)].filter((k) => /paisa|rate/i.test(k))).toEqual([]);
    expect((await api().get(`/api/v1/projects/${johar()}/shuttering-demand`).set(m)).status).toBe(404);
  });
});

describe('idle-rent alert', () => {
  it('lists RNT-0002 idle at Johar Town for 12 days with the rent wasted; DHA (slab running) is not idle', async () => {
    const res = await api().get('/api/v1/equipment/idle').set(await owner());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ today: today(), thresholdDays: 5, totalDailyCostPaisa: '150000' });
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      rental: { number: 'RNT-0002', supplier: { name: 'Punjab Shuttering Yard' } },
      project: { id: johar() },
      qty: 100,
      items: [{ equipment: { code: 'PR-01' }, qty: 100, ratePaisaPerDay: '1500', dailyCostPaisa: '150000' }],
      lastActivity: null,
      hasSchedule: false,
      idleDays: 12,
      idle: true,
      dailyCostPaisa: '150000',
      idleCostPaisa: '1800000',
    });
    const all = await api().get('/api/v1/equipment/idle').query({ all: 'true' }).set(await owner());
    expect(all.body.data.items.map((i: { rental: { number: string } }) => i.rental.number)).toEqual(['RNT-0002', 'RNT-0001']);
    expect(all.body.data.items[1]).toMatchObject({ idleDays: 0, idle: false, lastActivity: { kind: 'MILESTONE_ACTIVE', date: today() } });
  });

  it('activity: progress updates and usage linked to a milestone reset the idle days', async () => {
    const auth = await owner();
    const dhaRow = async () => (await api().get('/api/v1/equipment/idle').query({ all: 'true', projectId: dha() }).set(auth)).body.data.items[0];
    // No structure milestone running any more → the latest progress update (yesterday) counts
    await prismaAdmin.milestone.updateMany({ where: { projectId: dha(), status: { in: ['IN_PROGRESS', 'CURING'] } }, data: { status: 'PLANNED' } });
    const yesterday = new Date(Date.parse(`${today()}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
    expect(await dhaRow()).toMatchObject({ lastActivity: { kind: 'PROGRESS', date: yesterday }, idleDays: 1, idle: false });
    // usage linked to a milestone today
    const site = await prismaAdmin.stockLocation.findFirstOrThrow({ where: { tenantId: tenant(), projectId: dha() } });
    const slab = await prismaAdmin.milestone.findFirstOrThrow({ where: { projectId: dha(), key: 'F1_STRUCTURE.SLAB' } });
    await prismaAdmin.materialUsage.create({ data: { tenantId: tenant(), projectId: dha(), locationId: site.id, usageDate: dateOnly(today()), milestoneId: slab.id } });
    expect(await dhaRow()).toMatchObject({ lastActivity: { kind: 'USAGE', date: today() }, idleDays: 0 });
  });

  it('seed sent EQUIPMENT_IDLE to the owner (with the daily rent) and the PM; dedupe per rental per week; threshold setting', async () => {
    const notes = () => prismaAdmin.notification.findMany({ where: { tenantId: tenant(), type: 'EQUIPMENT_IDLE' }, include: { user: { select: { role: true } } }, orderBy: { createdAt: 'asc' } });
    const first = await notes();
    expect(first.map((n) => n.user.role).sort()).toEqual(['PM', 'THEKEDAR']);
    const khalid = first.find((n) => n.user.role === 'THEKEDAR')!;
    expect(khalid).toMatchObject({ severity: 'WARNING', textKey: 'equipmentIdle', refType: 'EQUIPMENT_RENTAL', projectId: johar() });
    expect(khalid.actionUrl).toMatch(/^\/equipment\/rentals\/[0-9a-f-]{36}$/);
    expect(khalid.body).toContain('Rs 1,500');
    expect(khalid.body).toContain('12');

    // Inbox (owner, English): rendered in the reader's language
    const inbox = await api().get('/api/v1/notifications').query({ type: 'EQUIPMENT_IDLE' }).set(await owner());
    expect(inbox.status).toBe(200);
    expect(inbox.body.data[0]).toMatchObject({ type: 'EQUIPMENT_IDLE', actionUrl: khalid.actionUrl });

    // On demand: deduped (already sent today), audited; Munshi / PM without rental.manage → 403
    const auth = await owner();
    const run = await api().post('/api/v1/equipment/idle/check').set(auth);
    expect(run.status).toBe(200);
    expect(run.body.data).toMatchObject({ date: today(), thresholdDays: 5, checked: 2, idle: 1, notified: [] });
    expect(await prismaAdmin.auditLog.count({ where: { tenantId: tenant(), action: 'equipment.idle.check' } })).toBe(1);
    expect((await api().post('/api/v1/equipment/idle/check').set(await munshi())).status).toBe(403);

    // The daily job: 3 days later still deduped; 8 days later a new one
    const now = Date.now();
    expect(await runEquipmentIdleCheck(new Date(now + 3 * DAY))).toMatchObject({ idle: 1, notified: 0 });
    expect((await notes()).length).toBe(2);
    expect(await runEquipmentIdleCheck(new Date(now + 8 * DAY))).toMatchObject({ idle: 1, notified: 1 });
    expect((await notes()).length).toBe(4);

    // Threshold 20 days → nothing idle
    expect((await api().patch('/api/v1/company/settings').set(auth).send({ equipmentIdleDays: 20 })).status).toBe(200);
    const res = await api().get('/api/v1/equipment/idle').set(auth);
    expect(res.body.data).toMatchObject({ thresholdDays: 20, items: [] });
    expect((await api().post('/api/v1/equipment/idle/check').set(auth)).body.data).toMatchObject({ idle: 0, thresholdDays: 20 });
  });

  it('amounts gated by fields.rates; the Munshi sees his site only and gets no alert', async () => {
    const m = await munshi();
    const res = await api().get('/api/v1/equipment/idle').query({ all: 'true' }).set(m);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { project: { id: string } }) => i.project.id)).toEqual([dha()]);
    expect([...keys(res.body)].filter((k) => /paisa|rate/i.test(k))).toEqual([]);
    const munshiId = seeded().users.rafaqatMalik.id;
    expect(await prismaAdmin.notification.count({ where: { userId: munshiId, type: 'EQUIPMENT_IDLE' } })).toBe(0);
    // PM (Bilal) has fields.rates in the PM template
    const p = await api().get('/api/v1/equipment/idle').set(await pm());
    expect(p.status).toBe(200);
  });
});
