import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { clearSystemUserCache } from '../../src/modules/auth/actAs.js';
import { lastMailTo } from '../../src/modules/auth/mail.provider.js';
import { api, bearer, loginAdmin, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
beforeEach(() => clearSystemUserCache());

const REASON = 'Owner asked us to check a wrong supplier balance';
const WRITE_REASON = 'Correct the duplicated supplier the owner reported';
const SESSIONS = '/api/v1/admin/act-as-sessions';

async function admin() {
  return bearer((await loginAdmin()).accessToken);
}

async function start(auth: Record<string, string>, tenantId: string, reason = REASON) {
  const res = await api().post(SESSIONS).set(auth).send({ tenantId, reason });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; mode: string; status: string; expiresAt: string; startedAt: string; secondsLeft: number };
}

const headers = (auth: Record<string, string>, tenantId: string, sessionId?: string) => ({
  ...auth,
  'X-Act-As-Tenant': tenantId,
  ...(sessionId ? { 'X-Act-As-Session': sessionId } : {}),
});

const errorCode = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;

describe('act-as sessions: start', () => {
  it('needs a 5–300 character reason and a real company', async () => {
    const s = seeded();
    const auth = await admin();
    expect((await api().post(SESSIONS).set(auth).send({ tenantId: s.malik.id })).status).toBe(400);
    expect((await api().post(SESSIONS).set(auth).send({ tenantId: s.malik.id, reason: 'fix' })).status).toBe(400);
    expect((await api().post(SESSIONS).set(auth).send({ tenantId: s.malik.id, reason: 'x'.repeat(301) })).status).toBe(400);
    const unknown = await api().post(SESSIONS).set(auth).send({ tenantId: '01a10000-0000-7000-8000-000000000000', reason: REASON });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe('TENANT_NOT_FOUND');
    // Company tokens can't start one.
    const owner = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
    expect((await api().post(SESSIONS).set(owner).send({ tenantId: s.malik.id, reason: REASON })).status).toBe(401);
  });

  it('creates a READ_ONLY session for 60 minutes and audits it with the admin and the reason', async () => {
    const s = seeded();
    const session = await start(await admin(), s.malik.id);
    expect(session).toMatchObject({ mode: 'READ_ONLY', status: 'ACTIVE' });
    const minutes = (Date.parse(session.expiresAt) - Date.parse(session.startedAt)) / 60_000;
    expect(minutes).toBe(60);
    expect(session.secondsLeft).toBeGreaterThan(59 * 60);

    const row = await prismaAdmin.actAsSession.findUniqueOrThrow({ where: { id: session.id }, include: { admin: true } });
    expect(row).toMatchObject({ tenantId: s.malik.id, reason: REASON, mode: 'READ_ONLY', endedAt: null, writeReason: null });
    expect(row.admin.email).toBe(SEED.admin.email);

    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: s.malik.id, action: 'admin.act_as_started' } });
    expect(audit).toMatchObject({ actorType: 'PLATFORM_ADMIN', actorId: row.adminId, entityType: 'ActAsSession', entityId: session.id });
    expect(audit.details).toMatchObject({ adminName: SEED.admin.name, reason: REASON, mode: 'READ_ONLY' });
  });

  it('tells every owner: in-app notification + email "Platform support accessed your account: <reason>"', async () => {
    const s = seeded();
    const session = await start(await admin(), s.malik.id);

    const owner = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
    const inbox = await api().get('/api/v1/notifications?type=PLATFORM_SUPPORT_ACCESS').set(owner);
    expect(inbox.status).toBe(200);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({
      type: 'PLATFORM_SUPPORT_ACCESS',
      severity: 'WARNING',
      title: 'Platform support ne aap ka account khola', // the owner's language (Roman Urdu by default)
      refId: session.id,
      actionUrl: '/settings/audit-log',
    });
    expect(inbox.body.data[0].body).toContain(`Platform support ne aap ka account khola: ${REASON}`);

    const mail = lastMailTo(SEED.malik.owner.email);
    expect(mail?.subject).toContain('Platform support ne');
    expect(mail?.text).toContain(`Platform support ne aap ka account khola: ${REASON}`);
    expect(mail?.text).toContain(SEED.admin.name);

    // Nobody else in the company is told (PM / munshi), and the other company hears nothing.
    const notified = await prismaAdmin.notification.findMany({ where: { type: 'PLATFORM_SUPPORT_ACCESS' }, include: { user: true } });
    expect(notified.map((n) => n.user.role)).toEqual(['THEKEDAR']);
    expect(notified.every((n) => n.tenantId === s.malik.id)).toBe(true);
  });

  it("a new session ends the admin's previous one", async () => {
    const s = seeded();
    const auth = await admin();
    const first = await start(auth, s.malik.id);
    const second = await start(auth, s.ahmed.id);
    const old = await api().get(`${SESSIONS}/${first.id}`).set(auth);
    expect(old.body.data.status).toBe('ENDED');
    const res = await api().get('/api/v1/projects').set(headers(auth, s.malik.id, first.id));
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ACT_AS_SESSION_ENDED');
    expect((await api().get('/api/v1/projects').set(headers(auth, s.ahmed.id, second.id))).status).toBe(200);
  });
});

