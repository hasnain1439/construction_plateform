import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { todayIn } from '../../src/core/utils/dates.js';
import { runSubscriptionLifecycle } from '../../src/jobs/subscriptionLifecycle.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { api, bearer, device, expectedReceipt, loginAdmin, loginMobile, SEED, useFreshDatabase, projectRow } from '../helpers.js';

const seeded = useFreshDatabase();
const DAY = 86_400_000;
const today = todayIn('Asia/Karachi');

const admin = async () => bearer((await loginAdmin()).accessToken);
const list = async (qs: string) => (await api().get(`/api/v1/admin/tenants?${qs}`).set(await admin())).body;

function companyBody(overrides: { mode: 'TRIAL' | 'PAID'; planCode: string; ownerPhone: string; payment?: unknown; slug?: string; trialDays?: number }) {
  return {
    company: { name: 'Lahore Grand Builders', ...(overrides.slug ? { slug: overrides.slug } : {}), phone: '042-35000000', region: 'PUNJAB_KP', ntn: '7654321-0' },
    owner: { name: 'Imran Qureshi', phone: overrides.ownerPhone },
    subscription: {
      mode: overrides.mode,
      planCode: overrides.planCode,
      ...(overrides.trialDays ? { trialDays: overrides.trialDays } : {}),
      ...(overrides.payment ? { payment: overrides.payment } : {}),
    },
    note: 'Signed up at the Expo Centre',
  };
}

describe('GET /admin/tenants', () => {
  it('lists every company with owner, plan, status and usage', async () => {
    const body = await list('limit=10');
    expect(body.meta.total).toBe(4);
    const malik = body.data.find((t: { slug: string }) => t.slug === SEED.malik.slug);
    expect(malik).toMatchObject({
      name: SEED.malik.name,
      owner: { name: 'Khalid Malik', phone: SEED.malik.owner.phone },
      plan: { code: 'PROFESSIONAL' },
      subscriptionStatus: 'ACTIVE',
      tenantStatus: 'ACTIVE',
      usage: { activeProjects: { used: 3, limit: 5 }, officeUsers: { used: 3, limit: 10 } },
    });
  });

  it('filters by search (name / slug / owner phone), statuses, plan and renewal date', async () => {
    const names = (b: { data: Array<{ name: string }> }) => b.data.map((t) => t.name).sort();
    expect(names(await list('search=malik'))).toEqual([SEED.malik.name]);
    expect(names(await list('search=0333-1234567'))).toEqual([SEED.ahmed.name]);
    expect(names(await list('subscriptionStatus=GRACE'))).toEqual([SEED.valley.name]);
    expect(names(await list('tenantStatus=READ_ONLY'))).toEqual([SEED.oldTown.name]);
    expect(names(await list('plan=professional'))).toEqual([SEED.malik.name]);
    const in15 = new Date(Date.now() + 15 * DAY).toISOString().slice(0, 10);
    expect(names(await list(`renewsBefore=${in15}&subscriptionStatus=ACTIVE`))).toEqual([SEED.malik.name]);
  });

  it('detail: profile, owner, subscription, usage, payments and audit events; unknown id → 404', async () => {
    await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password); // creates an auth.login audit event
    const res = await api().get(`/api/v1/admin/tenants/${seeded().malik.id}`).set(await admin());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: SEED.malik.name,
      ntn: '1234567-8',
      owner: { name: 'Khalid Malik' },
      subscription: { status: 'ACTIVE', plan: { code: 'PROFESSIONAL' } },
      usage: { officeUsers: { used: 3, limit: 10 } },
    });
    expect(res.body.data.payments.map((p: { receiptNo: string }) => p.receiptNo)).toEqual(['RCPT-2026-0381', 'RCPT-2026-0372', 'RCPT-2026-0371']);
    expect(res.body.data.auditEvents.map((e: { action: string }) => e.action)).toContain('auth.login');

    const missing = await api().get('/api/v1/admin/tenants/0199a8c0-0000-7000-8000-000000000999').set(await admin());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('TENANT_NOT_FOUND');
  });
});

