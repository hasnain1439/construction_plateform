import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../src/core/db/prisma.js';
import { todayIn } from '../src/core/utils/dates.js';
import { api, bearer, loginMobile, loginMunshi, pathOf, pngBytes, SEED, upload, useFreshDatabase } from './helpers.js';

const seeded = useFreshDatabase();
const owner = () => loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
const pm = () => loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
const year = Number(todayIn('Asia/Karachi').slice(0, 4));
const nextYear = year + 1;

describe('company access', () => {
  it('PM can read the company but not change it or its settings', async () => {
    const s = await pm();
    expect((await api().get('/api/v1/company').set(bearer(s.accessToken))).status).toBe(200);
    const patch = await api().patch('/api/v1/company').set(bearer(s.accessToken)).send({ name: 'Hijacked' });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe('FORBIDDEN');
    expect((await api().patch('/api/v1/company/settings').set(bearer(s.accessToken)).send({ taxEnabled: true })).status).toBe(403);
    expect((await api().get('/api/v1/company/settings').set(bearer(s.accessToken))).status).toBe(403);
  });

  it('MUNSHI cannot read the company profile but can read holidays', async () => {
    const s = await loginMunshi(seeded().malik.id);
    expect((await api().get('/api/v1/company').set(bearer(s.accessToken))).status).toBe(403);
    expect((await api().get('/api/v1/company/holidays').set(bearer(s.accessToken))).status).toBe(200);
  });
});

describe('GET / PATCH /company', () => {
  it('returns the profile', async () => {
    const s = await owner();
    const res = await api().get('/api/v1/company').set(bearer(s.accessToken));
    expect(res.body.data).toMatchObject({
      name: SEED.malik.name,
      slug: SEED.malik.slug,
      ntn: '1234567-8',
      region: 'PUNJAB_KP',
      marlaStandard: 225,
      status: 'ACTIVE',
      logoUrl: null,
    });
  });

  it('validates NTN and normalises phone; audits changed field names only', async () => {
    const s = await owner();
    const bad = await api().patch('/api/v1/company').set(bearer(s.accessToken)).send({ ntn: '12345678' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields[0].field).toBe('ntn');

    const res = await api()
      .patch('/api/v1/company')
      .set(bearer(s.accessToken))
      .send({ ntn: '7654321-0', phone: '0300-7654321', marlaStandard: 272.25, address: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ntn: '7654321-0', phone: '+923007654321', marlaStandard: 272.25, address: null });

    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'company.update' } });
    expect((audit.details as { fields: string[] }).fields.sort()).toEqual(['address', 'marlaStandard', 'ntn', 'phone']);
  });

  it('logo must be a LOGO attachment of this company (else 404); a valid logo gets a working signed URL', async () => {
    const s = await owner();
    const photo = await upload(s.accessToken, 'PROFILE_PHOTO', pngBytes());
    const wrongKind = await api().patch('/api/v1/company').set(bearer(s.accessToken)).send({ logoAttachmentId: photo.body.data.id });
    expect(wrongKind.status).toBe(404);
    expect(wrongKind.body.error.code).toBe('ATTACHMENT_NOT_FOUND');

    const ahmed = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const foreign = await upload(ahmed.accessToken, 'LOGO', pngBytes());
    const other = await api().patch('/api/v1/company').set(bearer(s.accessToken)).send({ logoAttachmentId: foreign.body.data.id });
    expect(other.status).toBe(404);

    const logo = await upload(s.accessToken, 'LOGO', pngBytes());
    const ok = await api().patch('/api/v1/company').set(bearer(s.accessToken)).send({ logoAttachmentId: logo.body.data.id });
    expect(ok.status).toBe(200);
    expect(ok.body.data.logoUrl).toContain(`/api/v1/attachments/${logo.body.data.id}/file?`);
    const file = await api().get(pathOf(ok.body.data.logoUrl));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');

    // The logo also shows up in /auth/me
    const me = await api().get('/api/v1/auth/me').set(bearer(s.accessToken));
    expect(me.body.data.tenant.logoUrl).toContain(logo.body.data.id);
  });
});

