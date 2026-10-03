import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { todayIn } from '../../src/core/utils/dates.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { api, bearer, expectedReceipt, loginAdmin, loginMobile, pngBytes, SEED, upload, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const DAY = 86_400_000;
const today = todayIn('Asia/Karachi');

const admin = async () => bearer((await loginAdmin()).accessToken);
const ahmedPayment = () => prismaAdmin.subscriptionPayment.findUniqueOrThrow({ where: { transactionId: 'EP2610010042' } });

/** A company submits a payment through its own API (slip upload + POST /subscription/payments). */
async function submit(owner: { phone: string; password: string }, body: Record<string, unknown>) {
  const s = await loginMobile(owner.phone, owner.password);
  const slip = await upload(s.accessToken, 'PAYMENT_SLIP', pngBytes(), 'slip.png');
  const res = await api()
    .post('/api/v1/subscription/payments')
    .set(bearer(s.accessToken))
    .send({ paidOn: today, attachmentId: slip.body.data.id, ...body });
  expect(res.status).toBe(201);
  return { token: s.accessToken, paymentId: res.body.data.id as string };
}

describe('GET /admin/payments', () => {
  it('review queue (PENDING_REVIEW by default) with the expected amount', async () => {
    const res = await api().get('/api/v1/admin/payments').set(await admin());
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      tenant: { name: SEED.ahmed.name },
      plan: { code: 'STARTER' },
      expectedAmountPaisa: '400000',
      amountPaisa: '400000',
      method: 'EASYPAISA',
      transactionId: 'EP2610010042',
      status: 'PENDING_REVIEW',
      duplicateWarning: false,
    });
    const approved = await api().get('/api/v1/admin/payments?status=APPROVED').set(await admin());
    expect(approved.body.meta.total).toBe(3);
    const filtered = await api().get(`/api/v1/admin/payments?status=APPROVED&tenantId=${seeded().ahmed.id}`).set(await admin());
    expect(filtered.body.meta.total).toBe(0);
  });

  it('flags a possible duplicate: same amount + method within a day from another company', async () => {
    const { valley } = seeded();
    const ahmed = await ahmedPayment();
    const sub = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: valley.id } });
    await prismaAdmin.subscriptionPayment.create({
      data: {
        tenantId: valley.id,
        subscriptionId: sub.id,
        planId: sub.planId,
        amountPaisa: 400_000n,
        method: 'EASYPAISA',
        transactionId: 'EP2610010043',
        paidOn: ahmed.paidOn,
      },
    });
    const res = await api().get('/api/v1/admin/payments').set(await admin());
    expect(res.body.data.map((p: { duplicateWarning: boolean }) => p.duplicateWarning)).toEqual([true, true]);

    const detail = await api().get(`/api/v1/admin/payments/${ahmed.id}`).set(await admin());
    expect(detail.body.data.duplicateOf).toEqual([{ tenantName: SEED.valley.name, paidOn: detail.body.data.paidOn, status: 'PENDING_REVIEW' }]);
  });

  it('detail includes a signed slip URL', async () => {
    const { paymentId } = await submit(SEED.oldTown.owner, { method: 'JAZZCASH', transactionId: 'JC2610050001', amountPaisa: '400000' });
    const res = await api().get(`/api/v1/admin/payments/${paymentId}`).set(await admin());
    expect(res.body.data.slip.url).toContain('/api/v1/attachments/');
    expect(res.body.data.submittedBy.name).toBe('Nasir Butt');
    const missing = await api().get('/api/v1/admin/payments/0199a8c0-0000-7000-8000-000000000999').set(await admin());
    expect(missing.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });
});