describe('POST /admin/tenants', () => {
  it('TRIAL: creates the company and a THEKEDAR invite; the owner accepts and can log in', async () => {
    const res = await api()
      .post('/api/v1/admin/tenants')
      .set(await admin())
      .send(companyBody({ mode: 'TRIAL', planCode: 'PROFESSIONAL', ownerPhone: '0345-2223334', trialDays: 10 }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      tenant: { name: 'Lahore Grand Builders', slug: 'lahore-grand-builders', status: 'ACTIVE' },
      subscription: { status: 'TRIAL', plan: { code: 'PROFESSIONAL' }, receiptNo: null },
      owner: { phone: '+923452223334', invitation: { status: 'PENDING' } },
    });
    const trialDays = (Date.parse(res.body.data.subscription.trialEndsAt) - Date.now()) / DAY;
    expect(trialDays).toBeGreaterThan(9.9);
    expect(trialDays).toBeLessThanOrEqual(10);

    const token = /\/invite\/([A-Za-z0-9_-]+)$/.exec(res.body.data.owner.invitation.devInviteUrl)![1]!;
    expect(lastSmsTo('+923452223334')!.body).toContain(token);

    const noPassword = await api().post(`/api/v1/invitations/${token}/accept`).send({ client: 'web' });
    expect(noPassword.status).toBe(400);
    const accepted = await api().post(`/api/v1/invitations/${token}/accept`).send({ password: 'Imran#2026', client: 'mobile', device: device() });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.user).toMatchObject({ role: 'THEKEDAR', phone: '+923452223334' });
    expect(accepted.body.data.permissions).toContain('users.manage');

    const login = await api().post('/api/v1/auth/login').send({ login: '03452223334', password: 'Imran#2026' });
    expect(login.status).toBe(200);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'admin.tenant_created', actorType: 'PLATFORM_ADMIN' } })).toBe(1);
  });

  it('PAID: ACTIVE subscription with an approved payment and the next receipt number', async () => {
    const res = await api()
      .post('/api/v1/admin/tenants')
      .set(await admin())
      .send(
        companyBody({
          mode: 'PAID',
          planCode: 'starter',
          ownerPhone: '03452223335',
          slug: 'lgb-lahore',
          payment: { method: 'IBFT', transactionId: 'ibft2610050001', amountPaisa: '400000', paidOn: today },
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.data.tenant.slug).toBe('lgb-lahore');
    expect(res.body.data.subscription).toMatchObject({ status: 'ACTIVE', plan: { code: 'STARTER' }, receiptNo: expectedReceipt(1) });
    const payment = await prismaAdmin.subscriptionPayment.findUniqueOrThrow({ where: { transactionId: 'IBFT2610050001' } });
    const adminRow = await prismaAdmin.platformAdmin.findUniqueOrThrow({ where: { email: SEED.admin.email } });
    expect(payment).toMatchObject({ status: 'APPROVED', receiptNo: expectedReceipt(1), reviewedById: adminRow.id });
    expect(payment.periodEnd!.getTime() - payment.periodStart!.getTime()).toBe(30 * DAY);
  });

  it('rejects a taken slug (409), wrong amount (400), used transaction id (409) and PAID without payment (400)', async () => {
    const h = await admin();
    const taken = await api().post('/api/v1/admin/tenants').set(h).send(companyBody({ mode: 'TRIAL', planCode: 'STARTER', ownerPhone: '03452223336', slug: SEED.malik.slug }));
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('SLUG_TAKEN');

    const pay = (payment: Record<string, unknown>) =>
      api().post('/api/v1/admin/tenants').set(h).send(companyBody({ mode: 'PAID', planCode: 'STARTER', ownerPhone: '03452223337', payment }));
    const wrong = await pay({ method: 'IBFT', transactionId: 'IBFT9990001', amountPaisa: '100', paidOn: today });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: 'AMOUNT_MISMATCH', details: { expectedPaisa: '400000' } });
    const dup = await pay({ method: 'EASYPAISA', transactionId: 'ep2610010042', amountPaisa: '400000', paidOn: today });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_TRANSACTION');

    const noPayment = await api().post('/api/v1/admin/tenants').set(h).send(companyBody({ mode: 'PAID', planCode: 'STARTER', ownerPhone: '03452223338' }));
    expect(noPayment.status).toBe(400);
    const ownerTaken = await api().post('/api/v1/admin/tenants').set(h).send(companyBody({ mode: 'TRIAL', planCode: 'STARTER', ownerPhone: SEED.malik.owner.phone }));
    expect(ownerTaken.body.error.code).toBe('PHONE_TAKEN');
    expect(await prismaAdmin.tenant.count()).toBe(4); // nothing half-created
  });
});

