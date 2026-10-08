import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const admin = async () => bearer((await loginAdmin()).accessToken);
const get = async (path: string, auth?: Record<string, string>) => api().get(`/api/v1/admin/tenants/${path}`).set(auth ?? (await admin()));
const views = (tenantId: string) => prismaAdmin.auditLog.findMany({ where: { tenantId, action: 'admin.company_data_viewed' }, orderBy: { createdAt: 'asc' } });

describe("super admin: a company's data (read-only)", () => {
  it('projects: every project of that company only, with client, team and money', async () => {
    const s = seeded();
    const res = await get(`${s.malik.id}/projects`);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ id: string; name: string; client: { name: string } | null; billedPaisa: string; receivedPaisa: string; outstandingPaisa: string; teamMembers: number }>;
    expect(rows.map((r) => r.id).sort()).toEqual((await prismaAdmin.project.findMany({ where: { tenantId: s.malik.id }, select: { id: true } })).map((p) => p.id).sort());
    // Nothing from the other company.
    expect(rows.some((r) => r.id === s.projects.ahmedProject.id)).toBe(false);
    const dha = rows.find((r) => r.id === s.projects.dha.id)!;
    expect(dha.client?.name).toBeTruthy();
    expect(dha.teamMembers).toBeGreaterThan(0);
    for (const k of ['billedPaisa', 'receivedPaisa', 'outstandingPaisa'] as const) expect(dha[k]).toMatch(/^\d+$/);
  });

  it('team: users with role and last login, phones and pending invitations', async () => {
    const s = seeded();
    await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password); // registers a phone
    const res = await get(`${s.malik.id}/team`);
    expect(res.status).toBe(200);
    const { users, devices, pendingInvites } = res.body.data as { users: Array<{ name: string; role: string; projects: number | null; lastLoginAt: string | null }>; devices: Array<{ user: { name: string }; platform: string }>; pendingInvites: number };
    expect(users.find((u) => u.role === 'THEKEDAR')).toMatchObject({ name: 'Khalid Malik', projects: null });
    expect(users.find((u) => u.name === 'Khalid Malik')!.lastLoginAt).not.toBeNull();
    expect(users.find((u) => u.role === 'MUNSHI')!.projects).toBeGreaterThan(0);
    expect(devices.some((d) => d.user.name === 'Khalid Malik' && d.platform === 'ANDROID')).toBe(true);
    expect(pendingInvites).toBeGreaterThanOrEqual(0);
    // No password hashes or tokens ever leave.
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash|\$2[aby]\$/);
  });

  it('activity: projects by status, last 30 days and money now', async () => {
    const s = seeded();
    const res = await get(`${s.malik.id}/activity`);
    expect(res.status).toBe(200);
    const a = res.body.data;
    const active = await prismaAdmin.project.count({ where: { tenantId: s.malik.id, status: 'ACTIVE' } });
    expect(a.projectsByStatus.ACTIVE).toBe(active);
    expect(a.last30Days).toMatchObject({ hazriMarks: expect.any(Number), dispatches: expect.any(Number), dailyLogs: expect.any(Number) });
    for (const k of ['billedPaisa', 'receivedPaisa', 'receivablesPaisa', 'supplierUdhaarPaisa', 'cashWithSiteStaffPaisa']) expect(a.money[k]).toMatch(/^-?\d+$/);
    const billed = await prismaAdmin.invoice.aggregate({ where: { tenantId: s.malik.id, status: { in: ['ISSUED', 'PARTLY_PAID', 'PAID'] } }, _sum: { totalPaisa: true } });
    expect(a.money.billedPaisa).toBe((billed._sum.totalPaisa ?? 0n).toString());
  });

  it('every look is audited — once per section every 10 minutes', async () => {
    const s = seeded();
    await get(`${s.malik.id}/projects`);
    await get(`${s.malik.id}/projects`);
    await get(`${s.malik.id}/team`);
    const rows = await views(s.malik.id);
    expect(rows.map((r) => (r.details as { section: string }).section)).toEqual(['projects', 'team']);
    expect(rows.every((r) => r.actorType === 'PLATFORM_ADMIN')).toBe(true);
    // The look shows up in the company's timeline on the admin detail page.
    const detail = await get(s.malik.id);
    expect(JSON.stringify(detail.body.data)).toContain('admin.company_data_viewed');
  });

  it('only the platform admin: a company login gets 401; unknown company 404', async () => {
    const s = seeded();
    const owner = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
    expect((await get(`${s.malik.id}/projects`, owner)).status).toBe(401);
    const missing = await get('01a10000-0000-7000-8000-000000000000/activity');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('TENANT_NOT_FOUND');
  });
});

describe('project order', () => {
  it('running projects come first, finished ones last', async () => {
    const s = seeded();
    await prismaAdmin.project.update({ where: { id: s.projects.dha.id }, data: { createdAt: new Date('2020-01-01') } });
    const rows = (await get(`${s.malik.id}/projects`)).body.data as Array<{ status: string }>;
    const rank = (st: string) => ['ACTIVE', 'CLOSEOUT', 'READ_ONLY', 'DRAFT', 'HANDED_OVER', 'CLOSED'].indexOf(st);
    expect(rows.map((r) => rank(r.status))).toEqual([...rows.map((r) => rank(r.status))].sort((a, b) => a - b));
  });
});
