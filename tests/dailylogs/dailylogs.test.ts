import { describe, expect, it } from 'vitest';
import { runMissingLogCheck } from '../../src/jobs/missingLogs.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { addDays } from '../../src/modules/labor/labor.shared.js';
import { bearer, loginMunshi, pngBytes, useFreshDatabase } from '../helpers.js';
import { api, attachment, owner, pm, today } from '../labor/fixtures.js';

const seeded = useFreshDatabase();

const munshiAuth = async () => {
  const s = await loginMunshi(seeded().malik.id);
  return { auth: bearer(s.accessToken), deviceId: s.deviceId };
};
const post = (auth: Record<string, string>, projectId: string, body: Record<string, unknown>) => api().post(`/api/v1/projects/${projectId}/daily-logs`).set(auth).send(body);

describe('daily logs', () => {
  it('create is idempotent by clientId; the author edits it the same day', async () => {
    const { auth } = await munshiAuth();
    const dha = seeded().projects.dha.id;
    const photo = await attachment(auth, 'SITE_PHOTO');
    const clientId = uuidv7();
    const body = { clientId, conditions: ['CURING', 'POWER_CUT'], workDone: '1F column curing day 10, water given twice', note: 'Power cut 2–5 PM', photoAttachmentIds: [photo], deviceCreatedAt: new Date().toISOString() };
    const first = await post(auth, dha, body);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ logDate: today(), conditions: ['CURING', 'POWER_CUT'], editable: true, lateSync: false, author: { name: 'Rafaqat Ali' } });
    expect(first.body.data.photos).toHaveLength(1);
    const again = await post(auth, dha, body);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);

    const edited = await post(auth, dha, { note: 'Power cut 2–5 PM, generator used' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ id: first.body.data.id, note: 'Power cut 2–5 PM, generator used', conditions: ['CURING', 'POWER_CUT'] });
    expect(await prismaAdmin.dailyLog.count()).toBe(1);

    // Another person can't change it; they write their own log for the day.
    expect((await api().patch(`/api/v1/daily-logs/${first.body.data.id}`).set(await pm()).send({ note: 'x' })).body.error.code).toBe('LOG_LOCKED');
    expect((await post(await pm(), dha, { workDone: 'Checked the columns' })).status).toBe(201);
  });

  it('a past day can be written once but not changed (409 LOG_LOCKED); future / too old are refused', async () => {
    const { auth } = await munshiAuth();
    const dha = seeded().projects.dha.id;
    const yesterday = addDays(today(), -1);
    expect((await post(auth, dha, { logDate: yesterday, workDone: 'Shuttering' })).status).toBe(201);
    const locked = await post(auth, dha, { logDate: yesterday, workDone: 'Shuttering + steel' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('LOG_LOCKED');
    expect((await post(auth, dha, { logDate: addDays(today(), 1) })).body.error.code).toBe('FUTURE_DATE');
    expect((await post(auth, dha, { logDate: addDays(today(), -8) })).body.error.code).toBe('DATE_TOO_OLD');
    // Not his project → 404.
    expect((await post(auth, seeded().projects.bahria.id, { note: 'x' })).status).toBe(404);
  });

  it('detail shows the day: hazri and the munshi’s own kharcha only; late sync flagged', async () => {
    const { auth } = await munshiAuth();
    const s = seeded();
    const dha = s.projects.dha.id;
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const created = (await post(auth, dha, { workDone: 'Plaster', deviceCreatedAt: old })).body.data;
    expect(created.lateSync).toBe(true);

    const acc = await prismaAdmin.cashAccount.create({ data: { tenantId: s.malik.id, holderUserId: s.users.rafaqatMalik.id, name: 'Rafaqat' } });
    const other = await prismaAdmin.cashAccount.create({ data: { tenantId: s.malik.id, holderUserId: s.users.bilal.id, name: 'Bilal' } });
    for (const [account, amount] of [[acc.id, -120000n], [other.id, -500000n]] as const) {
      await prismaAdmin.cashEntry.create({ data: { tenantId: s.malik.id, accountId: account, projectId: dha, type: 'EXPENSE', amountPaisa: amount, description: 'tea', status: 'APPROVED', occurredAt: new Date() } });
    }
    const mine = (await api().get(`/api/v1/daily-logs/${created.id}`).set(auth)).body.data.summary;
    expect(mine.kharcha).toEqual({ scope: 'MINE', entries: 1, totalPaisa: '120000' });
    const office = (await api().get(`/api/v1/daily-logs/${created.id}`).set(await owner())).body.data.summary;
    expect(office.kharcha).toEqual({ scope: 'PROJECT', entries: 2, totalPaisa: '620000' });
    expect(office.hazri).toEqual({ full: 0, half: 0, absent: 0, present: 0 });
    const list = await api().get(`/api/v1/projects/${dha}/daily-logs`).set(await owner()).query({ from: today(), to: today() });
    expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([created.id]);
  });
});

