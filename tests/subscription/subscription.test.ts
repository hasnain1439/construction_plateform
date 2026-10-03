import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { todayIn } from '../../src/core/utils/dates.js';
import { api, bearer, loginMobile, loginMunshi, pngBytes, SEED, upload, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = () => loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
const today = todayIn('Asia/Karachi');
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function slip(token: string) {
  const res = await upload(token, 'PAYMENT_SLIP', pngBytes(), 'slip.png');
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

const pay = (token: string, body: Record<string, unknown>) => api().post('/api/v1/subscription/payments').set(bearer(token)).send(body);

describe('GET /subscription', () => {
  it('shows plan, status, days left, usage with limits', async () => {
    const s = await owner();
    const res = await api().get('/api/v1/subscription').set(bearer(s.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: { code: 'PROFESSIONAL', pricePaisa: '950000', maxActiveProjects: 5, maxOfficeUsers: 10 },
      status: 'ACTIVE',
      daysLeft: 12,
      graceEndsAt: null,
      pendingChange: null,
      readOnly: false,
      // Khalid + Bilal + Kamran's pending PM invite; Rafaqat (Munshi) not counted
      usage: { activeProjects: { used: 2, limit: 5 }, officeUsers: { used: 3, limit: 10 } },
    });
    expect(res.body.data.plan.features.length).toBeGreaterThan(0);
  });

  it('PM and MUNSHI get 403', async () => {
    const p = await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
    expect((await api().get('/api/v1/subscription').set(bearer(p.accessToken))).status).toBe(403);
    const m = await loginMunshi(seeded().malik.id);
    expect((await api().get('/api/v1/subscription').set(bearer(m.accessToken))).status).toBe(403);
    expect((await api().get('/api/v1/subscription/plans').set(bearer(m.accessToken))).status).toBe(403);
  });

  it('lists purchasable plans (no TRIAL) with the current one marked', async () => {
    const s = await owner();
    const res = await api().get('/api/v1/subscription/plans').set(bearer(s.accessToken));
    expect(res.body.data.map((p: { code: string }) => p.code)).toEqual(['STARTER', 'PROFESSIONAL', 'ENTERPRISE']);
    expect(res.body.data.filter((p: { current: boolean }) => p.current).map((p: { code: string }) => p.code)).toEqual(['PROFESSIONAL']);
    expect(res.body.data.find((p: { code: string }) => p.code === 'ENTERPRISE').maxActiveProjects).toBeNull();
  });

  it('a lapsed company sees readOnly with daysLeft 0; a grace one sees grace days', async () => {
    const lapsed = await loginMobile(SEED.oldTown.owner.phone, SEED.oldTown.owner.password);
    const l = await api().get('/api/v1/subscription').set(bearer(lapsed.accessToken));
    expect(l.body.data).toMatchObject({ status: 'LAPSED', readOnly: true, daysLeft: 0 });
    const grace = await loginMobile(SEED.valley.owner.phone, SEED.valley.owner.password);
    const g = await api().get('/api/v1/subscription').set(bearer(grace.accessToken));
    expect(g.body.data).toMatchObject({ status: 'GRACE', readOnly: false, daysLeft: 2 });
  });
});

describe('POST /subscription/payments', () => {
  it('submits a payment for review (transaction id upper-cased) and lists history', async () => {
    const s = await owner();
    const attachmentId = await slip(s.accessToken);
    const res = await pay(s.accessToken, { method: 'EASYPAISA', transactionId: '  ep2610039999 ', amountPaisa: '950000', paidOn: today, attachmentId });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'PENDING_REVIEW',
      transactionId: 'EP2610039999',
      amountPaisa: '950000',
      method: 'EASYPAISA',
      plan: { code: 'PROFESSIONAL' },
      receiptNo: null,
      periodStart: null,
    });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'subscription.payment_submitted' } })).toBe(1);

    const history = await api().get('/api/v1/subscription/payments?limit=2').set(bearer(s.accessToken));
    expect(history.body.meta).toMatchObject({ total: 4, limit: 2, totalPages: 2 });
    expect(history.body.data[0].transactionId).toBe('EP2610039999');
    const all = await api().get('/api/v1/subscription/payments').set(bearer(s.accessToken));
    expect(all.body.data.map((p: { receiptNo: string | null }) => p.receiptNo)).toEqual([null, 'RCPT-2026-0381', 'RCPT-2026-0372', 'RCPT-2026-0371']);
  });

  it('amount must equal the plan price → 400 AMOUNT_MISMATCH with the expected amount', async () => {
    const s = await owner();
    const res = await pay(s.accessToken, { method: 'JAZZCASH', transactionId: 'JC1', amountPaisa: '500000', paidOn: today, attachmentId: await slip(s.accessToken) });
    expect(res.status).toBe(400);
    // 'JC1' is too short: validation runs first
    const res2 = await pay(s.accessToken, { method: 'JAZZCASH', transactionId: 'JC12345', amountPaisa: '500000', paidOn: today, attachmentId: await slip(s.accessToken) });
    expect(res2.status).toBe(400);
    expect(res2.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(res2.body.error.details).toEqual({ expectedPaisa: '950000', plan: 'PROFESSIONAL' });
  });

  it('only one payment in review at a time → 409 PAYMENT_PENDING', async () => {
    const s = await owner();
    const body = { method: 'RAAST', amountPaisa: '950000', paidOn: today };
    expect((await pay(s.accessToken, { ...body, transactionId: 'RAAST0001', attachmentId: await slip(s.accessToken) })).status).toBe(201);
    const second = await pay(s.accessToken, { ...body, transactionId: 'RAAST0002', attachmentId: await slip(s.accessToken) });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PAYMENT_PENDING');
  });

  it('transaction ids are unique across ALL companies, without revealing the other company', async () => {
    const s = await owner();
    const body = { method: 'EASYPAISA', amountPaisa: '950000', paidOn: today };
    // Own company: an approved seed payment already used this id
    const own = await pay(s.accessToken, { ...body, transactionId: 'ibft2609160552', attachmentId: await slip(s.accessToken) });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('DUPLICATE_TRANSACTION');

    // Other company: Ahmed's pending Easypaisa payment (invisible to Malik through RLS)
    const other = await pay(s.accessToken, { ...body, transactionId: 'ep2610010042', attachmentId: await slip(s.accessToken) });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('DUPLICATE_TRANSACTION');
    expect(other.body.error).toEqual(own.body.error);
    expect(JSON.stringify(other.body)).not.toMatch(/Ahmed|ahmed-constructions/i);
    expect(await prismaAdmin.subscriptionPayment.count({ where: { tenantId: seeded().malik.id } })).toBe(3);
  });

  it("slip must be this company's PAYMENT_SLIP → 404", async () => {
    const s = await owner();
    const ahmed = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const foreign = await slip(ahmed.accessToken);
    const body = { method: 'IBFT', transactionId: 'IBFT777001', amountPaisa: '950000', paidOn: today };
    const res = await pay(s.accessToken, { ...body, attachmentId: foreign });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');

    const logo = await upload(s.accessToken, 'LOGO', pngBytes());
    expect((await pay(s.accessToken, { ...body, attachmentId: logo.body.data.id })).status).toBe(404);
  });

  it('paidOn: not in the future, at most 30 days old', async () => {
    const s = await owner();
    const body = { method: 'IBFT', transactionId: 'IBFT777002', amountPaisa: '950000' };
    const future = await pay(s.accessToken, { ...body, paidOn: daysAgo(-1), attachmentId: await slip(s.accessToken) });
    expect(future.body.error.code).toBe('PAID_ON_IN_FUTURE');
    const old = await pay(s.accessToken, { ...body, paidOn: daysAgo(31), attachmentId: await slip(s.accessToken) });
    expect(old.body.error.code).toBe('PAID_ON_TOO_OLD');
    expect((await pay(s.accessToken, { ...body, paidOn: daysAgo(30), attachmentId: await slip(s.accessToken) })).status).toBe(201);
  });

  it('works while READ_ONLY (slip upload + payment); other writes stay blocked', async () => {
    const s = await loginMobile(SEED.oldTown.owner.phone, SEED.oldTown.owner.password);
    expect(s.body.data.tenant.readOnly).toBe(true);

    const logo = await upload(s.accessToken, 'LOGO', pngBytes());
    expect(logo.status).toBe(403);
    expect(logo.body.error.code).toBe('ACCOUNT_READ_ONLY');

    const attachmentId = await slip(s.accessToken);
    const res = await pay(s.accessToken, { method: 'JAZZCASH', transactionId: 'JC2610030555', amountPaisa: '400000', paidOn: today, attachmentId });
    expect(res.status).toBe(201);
    expect(res.body.data.plan.code).toBe('STARTER');

    const holiday = await api().post('/api/v1/company/holidays').set(bearer(s.accessToken)).send({ name: 'Blocked', startDate: '2099-01-01' });
    expect(holiday.status).toBe(403);
  });

  it('PM cannot submit payments', async () => {
    const p = await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
    expect((await pay(p.accessToken, { method: 'IBFT', transactionId: 'IBFT777003', amountPaisa: '950000', paidOn: today, attachmentId: seeded().malik.id })).status).toBe(403);
  });
});