describe('act-as sessions: the company API needs a live session', () => {
  it('X-Act-As-Tenant alone is refused (403 ACT_AS_SESSION_REQUIRED)', async () => {
    const s = seeded();
    const res = await api().get('/api/v1/projects').set(headers(await admin(), s.malik.id));
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ACT_AS_SESSION_REQUIRED');
  });

  it('unknown, garbage or another company\'s session → 403 ACT_AS_SESSION_INVALID', async () => {
    const s = seeded();
    const auth = await admin();
    const session = await start(auth, s.malik.id);
    for (const [tenantId, sessionId] of [
      [s.malik.id, '01a10000-0000-7000-8000-000000000000'],
      [s.malik.id, 'not-a-session'],
      [s.ahmed.id, session.id],
    ] as const) {
      const res = await api().get('/api/v1/projects').set(headers(auth, tenantId, sessionId));
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe('ACT_AS_SESSION_INVALID');
    }
  });

  it("another admin can't use someone else's session", async () => {
    const s = seeded();
    const session = await start(await admin(), s.malik.id);
    const other = await prismaAdmin.platformAdmin.create({
      data: { email: 'second@platform.local', name: 'Second Admin', passwordHash: (await prismaAdmin.platformAdmin.findUniqueOrThrow({ where: { email: SEED.admin.email } })).passwordHash },
    });
    const login = await api().post('/api/v1/admin/auth/login').send({ email: other.email, password: SEED.admin.password, client: 'mobile' });
    expect(login.status).toBe(200);
    const res = await api().get('/api/v1/projects').set(headers(bearer(login.body.data.accessToken), s.malik.id, session.id));
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ACT_AS_SESSION_INVALID');
  });

  it('an expired session → 403 ACT_AS_SESSION_EXPIRED (auto-expiry), and shows as EXPIRED', async () => {
    const s = seeded();
    const auth = await admin();
    const session = await start(auth, s.malik.id);
    expect((await api().get('/api/v1/projects').set(headers(auth, s.malik.id, session.id))).status).toBe(200);
    await prismaAdmin.actAsSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await api().get('/api/v1/projects').set(headers(auth, s.malik.id, session.id));
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ACT_AS_SESSION_EXPIRED');
    expect((await api().get(`${SESSIONS}/${session.id}`).set(auth)).body.data).toMatchObject({ status: 'EXPIRED', secondsLeft: 0 });
    // Write mode can't be switched on any more.
    const write = await api().post(`${SESSIONS}/${session.id}/mode`).set(auth).send({ mode: 'WRITE', reason: WRITE_REASON });
    expect(write.status).toBe(409);
    expect(errorCode(write)).toBe('ACT_AS_SESSION_NOT_ACTIVE');
  });

  it('an ended session → 403 ACT_AS_SESSION_ENDED; ending is audited and idempotent', async () => {
    const s = seeded();
    const auth = await admin();
    const session = await start(auth, s.malik.id);
    const end = await api().post(`${SESSIONS}/${session.id}/end`).set(auth);
    expect(end.status).toBe(200);
    expect(end.body.data).toMatchObject({ status: 'ENDED', secondsLeft: 0 });
    expect((await api().post(`${SESSIONS}/${session.id}/end`).set(auth)).status).toBe(200);
    const res = await api().get('/api/v1/projects').set(headers(auth, s.malik.id, session.id));
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ACT_AS_SESSION_ENDED');
    expect(await prismaAdmin.auditLog.count({ where: { tenantId: s.malik.id, action: 'admin.act_as_ended', entityId: session.id } })).toBe(1);
  });
});