describe('missing daily-log job', () => {
  const at = (hhmm: string) => new Date(`${today()}T${hhmm}:00+05:00`);

  it('after the alert time: one notice per project per day to the PM and owner', async () => {
    const s = seeded();
    expect((await runMissingLogCheck(at('17:30'))).sent).toEqual([]); // before 18:00
    const first = await runMissingLogCheck(at('18:15'));
    expect(first.sent).toContain(s.projects.dha.id);
    const notes = await prismaAdmin.notification.findMany({ where: { type: 'MISSING_DAILY_LOG', refId: s.projects.dha.id }, include: { user: { select: { name: true } } } });
    expect(notes.map((n) => n.user.name).sort()).toEqual(['Bilal Ahmed', 'Khalid Malik']);
    expect(notes[0]!.title).toBe('DHA Phase 6 · 10 Marla: aaj ka log nahi aaya');
    expect((await runMissingLogCheck(at('18:30'))).sent).toEqual([]); // once a day
  });

  it('a log (or hazri) today means no notice; pending uploads change the message', async () => {
    const s = seeded();
    const { auth, deviceId } = await munshiAuth();
    await post(auth, s.projects.dha.id, { workDone: 'Brickwork' });
    await prismaAdmin.device.updateMany({ where: { clientDeviceId: deviceId }, data: { pendingUploads: 12 } });
    const r = await runMissingLogCheck(at('18:15'));
    expect(r.sent).not.toContain(s.projects.dha.id);
    // Asif's Bahria site: nothing logged, but say entries are waiting when his phone has some.
    await prismaAdmin.device.create({ data: { tenantId: s.malik.id, userId: s.users.asif.id, clientDeviceId: 'asif-phone-0001', platform: 'ANDROID', pendingUploads: 12 } });
    await prismaAdmin.notification.deleteMany({ where: { type: 'MISSING_DAILY_LOG' } });
    await runMissingLogCheck(at('18:20'));
    const bahria = await prismaAdmin.notification.findFirstOrThrow({ where: { type: 'MISSING_DAILY_LOG', refId: s.projects.bahria.id } });
    expect(bahria.title).toBe('Bahria Town · 1 Kanal: 12 entries waiting to sync');
  });
});

describe('attachments from the app', () => {
  it('a retried upload with the same clientId returns the same file; voice notes over 2 MB are refused', async () => {
    const { auth } = await munshiAuth();
    const clientId = uuidv7();
    const send = () => api().post('/api/v1/attachments').set(auth).field('kind', 'SITE_PHOTO').field('clientId', clientId).attach('file', pngBytes(2048), { filename: 'site.png', contentType: 'image/png' });
    const a = await send();
    expect(a.status).toBe(201);
    const b = await send();
    expect(b.status).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await prismaAdmin.attachment.count({ where: { clientId } })).toBe(1);

    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1);
    Buffer.from('ID3').copy(big);
    const voice = await api().post('/api/v1/attachments').set(auth).field('kind', 'VOICE_NOTE').attach('file', big, { filename: 'v.mp3', contentType: 'audio/mpeg' });
    expect(voice.body.error.code).toBe('FILE_TOO_LARGE');
  });
});