describe('company settings', () => {
  it('returns defaults with money as a string', async () => {
    const s = await owner();
    const res = await api().get('/api/v1/company/settings').set(bearer(s.accessToken));
    expect(res.body.data).toEqual({
      kharchaApprovalLimitPaisa: '2500000',
      overuseAlertPercent: 10,
      missingLogAlertTime: '18:00',
      quoteValidityDays: 15,
      taxEnabled: false,
      pmCanSeeFinancials: false,
      blindCountEnabled: true,
      defaultLanguage: 'ROMAN_URDU',
    });
  });

  it('enforces ranges', async () => {
    const s = await owner();
    for (const body of [
      { overuseAlertPercent: 50 },
      { overuseAlertPercent: 0 },
      { quoteValidityDays: 91 },
      { missingLogAlertTime: '25:00' },
      { kharchaApprovalLimitPaisa: '-5' },
      { kharchaApprovalLimitPaisa: '12.50' },
      {},
    ]) {
      const res = await api().patch('/api/v1/company/settings').set(bearer(s.accessToken)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('BigInt paisa round-trips as a string (beyond Number precision) and is audited before/after', async () => {
    const s = await owner();
    const huge = '900719925474099312'.slice(0, 15); // 15 digits
    const res = await api()
      .patch('/api/v1/company/settings')
      .set(bearer(s.accessToken))
      .send({ kharchaApprovalLimitPaisa: huge, overuseAlertPercent: 15, taxEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data.kharchaApprovalLimitPaisa).toBe(huge);
    expect((await api().get('/api/v1/company/settings').set(bearer(s.accessToken))).body.data.kharchaApprovalLimitPaisa).toBe(huge);

    const row = await prismaAdmin.tenantSettings.findUniqueOrThrow({ where: { tenantId: seeded().malik.id } });
    expect(row.kharchaApprovalLimitPaisa).toBe(BigInt(huge));
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { action: 'settings.update' } });
    expect(audit.details).toEqual({
      before: { kharchaApprovalLimitPaisa: '2500000', overuseAlertPercent: 10, taxEnabled: false },
      after: { kharchaApprovalLimitPaisa: huge, overuseAlertPercent: 15, taxEnabled: true },
    });
  });
});

describe('holidays', () => {
  it('merges platform (read-only) and company holidays, sorted', async () => {
    const s = await owner();
    const created = await api()
      .post('/api/v1/company/holidays')
      .set(bearer(s.accessToken))
      .send({ name: 'Site closed — monsoon', startDate: `${nextYear}-08-10`, endDate: `${nextYear}-08-12` });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ source: 'company', editable: true, type: 'NON_WORKING', endDate: `${nextYear}-08-12` });

    const res = await api().get(`/api/v1/company/holidays?year=${nextYear}`).set(bearer(s.accessToken));
    expect(res.status).toBe(200);
    const names = res.body.data.map((h: { name: string }) => h.name);
    expect(names).toContain('Independence Day');
    expect(names).toContain('Site closed — monsoon');
    const starts = res.body.data.map((h: { startDate: string }) => h.startDate);
    expect(starts).toEqual([...starts].sort());
    const platform = res.body.data.find((h: { name: string }) => h.name === 'Independence Day');
    expect(platform).toMatchObject({ source: 'platform', editable: false, startDate: `${nextYear}-08-14` });

    const august = await api().get(`/api/v1/company/holidays?from=${nextYear}-08-11&to=${nextYear}-08-31`).set(bearer(s.accessToken));
    expect(august.body.data.map((h: { name: string }) => h.name)).toEqual(['Site closed — monsoon', 'Independence Day']);
  });

  it('platform holiday cannot be deleted (404); company holiday can', async () => {
    const s = await owner();
    const platform = await prismaAdmin.platformHoliday.findFirstOrThrow();
    const res = await api().delete(`/api/v1/company/holidays/${platform.id}`).set(bearer(s.accessToken));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('HOLIDAY_NOT_FOUND');

    const created = await api().post('/api/v1/company/holidays').set(bearer(s.accessToken)).send({ name: 'Annual dinner', startDate: `${nextYear}-12-30`, type: 'PARTIAL' });
    const del = await api().delete(`/api/v1/company/holidays/${created.body.data.id}`).set(bearer(s.accessToken));
    expect(del.status).toBe(200);
    expect(await prismaAdmin.auditLog.count({ where: { action: { in: ['holiday.create', 'holiday.delete'] } } })).toBe(2);
  });

  it('validates dates: endDate < startDate → 400, past → 400, duplicate → 409, bad query → 400', async () => {
    const s = await owner();
    const reversed = await api()
      .post('/api/v1/company/holidays')
      .set(bearer(s.accessToken))
      .send({ name: 'Wrong', startDate: `${nextYear}-08-12`, endDate: `${nextYear}-08-10` });
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.details.fields[0].field).toBe('endDate');

    const past = await api().post('/api/v1/company/holidays').set(bearer(s.accessToken)).send({ name: 'Old', startDate: `${year - 1}-01-01` });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe('HOLIDAY_IN_PAST');

    const body = { name: 'Dup', startDate: `${nextYear}-03-01` };
    expect((await api().post('/api/v1/company/holidays').set(bearer(s.accessToken)).send(body)).status).toBe(201);
    const dup = await api().post('/api/v1/company/holidays').set(bearer(s.accessToken)).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('HOLIDAY_EXISTS');

    expect((await api().get('/api/v1/company/holidays?from=2026-02-30&to=2026-03-01').set(bearer(s.accessToken))).status).toBe(400);
    expect((await api().get('/api/v1/company/holidays?from=2026-03-01').set(bearer(s.accessToken))).status).toBe(400);
  });
});
