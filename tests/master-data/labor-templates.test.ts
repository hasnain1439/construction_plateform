import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

describe('labour rates', () => {
  it('MUNSHI can read labour rates (seeded defaults)', async () => {
    const res = await api().get('/api/v1/labor-rates').set(bearer((await loginMunshi(seeded().malik.id)).accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(14);
    const byKey = Object.fromEntries(res.body.data.map((r: { key: string }) => [r.key, r]));
    expect(byKey.MISTRI).toMatchObject({ kind: 'DAILY', unit: 'DAY', ratePaisa: '280000', overtimeMultiplier: 1.5 });
    expect(byKey.MAZDOOR.ratePaisa).toBe('160000');
    expect(byKey.STEEL_FIXING).toMatchObject({ kind: 'SUBCONTRACT', unit: 'TON', ratePaisa: '900000', overtimeMultiplier: null });
    expect(byKey.PLUMBING_ROUGH_IN).toMatchObject({ unit: 'LUMPSUM', ratePaisa: '12000000' });
  });

  it('PUT upserts (THEKEDAR only) and reports changed / unchanged', async () => {
    const auth = await owner();
    const body = {
      rates: [
        { kind: 'DAILY', key: 'MISTRI', unit: 'DAY', ratePaisa: '300000' },
        { kind: 'DAILY', key: 'mazdoor', unit: 'DAY', ratePaisa: '160000' }, // unchanged (key upper-cased)
        { kind: 'SUBCONTRACT', key: 'PLASTER', label: 'Plaster (both sides)', unit: 'SQFT', ratePaisa: 2500 },
      ],
    };
    expect((await api().put('/api/v1/labor-rates').set(await pm()).send(body)).status).toBe(403);
    const res = await api().put('/api/v1/labor-rates').set(auth).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ changed: 2, unchanged: 1 });
    const byKey = Object.fromEntries(res.body.data.rates.map((r: { key: string }) => [r.key, r]));
    expect(byKey.MISTRI).toMatchObject({ ratePaisa: '300000', label: 'Mistri', overtimeMultiplier: 1.5 });
    expect(byKey.PLASTER).toMatchObject({ label: 'Plaster (both sides)', ratePaisa: '2500' });
    expect(await prismaAdmin.auditLog.count({ where: { action: 'labor_rates.update' } })).toBe(1);

    const bad = await api().put('/api/v1/labor-rates').set(auth).send({ rates: [{ kind: 'DAILY', key: 'SHUTTERING', unit: 'DAY', ratePaisa: 1 }] });
    expect(bad.body.error.code).toBe('INVALID_LABOR_KEY');
  });
});

describe('payment templates', () => {
  const stages = (...percents: number[]) => percents.map((percent, i) => ({ label: `Stage ${i + 1}`, percent }));

  it('lists the seeded templates (THEKEDAR / PM), MUNSHI → 403', async () => {
    const res = await api().get('/api/v1/payment-templates').set(await pm());
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { name: string }) => t.name)).toEqual(['Residential standard', 'Commercial', 'Labor-only monthly']);
    expect(res.body.data[0]).toMatchObject({ isDefault: true, billingModel: 'STAGE_SCHEDULE' });
    expect(res.body.data[0].stages).toHaveLength(8);
    expect(res.body.data[0].stages[7]).toMatchObject({ percent: 5, isRetention: true });
    expect((await api().get('/api/v1/payment-templates').set(bearer((await loginMunshi(seeded().malik.id)).accessToken))).status).toBe(403);
  });

  it('total must be exactly 100 → else 400 PERCENT_TOTAL_INVALID {total}; at most one retention', async () => {
    const auth = await owner();
    const ninetyFive = await api().post('/api/v1/payment-templates').set(auth).send({ name: 'Short', stages: stages(50, 45) });
    expect(ninetyFive.status).toBe(400);
    expect(ninetyFive.body.error).toMatchObject({ code: 'PERCENT_TOTAL_INVALID', details: { total: 95 } });

    const twoRetention = await api()
      .post('/api/v1/payment-templates')
      .set(auth)
      .send({ name: 'Two retentions', stages: [{ label: 'A', percent: 90 }, { label: 'R1', percent: 5, isRetention: true }, { label: 'R2', percent: 5, isRetention: true }] });
    expect(twoRetention.status).toBe(400);
    expect(twoRetention.body.error.code).toBe('RETENTION_STAGE_INVALID');

    expect((await api().post('/api/v1/payment-templates').set(auth).send({ name: 'Too many', stages: stages(...Array(16).fill(6.25)) })).status).toBe(400);

    const ok = await api().post('/api/v1/payment-templates').set(auth).send({ name: 'Thirds', stages: stages(33.33, 33.33, 33.34) });
    expect(ok.status).toBe(201);
    const dup = await api().post('/api/v1/payment-templates').set(auth).send({ name: 'Thirds', stages: stages(100) });
    expect(dup.body.error.code).toBe('TEMPLATE_EXISTS');
  });

  it('exactly one default; the default cannot be deleted', async () => {
    const auth = await owner();
    const created = await api().post('/api/v1/payment-templates').set(auth).send({ name: 'Villa', stages: stages(40, 60), isDefault: true });
    expect(created.body.data.isDefault).toBe(true);
    const defaults = async () =>
      (await prismaAdmin.paymentScheduleTemplate.findMany({ where: { tenantId: seeded().malik.id, isDefault: true } })).map((t) => t.name);
    expect(await defaults()).toEqual(['Villa']);

    const deleteDefault = await api().delete(`/api/v1/payment-templates/${created.body.data.id}`).set(auth);
    expect(deleteDefault.status).toBe(400);
    expect(deleteDefault.body.error.code).toBe('TEMPLATE_IS_DEFAULT');
    expect((await api().patch(`/api/v1/payment-templates/${created.body.data.id}`).set(auth).send({ isDefault: false })).status).toBe(400);

    const residential = await prismaAdmin.paymentScheduleTemplate.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Residential standard' } });
    const patched = await api().patch(`/api/v1/payment-templates/${residential.id}`).set(auth).send({ isDefault: true, stages: stages(50, 50) });
    expect(patched.status).toBe(200);
    expect(await defaults()).toEqual(['Residential standard']);

    expect((await api().delete(`/api/v1/payment-templates/${created.body.data.id}`).set(auth)).status).toBe(200);
    expect(await prismaAdmin.auditLog.count({ where: { action: { startsWith: 'payment_template.' } } })).toBe(3);
  });
});
