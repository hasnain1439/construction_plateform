import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { invalidateTenantStatus } from '../../src/core/middleware/tenantContext.js';
import { api, bearer, loginMobile, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const { owner } = SEED.malik;

async function setStatus(status: 'ACTIVE' | 'READ_ONLY' | 'SUSPENDED' | 'CLOSED') {
  await prismaAdmin.tenant.update({ where: { id: seeded().malik.id }, data: { status } });
  invalidateTenantStatus(seeded().malik.id);
}

describe('company status', () => {
  it('SUSPENDED: login → 403 COMPANY_SUSPENDED; existing tokens are blocked; refresh blocked', async () => {
    const session = await loginMobile(owner.phone, owner.password);
    await setStatus('SUSPENDED');

    const login = await api().post('/api/v1/auth/login').send({ login: owner.phone, password: owner.password });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('COMPANY_SUSPENDED');

    const me = await api().get('/api/v1/auth/me').set(bearer(session.accessToken));
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('COMPANY_SUSPENDED');

    const refresh = await refreshMobile(session.refreshToken);
    expect(refresh.status).toBe(403);

    // Signing out still works
    expect((await api().post('/api/v1/auth/logout').set(bearer(session.accessToken))).status).toBe(200);
  });

  it('CLOSED behaves like SUSPENDED for login', async () => {
    await setStatus('CLOSED');
    const login = await api().post('/api/v1/auth/login').send({ login: owner.phone, password: owner.password });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('COMPANY_SUSPENDED');
  });

  it('READ_ONLY: login works with readOnly=true; writes → 403 ACCOUNT_READ_ONLY; reads and logout allowed', async () => {
    await setStatus('READ_ONLY');
    const session = await loginMobile(owner.phone, owner.password);
    expect(session.body.data.tenant.readOnly).toBe(true);
    expect(session.body.data.tenant.status).toBe('READ_ONLY');

    const write = await api().post('/api/v1/__test/write').set(bearer(session.accessToken)).send({});
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('ACCOUNT_READ_ONLY');

    expect((await api().get('/api/v1/auth/me').set(bearer(session.accessToken))).status).toBe(200);
    expect((await api().post('/api/v1/auth/logout').set(bearer(session.accessToken))).status).toBe(200);
  });

  it('ACTIVE: the same write route succeeds', async () => {
    const session = await loginMobile(owner.phone, owner.password);
    const write = await api().post('/api/v1/__test/write').set(bearer(session.accessToken)).send({});
    expect(write.status).toBe(201);
  });
});