describe('act-as sessions: read-only by default, write with a second reason', () => {
  it('READ_ONLY: reads work, every write is 403 ACT_AS_READ_ONLY', async () => {
    const s = seeded();
    const auth = await admin();
    const session = await start(auth, s.malik.id);
    const h = headers(auth, s.malik.id, session.id);
    expect((await api().get('/api/v1/suppliers').set(h)).status).toBe(200);
    for (const req of [
      api().post('/api/v1/suppliers').set(h).send({ name: 'Should Not Exist', category: 'Cement' }),
      api().patch('/api/v1/company').set(h).send({ name: 'Renamed By Support' }),
      api().delete(`/api/v1/company/holidays/${session.id}`).set(h),
      api().put(`/api/v1/users/${session.id}/projects`).set(h).send({ projectIds: [] }),
    ]) {
      const res = await req;
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe('ACT_AS_READ_ONLY');
    }
    expect(await prismaAdmin.supplier.count({ where: { tenantId: s.malik.id, name: 'Should Not Exist' } })).toBe(0);
  });

  it('WRITE needs a reason; then writes work and are audited with the admin and the write reason', async () => {
    const s = seeded();
    const auth = await admin();
    const session = await start(auth, s.malik.id);
    const noReason = await api().post(`${SESSIONS}/${session.id}/mode`).set(auth).send({ mode: 'WRITE' });
    expect(noReason.status).toBe(400);
    const short = await api().post(`${SESSIONS}/${session.id}/mode`).set(auth).send({ mode: 'WRITE', reason: 'fix' });
    expect(short.status).toBe(400);

    const write = await api().post(`${SESSIONS}/${session.id}/mode`).set(auth).send({ mode: 'WRITE', reason: WRITE_REASON });
    expect(write.status).toBe(200);
    expect(write.body.data).toMatchObject({ mode: 'WRITE', writeReason: WRITE_REASON });
    const switched = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: s.malik.id, action: 'admin.act_as_mode_changed' } });
    expect(switched.details).toMatchObject({ adminName: SEED.admin.name, from: 'READ_ONLY', to: 'WRITE', reason: WRITE_REASON });

    const created = await api().post('/api/v1/suppliers').set(headers(auth, s.malik.id, session.id)).send({ name: 'Support Fixed Traders', category: 'Cement' });
    expect(created.status).toBe(201);
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: s.malik.id, entityId: created.body.data.id } });
    expect(audit.actorType).toBe('PLATFORM_ADMIN');
    expect(audit.details).toMatchObject({ actingAsCompany: true, actAsSessionId: session.id, adminName: SEED.admin.name, actAsReason: WRITE_REASON });

    // Back to read-only: writes stop again.
    const back = await api().post(`${SESSIONS}/${session.id}/mode`).set(auth).send({ mode: 'READ_ONLY' });
    expect(back.body.data.mode).toBe('READ_ONLY');
    const blocked = await api().post('/api/v1/suppliers').set(headers(auth, s.malik.id, session.id)).send({ name: 'Another One', category: 'Cement' });
    expect(errorCode(blocked)).toBe('ACT_AS_READ_ONLY');
  });

  it("only the session's own admin can switch its mode", async () => {
    const s = seeded();
    const session = await start(await admin(), s.malik.id);
    const other = await prismaAdmin.platformAdmin.create({
      data: { email: 'third@platform.local', name: 'Third Admin', passwordHash: (await prismaAdmin.platformAdmin.findUniqueOrThrow({ where: { email: SEED.admin.email } })).passwordHash },
    });
    const login = await api().post('/api/v1/admin/auth/login').send({ email: other.email, password: SEED.admin.password, client: 'mobile' });
    const res = await api().post(`${SESSIONS}/${session.id}/mode`).set(bearer(login.body.data.accessToken)).send({ mode: 'WRITE', reason: WRITE_REASON });
    expect(res.status).toBe(404);
  });
});

