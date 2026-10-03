import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { runSubscriptionLifecycle } from '../../src/jobs/subscriptionLifecycle.js';
import { ConsoleSmsProvider, smsProvider } from '../../src/modules/auth/sms.provider.js';
import { api, bearer, device, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const DAY = 86_400_000;
const MINUTE = 60_000;

const subOf = (tenantId: string) => prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId }, include: { plan: true } });
const tenantStatus = async (id: string) => (await prismaAdmin.tenant.findUniqueOrThrow({ where: { id } })).status;
const remindersTo = (phone: string) =>
  (smsProvider() as ConsoleSmsProvider).outbox.filter((m) => m.to === phone && m.body.includes('Payment slip upload karein'));

describe('subscription lifecycle job', () => {
  it('TRIAL past trialEndsAt → LAPSED, company READ_ONLY; writes then get 403', async () => {
    const signup = await api()
      .post('/api/v1/auth/signup')
      .send({ companyName: 'Trial Builders', ownerName: 'Trial Owner', phone: '03451231231', password: 'Trial#2026', region: 'PUNJAB_KP', client: 'mobile', device: device() });
    const tenantId = signup.body.data.tenant.id as string;
    const token = signup.body.data.accessToken as string;
    const write = () => api().post('/api/v1/company/holidays').set(bearer(token)).send({ name: 'Opening day', startDate: '2099-01-01' });
    expect((await write()).status).toBe(201); // ACTIVE during the trial (also caches status)

    const trialEnd = (await subOf(tenantId)).trialEndsAt!;
    await runSubscriptionLifecycle(new Date(trialEnd.getTime() - MINUTE));
    expect((await subOf(tenantId)).status).toBe('TRIAL');

    const result = await runSubscriptionLifecycle(new Date(trialEnd.getTime() + MINUTE));
    expect(result.trialLapsed).toContain(tenantId);
    expect((await subOf(tenantId)).status).toBe('LAPSED');
    expect(await tenantStatus(tenantId)).toBe('READ_ONLY');

    const blocked = await write();
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_READ_ONLY');
    expect(await prismaAdmin.auditLog.count({ where: { tenantId, action: 'subscription.trial_ended', actorType: 'SYSTEM' } })).toBe(1);
  });

  it('ACTIVE → GRACE at period end (+3 days) → LAPSED when grace runs out', async () => {
    const { malik } = seeded();
    const end = (await subOf(malik.id)).currentPeriodEnd!;

    await runSubscriptionLifecycle(new Date(end.getTime() - MINUTE));
    expect((await subOf(malik.id)).status).toBe('ACTIVE');

    const r1 = await runSubscriptionLifecycle(new Date(end.getTime() + MINUTE));
    expect(r1.graceStarted).toContain(malik.id);
    const grace = await subOf(malik.id);
    expect(grace.status).toBe('GRACE');
    expect(grace.graceEndsAt!.getTime()).toBe(end.getTime() + 3 * DAY);
    expect(await tenantStatus(malik.id)).toBe('ACTIVE'); // grace keeps full access

    await runSubscriptionLifecycle(new Date(end.getTime() + 3 * DAY - MINUTE));
    expect((await subOf(malik.id)).status).toBe('GRACE');

    const r2 = await runSubscriptionLifecycle(new Date(end.getTime() + 3 * DAY + MINUTE));
    expect(r2.lapsed).toContain(malik.id);
    expect((await subOf(malik.id)).status).toBe('LAPSED');
    expect(await tenantStatus(malik.id)).toBe('READ_ONLY');
  });

  it('a job that was down for days still ends in the right state (ACTIVE → GRACE → LAPSED in one run)', async () => {
    const { malik } = seeded();
    const end = (await subOf(malik.id)).currentPeriodEnd!;
    const r = await runSubscriptionLifecycle(new Date(end.getTime() + 10 * DAY));
    expect(r.graceStarted).toContain(malik.id);
    expect(r.lapsed).toContain(malik.id);
    expect((await subOf(malik.id)).status).toBe('LAPSED');
  });

  it('running twice at the same moment changes nothing the second time', async () => {
    const { malik } = seeded();
    const end = (await subOf(malik.id)).currentPeriodEnd!;
    const at = new Date(end.getTime() + 4 * DAY);
    const first = await runSubscriptionLifecycle(at);
    const audits = await prismaAdmin.auditLog.count({ where: { actorType: 'SYSTEM' } });
    const second = await runSubscriptionLifecycle(at);
    expect(first.lapsed.length + first.graceStarted.length).toBeGreaterThan(0);
    expect(second).toEqual({ downgraded: [], trialLapsed: [], graceStarted: [], lapsed: [], reminded: [] });
    expect(await prismaAdmin.auditLog.count({ where: { actorType: 'SYSTEM' } })).toBe(audits);
  });

  it('never overrides a SUSPENDED company', async () => {
    const { malik } = seeded();
    await prismaAdmin.tenant.update({ where: { id: malik.id }, data: { status: 'SUSPENDED' } });
    const end = (await subOf(malik.id)).currentPeriodEnd!;
    await runSubscriptionLifecycle(new Date(end.getTime() + 10 * DAY));
    expect((await subOf(malik.id)).status).toBe('LAPSED');
    expect(await tenantStatus(malik.id)).toBe('SUSPENDED');
  });

  it('a scheduled downgrade is applied at period end; projects outside keepActiveProjectIds become READ_ONLY', async () => {
    const { malik, plans, projects } = seeded();
    const s = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const third = await prismaAdmin.project.create({ data: { tenantId: malik.id, name: 'Johar Town — Shop' } });
    const change = await api()
      .post('/api/v1/subscription/change-plan')
      .set(bearer(s.accessToken))
      .send({ planId: plans.STARTER.id, keepActiveProjectIds: [projects.dha.id, third.id] });
    expect(change.body.data.type).toBe('DOWNGRADE');
    const end = (await subOf(malik.id)).currentPeriodEnd!;

    await runSubscriptionLifecycle(new Date(end.getTime() - MINUTE));
    expect((await subOf(malik.id)).plan.code).toBe('PROFESSIONAL');

    const r = await runSubscriptionLifecycle(new Date(end.getTime() + MINUTE));
    expect(r.downgraded).toContain(malik.id);
    const sub = await subOf(malik.id);
    expect(sub).toMatchObject({ pendingPlanId: null, pendingEffectiveOn: null, keepActiveProjectIds: [], status: 'GRACE' });
    expect(sub.plan.code).toBe('STARTER');
    const statuses = Object.fromEntries(
      (await prismaAdmin.project.findMany({ where: { tenantId: malik.id } })).map((p) => [p.id, p.status]),
    );
    expect(statuses).toEqual({ [projects.dha.id]: 'ACTIVE', [third.id]: 'ACTIVE', [projects.bahria.id]: 'READ_ONLY' });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId: malik.id, action: 'subscription.downgraded' } });
    expect(audit.details).toMatchObject({ from: 'PROFESSIONAL', to: 'STARTER', projectsReadOnly: [projects.bahria.id] });
  });

  it('reminder SMS 3 days and 1 day before the end — once each', async () => {
    const { malik } = seeded();
    const phone = SEED.malik.owner.phone;
    const end = (await subOf(malik.id)).currentPeriodEnd!;
    const before = remindersTo(phone).length;

    await runSubscriptionLifecycle(new Date(end.getTime() - 4 * DAY));
    expect(remindersTo(phone).length).toBe(before);

    const r3 = await runSubscriptionLifecycle(new Date(end.getTime() - 3 * DAY + MINUTE));
    expect(r3.reminded).toContain(malik.id);
    expect(remindersTo(phone).length).toBe(before + 1);
    const text = remindersTo(phone).at(-1)!.body;
    expect(text).toMatch(/^Aap ka Professional plan \d{1,2} \w{3} \d{4} ko khatam ho raha hai\. Payment slip upload karein\.$/);

    await runSubscriptionLifecycle(new Date(end.getTime() - 3 * DAY + 2 * MINUTE));
    await runSubscriptionLifecycle(new Date(end.getTime() - 2 * DAY));
    expect(remindersTo(phone).length).toBe(before + 1);

    await runSubscriptionLifecycle(new Date(end.getTime() - DAY + MINUTE));
    expect(remindersTo(phone).length).toBe(before + 2);
    await runSubscriptionLifecycle(new Date(end.getTime() - DAY + 2 * MINUTE));
    await runSubscriptionLifecycle(new Date(end.getTime() - MINUTE));
    expect(remindersTo(phone).length).toBe(before + 2);

    const audits = await prismaAdmin.auditLog.findMany({ where: { tenantId: malik.id, action: 'subscription.reminder_sent' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => (a.details as { daysBefore: number }).daysBefore)).toEqual([3, 1]);
  });

  it('a GRACE company paying is still possible after the lapse (payment route stays open)', async () => {
    const s = await loginMobile(SEED.valley.owner.phone, SEED.valley.owner.password);
    const { valley } = seeded();
    const sub = await subOf(valley.id);
    await runSubscriptionLifecycle(new Date(sub.graceEndsAt!.getTime() + MINUTE));
    expect(await tenantStatus(valley.id)).toBe('READ_ONLY');
    const res = await api().get('/api/v1/subscription').set(bearer(s.accessToken));
    expect(res.body.data).toMatchObject({ status: 'LAPSED', readOnly: true });
  });
});