describe('POST /admin/payments/:id/approve', () => {
  it('a LAPSED company becomes ACTIVE at once (writes work right after), 30 days from today, next receipt', async () => {
    const { oldTown } = seeded();
    const { token, paymentId } = await submit(SEED.oldTown.owner, { method: 'JAZZCASH', transactionId: 'JC2610050002', amountPaisa: '400000' });
    // The company is read-only (and its status is now cached)
    const before = await api().post('/api/v1/company/holidays').set(bearer(token)).send({ name: 'Before', startDate: '2099-01-01' });
    expect(before.body.error.code).toBe('ACCOUNT_READ_ONLY');

    const res = await api().post(`/api/v1/admin/payments/${paymentId}/approve`).set(await admin()).send({ note: 'Checked with JazzCash' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', receiptNo: expectedReceipt(1) });
    const start = Date.parse(res.body.data.periodStart);
    expect(Math.abs(start - Date.now())).toBeLessThan(60_000);
    expect(Date.parse(res.body.data.periodEnd) - start).toBe(30 * DAY);

    const sub = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: oldTown.id } });
    expect(sub).toMatchObject({ status: 'ACTIVE', graceEndsAt: null });
    expect((await prismaAdmin.tenant.findUniqueOrThrow({ where: { id: oldTown.id } })).status).toBe('ACTIVE');

    const after = await api().post('/api/v1/company/holidays').set(bearer(token)).send({ name: 'After', startDate: '2099-01-02' });
    expect(after.status).toBe(201); // cache invalidated

    expect(lastSmsTo(SEED.oldTown.owner.phone)!.body).toMatch(/^Payment approve ho gayi\. Starter \d{1,2} \w{3} \d{4} tak active\.$/);
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'subscription.payment_approved' } });
    expect(audit).toMatchObject({ actorType: 'PLATFORM_ADMIN', tenantId: oldTown.id });
  });

  it('an ACTIVE company is extended from its period end; receipts are sequential', async () => {
    const { ahmed } = seeded();
    const sub = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: ahmed.id } });
    const oldEnd = sub.currentPeriodEnd!.getTime();
    const first = await api().post(`/api/v1/admin/payments/${(await ahmedPayment()).id}/approve`).set(await admin()).send({});
    expect(first.body.data.receiptNo).toBe(expectedReceipt(1));
    expect(Date.parse(first.body.data.periodStart)).toBe(oldEnd);
    expect(Date.parse(first.body.data.periodEnd)).toBe(oldEnd + 30 * DAY);
    expect((await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: ahmed.id } })).currentPeriodEnd!.getTime()).toBe(oldEnd + 30 * DAY);

    const { paymentId } = await submit(SEED.oldTown.owner, { method: 'RAAST', transactionId: 'RAAST2610050003', amountPaisa: '400000' });
    const second = await api().post(`/api/v1/admin/payments/${paymentId}/approve`).set(await admin()).send({});
    expect(second.body.data.receiptNo).toBe(expectedReceipt(2));
  });

  it('a pending upgrade is applied when its payment is approved', async () => {
    const { malik, plans } = seeded();
    const k = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    await api().post('/api/v1/subscription/change-plan').set(bearer(k.accessToken)).send({ planId: plans.ENTERPRISE.id });
    const { paymentId } = await submit(SEED.malik.owner, { method: 'IBFT', transactionId: 'IBFT2610050004', amountPaisa: '2000000' });

    await api().post(`/api/v1/admin/payments/${paymentId}/approve`).set(await admin()).send({});
    const sub = await prismaAdmin.subscription.findUniqueOrThrow({ where: { tenantId: malik.id }, include: { plan: true } });
    expect(sub.plan.code).toBe('ENTERPRISE');
    expect(sub.pendingPlanId).toBeNull();
  });

  it('approving (or rejecting) twice → 409 ALREADY_PROCESSED', async () => {
    const id = (await ahmedPayment()).id;
    expect((await api().post(`/api/v1/admin/payments/${id}/approve`).set(await admin()).send({})).status).toBe(200);
    const again = await api().post(`/api/v1/admin/payments/${id}/approve`).set(await admin()).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PROCESSED');
    expect((await api().post(`/api/v1/admin/payments/${id}/reject`).set(await admin()).send({ reason: 'Too late now' })).status).toBe(409);
  });

  it('parallel approvals of two payments never share a receipt number', async () => {
    const a = await submit(SEED.oldTown.owner, { method: 'IBFT', transactionId: 'IBFT2610050005', amountPaisa: '400000' });
    const h = await admin();
    const [r1, r2] = await Promise.all([
      api().post(`/api/v1/admin/payments/${a.paymentId}/approve`).set(h).send({}),
      api().post(`/api/v1/admin/payments/${(await ahmedPayment()).id}/approve`).set(h).send({}),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect([r1.body.data.receiptNo, r2.body.data.receiptNo].sort()).toEqual([expectedReceipt(1), expectedReceipt(2)]);
  });
});

describe('POST /admin/payments/:id/reject', () => {
  it('needs a 5–300 character reason; the company sees REJECTED + reason', async () => {
    const id = (await ahmedPayment()).id;
    expect((await api().post(`/api/v1/admin/payments/${id}/reject`).set(await admin()).send({})).status).toBe(400);
    expect((await api().post(`/api/v1/admin/payments/${id}/reject`).set(await admin()).send({ reason: 'bad' })).status).toBe(400);

    const reason = 'Slip is blurred — please upload a clear photo';
    const res = await api().post(`/api/v1/admin/payments/${id}/reject`).set(await admin()).send({ reason });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'REJECTED', rejectReason: reason });

    const company = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const history = await api().get('/api/v1/subscription/payments').set(bearer(company.accessToken));
    expect(history.body.data[0]).toMatchObject({ transactionId: 'EP2610010042', status: 'REJECTED', rejectReason: reason });
    expect(lastSmsTo(SEED.ahmed.owner.phone)!.body).toBe(`Aap ki payment (EP2610010042) reject ho gayi: ${reason}`);

    // The company may submit again (one pending at a time is free again)
    const slip = await upload(company.accessToken, 'PAYMENT_SLIP', pngBytes(), 'clear.png');
    const resubmit = await api()
      .post('/api/v1/subscription/payments')
      .set(bearer(company.accessToken))
      .send({ method: 'EASYPAISA', transactionId: 'EP2610010099', amountPaisa: '400000', paidOn: today, attachmentId: slip.body.data.id });
    expect(resubmit.status).toBe(201);
    const queue = await api().get('/api/v1/admin/payments').set(await admin());
    expect(queue.body.data.find((p: { transactionId: string }) => p.transactionId === 'EP2610010099').duplicateWarning).toBe(false);
  });
});