describe('act-as sessions: lists', () => {
  it('admin console lists sessions, filtered by company and active', async () => {
    const s = seeded();
    const auth = await admin();
    const ended = await start(auth, s.ahmed.id);
    const live = await start(auth, s.malik.id); // ends the Ahmed one
    const all = await api().get(SESSIONS).set(auth);
    expect(all.status).toBe(200);
    expect(all.body.data.map((r: { id: string }) => r.id)).toEqual([live.id, ended.id]);
    expect(all.body.meta.total).toBe(2);
    expect(all.body.data[0]).toMatchObject({ tenant: { id: s.malik.id }, admin: { name: SEED.admin.name }, reason: REASON, status: 'ACTIVE' });

    const malik = await api().get(`${SESSIONS}?tenantId=${s.malik.id}`).set(auth);
    expect(malik.body.data.map((r: { id: string }) => r.id)).toEqual([live.id]);
    const active = await api().get(`${SESSIONS}?active=true`).set(auth);
    expect(active.body.data.map((r: { id: string }) => r.id)).toEqual([live.id]);
    const finished = await api().get(`${SESSIONS}?active=false`).set(auth);
    expect(finished.body.data.map((r: { id: string }) => r.id)).toEqual([ended.id]);
  });

  it("the company's audit log shows support sessions with the admin's name and reason (owner only)", async () => {
    const s = seeded();
    const auth = await admin();
    const session = await start(auth, s.malik.id);
    await api().post(`${SESSIONS}/${session.id}/mode`).set(auth).send({ mode: 'WRITE', reason: WRITE_REASON });
    await api().post('/api/v1/suppliers').set(headers(auth, s.malik.id, session.id)).send({ name: 'Support Fixed Traders', category: 'Cement' });
    await api().post(`${SESSIONS}/${session.id}/end`).set(auth);

    const owner = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
    const log = await api().get('/api/v1/company/audit-logs?actorType=PLATFORM_ADMIN').set(owner);
    expect(log.status).toBe(200);
    const rows = log.body.data as Array<{ action: string; actor: { name: string; id: string | null }; platformSupport: { sessionId: string; adminName: string; reason: string } }>;
    expect(rows.map((r) => r.action)).toEqual(['admin.act_as_ended', 'supplier.create', 'admin.act_as_mode_changed', 'admin.act_as_started']);
    for (const r of rows) {
      expect(r.actor).toEqual({ type: 'PLATFORM_ADMIN', id: null, name: `Platform support · ${SEED.admin.name}` });
      expect(r.platformSupport.sessionId).toBe(session.id);
      expect(r.platformSupport.adminName).toBe(SEED.admin.name);
    }
    expect(rows.find((r) => r.action === 'admin.act_as_started')?.platformSupport.reason).toBe(REASON);
    expect(rows.find((r) => r.action === 'supplier.create')?.platformSupport.reason).toBe(WRITE_REASON);

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
