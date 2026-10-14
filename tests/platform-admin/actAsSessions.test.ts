/**
 * Platform super admin: direct, full access to any company (owner decision). No support session,
 * no reason, no read-only mode, no expiry, no notification or email to the company — only a
 * silent audit trail (admin id + name on every change).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { clearSystemUserCache } from '../../src/modules/auth/actAs.js';
import { lastMailTo } from '../../src/modules/auth/mail.provider.js';
import { api, bearer, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
beforeEach(() => clearSystemUserCache());

async function admin() {
  return bearer((await loginAdmin()).accessToken);
}

const errorCode = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;

describe('direct access: X-Act-As-Tenant alone is enough', () => {
  it('reads and writes (POST / PATCH / PUT / DELETE) work without any session', async () => {
    const s = seeded();
    const h = { ...(await admin()), 'X-Act-As-Tenant': s.malik.id };
    expect((await api().get('/api/v1/suppliers').set(h)).status).toBe(200);

    const created = await api().post('/api/v1/suppliers').set(h).send({ name: 'Support Fixed Traders', category: 'Cement' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const renamed = await api().patch(`/api/v1/suppliers/${created.body.data.id}`).set(h).send({ city: 'Lahore' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const company = await api().patch('/api/v1/company').set(h).send({ name: 'Malik & Sons (fixed by support)' });
    expect(company.status, JSON.stringify(company.body)).toBe(200);
    expect((await prismaAdmin.tenant.findUniqueOrThrow({ where: { id: s.malik.id } })).name).toBe('Malik & Sons (fixed by support)');
  });

  it('a legacy X-Act-As-Session header (even garbage) is accepted and ignored', async () => {
    const s = seeded();
    const auth = await admin();
    for (const legacy of ['not-a-uuid', '0199a8c0-0000-7000-8000-0000000000f0']) {
      const res = await api().post('/api/v1/suppliers').set({ ...auth, 'X-Act-As-Tenant': s.malik.id, 'X-Act-As-Session': legacy }).send({ name: `Legacy ${legacy.slice(0, 4)} Traders`, category: 'Cement' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
  });

  it('nobody in the company is told: no notification, no email', async () => {
    const s = seeded();
    const before = await prismaAdmin.notification.count({ where: { tenantId: s.malik.id } });
    const mailBefore = lastMailTo(SEED.malik.owner.email);
    const h = { ...(await admin()), 'X-Act-As-Tenant': s.malik.id };
    await api().get('/api/v1/projects').set(h);
    await api().post('/api/v1/suppliers').set(h).send({ name: 'Quiet Traders', category: 'Cement' });
    expect(await prismaAdmin.notification.count({ where: { tenantId: s.malik.id } })).toBe(before);
    expect(await prismaAdmin.notification.count({ where: { type: 'PLATFORM_SUPPORT_ACCESS' } })).toBe(0);
    expect(lastMailTo(SEED.malik.owner.email)).toBe(mailBefore);
    expect(await prismaAdmin.actAsSession.count()).toBe(0);
  });

  it('the support-session endpoints are gone', async () => {
    const s = seeded();
    const auth = await admin();
    const start = await api().post('/api/v1/admin/act-as-sessions').set(auth).send({ tenantId: s.malik.id, reason: 'Owner asked for help' });
    expect(start.status).toBe(404);
    expect((await api().get('/api/v1/admin/act-as-sessions').set(auth)).status).toBe(404);
  });
});

describe('direct access: silent audit trail', () => {
  it('every change is audited with the admin id and name (no reason, no session)', async () => {
    const s = seeded();
    const h = { ...(await admin()), 'X-Act-As-Tenant': s.malik.id };
    const created = await api().post('/api/v1/suppliers').set(h).send({ name: 'Audited Traders', category: 'Cement' });
    expect(created.status).toBe(201);
    const adminRow = await prismaAdmin.platformAdmin.findUniqueOrThrow({ where: { email: SEED.admin.email } });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: s.malik.id, entityId: created.body.data.id } });
    expect(audit).toMatchObject({ actorType: 'PLATFORM_ADMIN', actorId: adminRow.id });
    expect(audit.details).toMatchObject({ actingAsCompany: true, adminName: SEED.admin.name });
    expect(audit.details).not.toHaveProperty('actAsReason');
    expect(audit.details).not.toHaveProperty('actAsSessionId');
  });

  it('the company audit log shows "Platform support · <admin>" (owner only)', async () => {
    const s = seeded();
    const h = { ...(await admin()), 'X-Act-As-Tenant': s.malik.id };
    await api().post('/api/v1/suppliers').set(h).send({ name: 'Support Fixed Traders', category: 'Cement' });

    const owner = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
    const log = await api().get('/api/v1/company/audit-logs?actorType=PLATFORM_ADMIN').set(owner);
    expect(log.status).toBe(200);
    const rows = log.body.data as Array<{ action: string; actor: { type: string; name: string; id: string | null }; platformSupport: { sessionId: string | null; adminName: string; reason: string | null } }>;
    expect(rows.map((r) => r.action)).toEqual(['supplier.create']);
    expect(rows[0]!.actor).toEqual({ type: 'PLATFORM_ADMIN', id: null, name: `Platform support · ${SEED.admin.name}` });
    expect(rows[0]!.platformSupport).toEqual({ sessionId: null, adminName: SEED.admin.name, reason: null });

    // Owner's own actions show their name; other companies' rows never show up.
    const all = await api().get('/api/v1/company/audit-logs?limit=100').set(owner);
    expect((all.body.data as Array<{ actor: { type: string; name: string } }>).some((r) => r.actor.type === 'USER' && r.actor.name === 'Khalid Malik')).toBe(true);
    expect(all.body.meta.total).toBe(await prismaAdmin.auditLog.count({ where: { tenantId: s.malik.id } }));

    // Not for the PM (owner-only permission).
    const pm = bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
    const denied = await api().get('/api/v1/company/audit-logs').set(pm);
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe('PERMISSION_DENIED');
  });
});
