import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../src/core/db/prisma.js';
import { fileSignature } from '../src/modules/attachments/storage.provider.js';
import { api, bearer, loginMobile, loginMunshi, pathOf, pngBytes, SEED, upload, useFreshDatabase } from './helpers.js';

const seeded = useFreshDatabase();
const owner = () => loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);

describe('attachments', () => {
  it('uploads a PNG logo and serves it through the signed URL', async () => {
    const s = await owner();
    const bytes = pngBytes(2048);
    const res = await upload(s.accessToken, 'LOGO', bytes, 'Malik Logo.png');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'LOGO', mimeType: 'image/png', sizeBytes: 2048, fileName: 'Malik Logo.png' });
    expect(new Date(res.body.data.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = await prismaAdmin.attachment.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.storageKey).toMatch(new RegExp(`^${seeded().malik.id}/\\d{4}/\\d{2}/${row.id}\\.png$`));
    expect(await prismaAdmin.auditLog.count({ where: { action: 'attachment.upload' } })).toBe(1);

    // No login needed for the signed link
    const file = await api().get(pathOf(res.body.data.url)).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.compare(file.body as Buffer, bytes)).toBe(0);

    // Metadata returns a fresh signed URL
    const meta = await api().get(`/api/v1/attachments/${res.body.data.id}`).set(bearer(s.accessToken));
    expect(meta.status).toBe(200);
    expect(meta.body.data.id).toBe(res.body.data.id);
  });

  it('any company role can upload (Munshi voice note / site photo)', async () => {
    const s = await loginMunshi(seeded().malik.id);
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200)]);
    const res = await upload(s.accessToken, 'VOICE_NOTE', ogg, 'note.ogg', 'audio/ogg');
    expect(res.status).toBe(201);
  });

  it('tampered or expired signatures → 403', async () => {
    const s = await owner();
    const res = await upload(s.accessToken, 'LOGO', pngBytes());
    const url = new URL(res.body.data.url);

    const tampered = new URL(url);
    const sig = tampered.searchParams.get('sig')!;
    tampered.searchParams.set('sig', (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1));
    const bad = await api().get(pathOf(tampered.toString()));
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('INVALID_SIGNATURE');

    const longer = new URL(url);
    longer.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 3600));
    expect((await api().get(pathOf(longer.toString()))).status).toBe(403);

    const id = res.body.data.id as string;
    const tid = seeded().malik.id;
    const exp = Math.floor(Date.now() / 1000) - 10;
    const expired = await api().get(`/api/v1/attachments/${id}/file?tid=${tid}&exp=${exp}&sig=${fileSignature(id, tid, exp)}`);
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('LINK_EXPIRED');

    // A valid signature for another company's id does not open this file
    const otherTid = seeded().ahmed.id;
    const future = Math.floor(Date.now() / 1000) + 60;
    const crossTenant = await api().get(`/api/v1/attachments/${id}/file?tid=${otherTid}&exp=${future}&sig=${fileSignature(id, otherTid, future)}`);
    expect(crossTenant.status).toBe(404);
  });

  it("another company can't read the metadata", async () => {
    const s = await owner();
    const res = await upload(s.accessToken, 'DOCUMENT', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100)]), 'boq.pdf', 'application/pdf');
    expect(res.status).toBe(201);
    const ahmed = await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password);
    const other = await api().get(`/api/v1/attachments/${res.body.data.id}`).set(bearer(ahmed.accessToken));
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('rejects 11 MB (400 FILE_TOO_LARGE), wrong types, mismatched content and missing file', async () => {
    const s = await owner();
    const big = await upload(s.accessToken, 'SITE_PHOTO', pngBytes(11 * 1024 * 1024));
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');

    const text = await upload(s.accessToken, 'DOCUMENT', Buffer.from('hello'), 'notes.txt', 'text/plain');
    expect(text.status).toBe(400);
    expect(text.body.error.code).toBe('INVALID_FILE_TYPE');

    const pdfAsLogo = await upload(s.accessToken, 'LOGO', Buffer.from('%PDF-1.7 ...'), 'logo.pdf', 'application/pdf');
    expect(pdfAsLogo.status).toBe(400);
    expect(pdfAsLogo.body.error.code).toBe('INVALID_FILE_TYPE');

    const fakePng = await upload(s.accessToken, 'LOGO', Buffer.from('<html><script>alert(1)</script></html>'), 'x.png', 'image/png');
    expect(fakePng.status).toBe(400);
    expect(fakePng.body.error.code).toBe('INVALID_FILE_TYPE');

    const badKind = await upload(s.accessToken, 'SELFIE', pngBytes());
    expect(badKind.status).toBe(400);
    expect(badKind.body.error.code).toBe('VALIDATION_ERROR');

    const none = await api().post('/api/v1/attachments').set(bearer(s.accessToken)).field('kind', 'LOGO');
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('FILE_REQUIRED');

    expect(await prismaAdmin.attachment.count()).toBe(0);
  });

  it('upload needs a login', async () => {
    const res = await api().post('/api/v1/attachments').field('kind', 'LOGO').attach('file', pngBytes(), 'a.png');
    expect(res.status).toBe(401);
  });
});