describe('POST/DELETE /subscription/change-plan', () => {
  const plan = (code: 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE') => seeded().plans[code].id;

  it('same plan → 400 SAME_PLAN; TRIAL / unknown → 400 INVALID_PLAN', async () => {
    const s = await owner();
    const same = await api().post('/api/v1/subscription/change-plan').set(bearer(s.accessToken)).send({ planId: plan('PROFESSIONAL') });
    expect(same.body.error.code).toBe('SAME_PLAN');
    const trial = await api().post('/api/v1/subscription/change-plan').set(bearer(s.accessToken)).send({ planId: seeded().plans.TRIAL.id });
    expect(trial.body.error.code).toBe('INVALID_PLAN');
  });

  it('upgrade is pending until payment, with the amount due; cancel removes it', async () => {
    const s = await owner();
    const res = await api().post('/api/v1/subscription/change-plan').set(bearer(s.accessToken)).send({ planId: plan('ENTERPRISE') });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: 'UPGRADE', amountDuePaisa: '2000000', pendingChange: { plan: { code: 'ENTERPRISE' }, effectiveOn: null } });

    const sub = await api().get('/api/v1/subscription').set(bearer(s.accessToken));
    expect(sub.body.data.pendingChange.plan.code).toBe('ENTERPRISE');
    expect(sub.body.data.plan.code).toBe('PROFESSIONAL');

    // A payment without planId now defaults to the pending plan's price
    const wrong = await pay(s.accessToken, { method: 'IBFT', transactionId: 'IBFT888001', amountPaisa: '950000', paidOn: today, attachmentId: await slip(s.accessToken) });
    expect(wrong.body.error.details).toEqual({ expectedPaisa: '2000000', plan: 'ENTERPRISE' });

    expect((await api().delete('/api/v1/subscription/change-plan').set(bearer(s.accessToken))).status).toBe(200);
    const again = await api().delete('/api/v1/subscription/change-plan').set(bearer(s.accessToken));
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('NO_PENDING_CHANGE');
    expect(await prismaAdmin.auditLog.count({ where: { action: { in: ['subscription.change_requested', 'subscription.change_cancelled'] } } })).toBe(2);
  });

  it('downgrade is scheduled for the period end', async () => {
    const s = await owner();
    const res = await api().post('/api/v1/subscription/change-plan').set(bearer(s.accessToken)).send({ planId: plan('STARTER') });
    expect(res.status).toBe(200);
    const sub = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: seeded().malik.id } });
    expect(res.body.data).toMatchObject({ type: 'DOWNGRADE', amountDuePaisa: null, pendingChange: { effectiveOn: sub.currentPeriodEnd!.toISOString() } });
  });

  it('downgrade is blocked while office users exceed the new limit', async () => {
    const s = await owner();
    await prismaAdmin.user.create({ data: { tenantId: seeded().malik.id, name: 'Extra PM', phone: '+923450000501', role: 'PM' } });
    const res = await api().post('/api/v1/subscription/change-plan').set(bearer(s.accessToken)).send({ planId: plan('STARTER') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOWNGRADE_USERS_OVER_LIMIT');
    expect(res.body.error.details).toEqual({ officeUsers: 4, limit: 3 });
  });

  it('too many active projects → keepActiveProjectIds required, validated and stored', async () => {
    const s = await owner();
    const { malik, projects } = seeded();
    const third = await prismaAdmin.project.create({ data: { tenantId: malik.id, name: 'Johar Town — Shop' } });
    const change = (body: Record<string, unknown>) =>
      api().post('/api/v1/subscription/change-plan').set(bearer(s.accessToken)).send({ planId: plan('STARTER'), ...body });

    expect((await change({})).body.error).toMatchObject({ code: 'KEEP_PROJECTS_REQUIRED', details: { activeProjects: 3, limit: 2 } });
    expect((await change({ keepActiveProjectIds: [projects.dha.id, projects.bahria.id, third.id] })).body.error.code).toBe('TOO_MANY_PROJECTS');
    expect((await change({ keepActiveProjectIds: [projects.dha.id, projects.ahmedProject.id] })).body.error.code).toBe('INVALID_PROJECT');

    const ok = await change({ keepActiveProjectIds: [projects.dha.id, third.id] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.pendingChange.keepActiveProjectIds.sort()).toEqual([projects.dha.id, third.id].sort());
    const sub = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: malik.id } });
    expect(sub.keepActiveProjectIds.sort()).toEqual([projects.dha.id, third.id].sort());
  });

  it('PM cannot change the plan', async () => {
    const p = await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
    expect((await api().post('/api/v1/subscription/change-plan').set(bearer(p.accessToken)).send({ planId: plan('STARTER') })).status).toBe(403);
  });
});
