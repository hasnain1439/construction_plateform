import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Cloudinary SDK's network calls (upload, destroy) are mocked: tests never reach
 * Cloudinary. URL building (`url`, `utils.private_download_url`) is the real, offline SDK
 * code, so the signed URLs checked below are exactly what production produces.
 */
const calls = vi.hoisted(() => ({
  uploads: [] as Array<{ options: Record<string, unknown>; bytes: number }>,
  destroys: [] as Array<{ publicId: string; options: Record<string, unknown> }>,
}));

vi.mock('cloudinary', async (importOriginal) => {
  const mod = await importOriginal<typeof import('cloudinary')>();
  mod.v2.uploader.upload_stream = vi.fn((options: Record<string, unknown>, callback: (err: unknown, res?: unknown) => void) => ({
    end: (buffer: Buffer) => {
      calls.uploads.push({ options, bytes: buffer.length });
      callback(undefined, { public_id: `${options['folder']}/${options['public_id']}`, resource_type: options['resource_type'], type: options['type'] });
    },
  })) as unknown as typeof mod.v2.uploader.upload_stream;
  mod.v2.uploader.destroy = vi.fn(async (publicId: string, options: Record<string, unknown>) => {
    calls.destroys.push({ publicId, options });
    return { result: 'ok' };
  }) as unknown as typeof mod.v2.uploader.destroy;
  return mod;
});

const { envSchema } = await import('../src/config/env.js');
const { CloudinaryStorageProvider, parseCloudinaryKey, resourceTypeFor } = await import('../src/modules/attachments/cloudinary.provider.js');
const { storage, storageForKey, useStorageProviderForTests } = await import('../src/modules/attachments/storage.provider.js');
const { prismaAdmin } = await import('../src/core/db/prisma.js');
const { api, bearer, loginMobile, pngBytes, SEED, upload, useFreshDatabase } = await import('./helpers.js');

const seeded = useFreshDatabase();
const TENANT = '0199a8c0-0000-7000-8000-0000000000aa';
const ID = '0199a8c0-0000-7000-8000-00000000c001';
const config = { cloudName: 'demo-cloud', apiKey: '123456789', apiSecret: 'shhh-secret' };
const provider = () => new CloudinaryStorageProvider(config);
const nowSec = () => Math.floor(Date.now() / 1000);

afterEach(() => {
  calls.uploads.length = 0;
  calls.destroys.length = 0;
  useStorageProviderForTests(undefined);
});

