import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const munshi = async () => bearer((await loginMunshi(seeded().malik.id)).accessToken);
const ahmedOwner = async () => bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);

const basic = (over: Record<string, unknown> = {}) => ({
  name: 'Gulberg · 10 Marla',
  newClient: { name: 'Naveed Akhtar', phone: '0300-7654321' },
  siteAddress: 'House 12, Block B, Gulberg III',
  city: 'Lahore',
  startDate: '2026-11-01',
  endDate: '2027-08-31',
  ...over,
});

describe('POST /projects', () => {
  it('THEKEDAR creates a DRAFT with a new client, an auto code and company defaults', async () => {
    const { users } = seeded();
    const res = await api().post('/api/v1/projects').set(await owner()).send(basic({ pmId: users.bilal.id, munshiId: users.rafaqatMalik.id }));
    expect(res.status).toBe(201);
    const p = res.body.data;
    expect(p).toMatchObject({
      code: 'MSB-2026-017', // seed uses 008, 012, 014, 016
      name: 'Gulberg · 10 Marla',
      status: 'DRAFT',
      client: { name: 'Naveed Akhtar', phone: '+923007654321' },
      startDate: '2026-11-01',
      endDate: '2027-08-31',
      team: { pm: { id: users.bilal.id }, munshis: [{ id: users.rafaqatMalik.id }] },
      contract: { retentionPercent: 5, defectPeriodMonths: 6, contractValuePaisa: null },
      plot: { marlaStandard: 225 },
      wizardCompletedSteps: [1],
    });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'project.create', entityId: p.id } })).toBe(1);

    const second = await api().post('/api/v1/projects').set(await owner()).send(basic({ newClient: undefined, clientId: p.client.id }));
    expect(second.body.data.code).toBe('MSB-2026-018');
  });

  it('a PM creator is assigned automatically and sees the project; financial fields are omitted for them', async () => {
    const auth = await pm();
    const res = await api().post('/api/v1/projects').set(auth).send(basic());
    expect(res.status).toBe(201);
    expect(res.body.data.team.pm.name).toBe('Bilal Ahmed');
    expect(res.body.data.contract).not.toHaveProperty('contractValuePaisa');
    expect(res.body.data.contract).not.toHaveProperty('ratePerSqftPaisa');

    const list = await api().get('/api/v1/projects?status=DRAFT').set(auth);
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(res.body.data.id);
    expect(list.body.data[0]).not.toHaveProperty('contractValuePaisa');
    const ownerList = await api().get('/api/v1/projects?status=DRAFT').set(await owner());
    expect(ownerList.body.data[0]).toHaveProperty('contractValuePaisa');
  });

  it('validates: client choice, dates, roles, code clash', async () => {
    const { users } = seeded();
    const auth = await owner();
    expect((await api().post('/api/v1/projects').set(auth).send(basic({ newClient: undefined }))).status).toBe(400);
    expect((await api().post('/api/v1/projects').set(auth).send(basic({ endDate: '2026-10-01' }))).status).toBe(400);
    const badPm = await api().post('/api/v1/projects').set(auth).send(basic({ pmId: users.rafaqatMalik.id }));
    expect(badPm.body.error.code).toBe('INVALID_PM');
    const badClient = await api().post('/api/v1/projects').set(auth).send(basic({ newClient: undefined, clientId: '0199a8c0-0000-7000-8000-000000000999' }));
    expect(badClient.body.error.code).toBe('INVALID_CLIENT');
    const dupPhone = await api().post('/api/v1/projects').set(auth).send(basic({ newClient: { name: 'Again', phone: '03331234567' } }));
    expect(dupPhone.body.error.code).toBe('CLIENT_PHONE_TAKEN');

    expect((await api().post('/api/v1/projects').set(auth).send(basic({ code: 'msb-custom-1' }))).body.data.code).toBe('MSB-CUSTOM-1');
    const clash = await api().post('/api/v1/projects').set(auth).send(basic({ code: 'MSB-CUSTOM-1', newClient: { name: 'Other', phone: '03001231231' } }));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('PROJECT_CODE_TAKEN');
    expect((await api().post('/api/v1/projects').set(await munshi()).send(basic())).status).toBe(403);
  });
});

describe('GET /projects and /projects/:id — scoping', () => {
  it('THEKEDAR sees all, PM and MUNSHI only assigned; outside access → 404', async () => {
    const { projects } = seeded();
    const unassigned = await api().post('/api/v1/projects').set(await owner()).send(basic());
    const all = await api().get('/api/v1/projects').set(await owner());
    const pmList = await api().get('/api/v1/projects').set(await pm());
    const munshiList = await api().get('/api/v1/projects').set(await munshi());
    expect(all.body.meta.total).toBeGreaterThan(pmList.body.meta.total);
    expect(pmList.body.data.map((p: { id: string }) => p.id)).not.toContain(unassigned.body.data.id);
    expect(munshiList.body.data.map((p: { id: string }) => p.id)).toEqual([projects.dha.id]);

    expect((await api().get(`/api/v1/projects/${unassigned.body.data.id}`).set(await pm())).status).toBe(404);
    expect((await api().get(`/api/v1/projects/${unassigned.body.data.id}`).set(await munshi())).status).toBe(404);
    expect((await api().get(`/api/v1/projects/${projects.dha.id}`).set(await ahmedOwner())).status).toBe(404);
  });

  it('MUNSHI gets basic fields only', async () => {
    const res = await api().get(`/api/v1/projects/${seeded().projects.dha.id}`).set(await munshi());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['city', 'client', 'code', 'endDate', 'id', 'name', 'siteAddress', 'startDate', 'status', 'team'].sort());
  });

  it('search, status and pmId filters', async () => {
    const auth = await owner();
    const made = await api().post('/api/v1/projects').set(auth).send(basic({ name: 'Askari 11 · Villa' }));
    expect((await api().get('/api/v1/projects?search=askari').set(auth)).body.data.map((p: { id: string }) => p.id)).toEqual([made.body.data.id]);
    expect((await api().get('/api/v1/projects?search=naveed').set(auth)).body.data).toHaveLength(1);
    expect((await api().get(`/api/v1/projects?search=${made.body.data.code}`).set(auth)).body.data).toHaveLength(1);
    const byPm = await api().get(`/api/v1/projects?pmId=${seeded().users.bilal.id}`).set(auth);
    expect(byPm.body.data.every((p: { pm: { name: string } | null }) => p.pm?.name === 'Bilal Ahmed')).toBe(true);
  });
});

describe('DELETE /projects/:id', () => {
  it('only DRAFT projects, THEKEDAR only', async () => {
    const auth = await owner();
    const draft = await api().post('/api/v1/projects').set(auth).send(basic());
    expect((await api().delete(`/api/v1/projects/${draft.body.data.id}`).set(await pm())).status).toBe(403);
    const active = await api().delete(`/api/v1/projects/${seeded().projects.dha.id}`).set(auth);
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe('PROJECT_NOT_DRAFT');
    expect((await api().delete(`/api/v1/projects/${draft.body.data.id}`).set(auth)).status).toBe(200);
    expect(await prismaAdmin.project.count({ where: { id: draft.body.data.id } })).toBe(0);
  });

  it('DRAFT projects do not count against the plan', async () => {
    const auth = await owner();
    const before = (await api().get('/api/v1/subscription').set(auth)).body.data.usage.activeProjects.used;
    await api().post('/api/v1/projects').set(auth).send(basic());
    expect((await api().get('/api/v1/subscription').set(auth)).body.data.usage.activeProjects.used).toBe(before);
  });
});