describe('PATCH /admin/tenants/:id/status', () => {
  const status = async (id: string, body: Record<string, unknown>) => api().patch(`/api/v1/admin/tenants/${id}/status`).set(await admin()).send(body);

  it('EXTEND_TRIAL brings a lapsed trial back to TRIAL and the company to ACTIVE', async () => {
    const created = await api().post('/api/v1/admin/tenants').set(await admin()).send(companyBody({ mode: 'TRIAL', planCode: 'STARTER', ownerPhone: '03452223339', trialDays: 3 }));
    const tenantId = created.body.data.tenant.id as string;
    await runSubscriptionLifecycle(new Date(Date.now() + 4 * DAY));
    expect((await prismaAdmin.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe('READ_ONLY');

    const res = await status(tenantId, { action: 'EXTEND_TRIAL', days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tenantStatus: 'ACTIVE', subscriptionStatus: 'TRIAL' });
    expect(Date.parse(res.body.data.trialEndsAt)).toBeGreaterThan(Date.now() + 6.9 * DAY);

    const notTrial = await status(seeded().malik.id, { action: 'EXTEND_TRIAL', days: 7 });
    expect(notTrial.status).toBe(409);
    expect(notTrial.body.error.code).toBe('CANNOT_EXTEND_TRIAL');
    expect((await status(tenantId, { action: 'EXTEND_TRIAL' })).status).toBe(400); // days required
  });

  it('SUSPEND needs a note, signs everyone out and blocks login; REACTIVATE restores', async () => {
    const { malik } = seeded();
    const khalid = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);

    const noNote = await status(malik.id, { action: 'SUSPEND' });
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.details.fields[0].field).toBe('note');

    const suspended = await status(malik.id, { action: 'SUSPEND', note: 'Cheque bounced, owner asked to pause' });
    expect(suspended.body.data.tenantStatus).toBe('SUSPENDED');
    expect(await prismaAdmin.session.count({ where: { tenantId: malik.id, revokedAt: null } })).toBe(0);
    expect((await api().get('/api/v1/auth/me').set(bearer(khalid.accessToken))).status).toBe(401);
    const login = await api().post('/api/v1/auth/login').send({ login: SEED.malik.owner.phone, password: SEED.malik.owner.password });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('COMPANY_SUSPENDED');

    const back = await status(malik.id, { action: 'REACTIVATE' });
    expect(back.body.data.tenantStatus).toBe('ACTIVE');
    expect((await api().post('/api/v1/auth/login').send({ login: SEED.malik.owner.phone, password: SEED.malik.owner.password })).status).toBe(200);

    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: malik.id, action: 'admin.tenant_status' }, orderBy: { createdAt: 'asc' } });
    expect(audit.details).toMatchObject({ action: 'SUSPEND', note: 'Cheque bounced, owner asked to pause', to: { tenantStatus: 'SUSPENDED' } });
  });

  it('REACTIVATE on a lapsed subscription restores READ_ONLY (implied by the subscription); SET_READ_ONLY / CLOSE work', async () => {
    const { oldTown, ahmed } = seeded();
    await status(oldTown.id, { action: 'SUSPEND', note: 'Fraud check' });
    expect((await status(oldTown.id, { action: 'REACTIVATE' })).body.data.tenantStatus).toBe('READ_ONLY');
    expect((await status(ahmed.id, { action: 'SET_READ_ONLY' })).body.data.tenantStatus).toBe('READ_ONLY');
    expect((await status(ahmed.id, { action: 'CLOSE', note: 'Company wound up' })).body.data.tenantStatus).toBe('CLOSED');
  });
});

describe('PATCH /admin/tenants/:id/plan', () => {
  const plan = async (id: string, body: Record<string, unknown>) => api().patch(`/api/v1/admin/tenants/${id}/plan`).set(await admin()).send(body);

  it('IMMEDIATE switches now; NEXT_RENEWAL schedules for the period end', async () => {
    const { malik, plans, projects } = seeded();
    const later = await plan(malik.id, { planId: plans.ENTERPRISE.id, effective: 'NEXT_RENEWAL' });
    expect(later.status).toBe(200);
    const sub = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: malik.id } });
    expect(sub.pendingPlanId).toBe(plans.ENTERPRISE.id);
    expect(later.body.data.pendingPlan.effectiveOn).toBe(sub.currentPeriodEnd!.toISOString());

    const now = await plan(malik.id, {
      planId: plans.STARTER.id,
      effective: 'IMMEDIATE',
      note: 'Owner asked by phone',
      keepActiveProjectIds: [projects.dha.id, projects.johar.id],
    });
    expect(now.status).toBe(200);
    const after = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: malik.id }, include: { plan: true } });
    expect(after.plan.code).toBe('STARTER');
    expect(after.pendingPlanId).toBeNull();
    expect((await plan(malik.id, { planId: plans.STARTER.id, effective: 'IMMEDIATE' })).body.error.code).toBe('SAME_PLAN');
  });

  it('IMMEDIATE downgrade uses the same limit checks as the company side', async () => {
    const { malik, plans, projects } = seeded();
    await prismaAdmin.user.create({ data: { tenantId: malik.id, name: 'Extra PM', phone: '+923450000701', role: 'PM' } });
    const users = await plan(malik.id, { planId: plans.STARTER.id, effective: 'IMMEDIATE' });
    expect(users.body.error).toMatchObject({ code: 'DOWNGRADE_USERS_OVER_LIMIT', details: { officeUsers: 4, limit: 3 } });

    await prismaAdmin.user.deleteMany({ where: { phone: '+923450000701' } });
    const third = await projectRow(malik.id, 'Third site');
    expect((await plan(malik.id, { planId: plans.STARTER.id, effective: 'IMMEDIATE' })).body.error.code).toBe('KEEP_PROJECTS_REQUIRED');
    const ok = await plan(malik.id, { planId: plans.STARTER.id, effective: 'IMMEDIATE', keepActiveProjectIds: [projects.dha.id, third.id] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.projectsReadOnly.sort()).toEqual([projects.bahria.id, projects.johar.id].sort());
    expect((await prismaAdmin.project.findUniqueOrThrow({ where: { id: projects.bahria.id } })).status).toBe('READ_ONLY');
  });
});