describe('CloudinaryStorageProvider (mocked SDK)', () => {
  it('uploads as an authenticated asset in construction/{tenantId}/{yyyy}/{mm} with public_id = attachment id', async () => {
    const key = await provider().put(`${TENANT}/2026/10/${ID}.png`, pngBytes(300), 'image/png');
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]!.options).toMatchObject({
      type: 'authenticated',
      folder: `construction/${TENANT}/2026/10`,
      public_id: ID,
      resource_type: 'image',
      overwrite: false,
    });
    expect(calls.uploads[0]!.bytes).toBe(300);
    expect(key).toBe(`cloudinary:image:construction/${TENANT}/2026/10/${ID}`);
    expect(parseCloudinaryKey(key)).toEqual({ resourceType: 'image', publicId: `construction/${TENANT}/2026/10/${ID}` });
  });

  it('never uploads publicly; resource_type: image / video (audio) / raw (PDF)', async () => {
    const p = provider();
    await p.put(`${TENANT}/2026/10/${ID}.ogg`, Buffer.from('OggS'), 'audio/ogg');
    await p.put(`${TENANT}/2026/10/${ID}.pdf`, Buffer.from('%PDF-'), 'application/pdf');
    expect(calls.uploads.map((u) => u.options['resource_type'])).toEqual(['video', 'raw']);
    // Raw files keep their extension (the download opens in the right app); media do not.
    expect(calls.uploads.map((u) => u.options['public_id'])).toEqual([ID, `${ID}.pdf`]);
    expect(parseCloudinaryKey(`cloudinary:raw:construction/${TENANT}/2026/10/${ID}.xlsx`).publicId).toBe(`construction/${TENANT}/2026/10/${ID}.xlsx`);
    expect(calls.uploads.every((u) => u.options['type'] === 'authenticated')).toBe(true);
    expect(resourceTypeFor('image/webp')).toBe('image');
    expect(resourceTypeFor('audio/mpeg')).toBe('video');
    expect(resourceTypeFor('application/pdf')).toBe('raw');
  });

  it('rejects keys it did not generate', async () => {
    await expect(provider().put('../../etc/passwd', Buffer.from('x'), 'image/png')).rejects.toThrow(/Invalid storage key/);
    expect(() => parseCloudinaryKey('cloudinary:image:../other-tenant/x')).toThrow();
  });

  it('signed URL for the original is a private download URL that expires in 10 minutes', async () => {
    const key = `cloudinary:raw:construction/${TENANT}/2026/10/${ID}`;
    const before = nowSec();
    const { url, expiresAt } = await provider().getSignedUrl(key, 600);
    const u = new URL(url);
    expect(u.host).toBe('api.cloudinary.com');
    expect(u.pathname).toBe('/v1_1/demo-cloud/raw/download');
    expect(u.searchParams.get('type')).toBe('authenticated');
    expect(u.searchParams.get('public_id')).toBe(`construction/${TENANT}/2026/10/${ID}`);
    expect(u.searchParams.get('signature')).toMatch(/^[0-9a-f]{40}$/);
    expect(u.searchParams.get('api_secret')).toBeNull();
    const exp = Number(u.searchParams.get('expires_at'));
    expect(exp).toBeGreaterThanOrEqual(before + 600);
    expect(exp).toBeLessThanOrEqual(nowSec() + 600);
    expect(Math.floor(expiresAt.getTime() / 1000)).toBe(exp);
  });

  it('image thumbnail: resized, auto quality/format and expiring when a token key is configured', async () => {
    const key = `cloudinary:image:construction/${TENANT}/2026/10/${ID}`;
    const p = new CloudinaryStorageProvider({ ...config, authTokenKey: 'a1b2c3d4e5f6' });
    const { url } = await p.getSignedUrl(key, 600, { thumbnailWidth: 400 });
    const u = new URL(url);
    expect(u.host).toBe('res.cloudinary.com');
    expect(u.pathname).toContain('/image/authenticated/');
    expect(u.pathname).toMatch(/c_limit,f_auto,q_auto,w_400/);
    const token = u.searchParams.get('__cld_token__')!;
    const exp = Number(/exp=(\d+)/.exec(token)![1]);
    // The SDK stamps the token with its own clock (±1 s).
    expect(exp).toBeGreaterThanOrEqual(nowSec() + 599);
    expect(exp).toBeLessThanOrEqual(nowSec() + 601);
  });

  it('without a token key a thumbnail request falls back to the expiring original (never a non-expiring URL)', async () => {
    const key = `cloudinary:image:construction/${TENANT}/2026/10/${ID}`;
    const { url } = await provider().getSignedUrl(key, 600, { thumbnailWidth: 400 });
    expect(new URL(url).searchParams.get('expires_at')).not.toBeNull();
    // Non-images ignore the thumbnail option
    const pdf = await provider().getSignedUrl(`cloudinary:raw:construction/${TENANT}/2026/10/${ID}`, 600, { thumbnailWidth: 400 });
    expect(new URL(pdf.url).pathname).toContain('/raw/download');
  });

  it('delete destroys the authenticated asset with the right resource type', async () => {
    await provider().delete(`cloudinary:video:construction/${TENANT}/2026/10/${ID}`);
    expect(calls.destroys).toEqual([
      { publicId: `construction/${TENANT}/2026/10/${ID}`, options: { resource_type: 'video', type: 'authenticated', invalidate: true } },
    ]);
  });
});

describe('provider selection', () => {
  it('local stays the default; existing keys are served by the provider that stored them', () => {
    expect(storage().name).toBe('local');
    expect(storageForKey(`${TENANT}/2026/10/${ID}.png`).name).toBe('local');
    useStorageProviderForTests(provider());
    expect(storageForKey(`cloudinary:image:construction/${TENANT}/2026/10/${ID}`).name).toBe('cloudinary');
  });

  it('env: Cloudinary credentials are required only when STORAGE_PROVIDER=cloudinary', () => {
    const base = {
      DATABASE_URL: 'postgresql://a',
      DATABASE_ADMIN_URL: 'postgresql://b',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      JWT_REFRESH_PEPPER: 'y'.repeat(32),
    };
    expect(envSchema.safeParse(base).success).toBe(true);
    const missing = envSchema.safeParse({ ...base, STORAGE_PROVIDER: 'cloudinary' });
    expect(missing.success).toBe(false);
    expect(missing.error!.issues.map((i) => i.path[0]).sort()).toEqual(['CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_CLOUD_NAME']);
    const ok = envSchema.safeParse({ ...base, STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' });
    expect(ok.success).toBe(true);
  });
});

describe('attachments API with Cloudinary (mocked SDK)', () => {
  it('upload stores the Cloudinary key and returns a signed, expiring Cloudinary URL', async () => {
    useStorageProviderForTests(provider());
    const s = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const res = await upload(s.accessToken, 'LOGO', pngBytes(), 'logo.png');
    expect(res.status).toBe(201);

    const row = await prismaAdmin.attachment.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.storageKey).toMatch(new RegExp(`^cloudinary:image:construction/${seeded().malik.id}/\\d{4}/\\d{2}/${row.id}$`));
    expect(calls.uploads[0]!.options).toMatchObject({ type: 'authenticated', public_id: row.id });

    const url = new URL(res.body.data.url);
    expect(url.host).toBe('api.cloudinary.com');
    expect(Number(url.searchParams.get('expires_at'))).toBeGreaterThan(nowSec());

    const meta = await api().get(`/api/v1/attachments/${row.id}`).set(bearer(s.accessToken));
    expect(new URL(meta.body.data.url).host).toBe('api.cloudinary.com');
  });
});
