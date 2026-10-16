import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { isS3Key, parseS3Key, S3StorageProvider, type S3Config } from '../../src/modules/attachments/s3.provider.js';
import { storage, storageForKey, useStorageProviderForTests } from '../../src/modules/attachments/storage.provider.js';
import { canonicalKeyFor, migrateStorage, sourceReader } from '../../scripts/migrate-storage.js';
import { api, bearer, loginMobile, pngBytes, SEED, upload, useFreshDatabase } from '../helpers.js';

/**
 * S3 calls (put / head / delete) are mocked with aws-sdk-client-mock; presigning is the real,
 * offline SDK code, so the URLs checked here are what production hands out.
 */
const s3 = mockClient(S3Client);
const seeded = useFreshDatabase();

const TENANT = '0199a8c0-0000-7000-8000-0000000000aa';
const ID = '0199a8c0-0000-7000-8000-00000000c001';
const KEY = `${TENANT}/2026/10/${ID}.png`;
const aws: S3Config = { bucket: 'munshi-files', region: 'me-central-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secret' };
const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

beforeEach(() => {
  s3.reset();
  s3.on(PutObjectCommand).resolves({ ETag: '"etag"' });
  s3.on(DeleteObjectCommand).resolves({});
  s3.on(HeadObjectCommand).rejects(notFound());
});
afterEach(() => useStorageProviderForTests(undefined));

describe('S3StorageProvider (mocked SDK)', () => {
  it('put: private object with AES256 server-side encryption, content type; returns s3:<canonical key>', async () => {
    const key = await new S3StorageProvider(aws).put(KEY, pngBytes(300), 'image/png');
    expect(key).toBe(`s3:${KEY}`);
    expect(isS3Key(key)).toBe(true);
    expect(parseS3Key(key)).toBe(KEY);
    const input = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Bucket: 'munshi-files', Key: KEY, ContentType: 'image/png', ContentLength: 300, ServerSideEncryption: 'AES256' });
    expect(input).not.toHaveProperty('ACL');
  });

  it('S3_SERVER_SIDE_ENCRYPTION=none leaves the header out; bad keys are refused', async () => {
    await new S3StorageProvider({ ...aws, serverSideEncryption: 'none' }).put(KEY, pngBytes(), 'image/png');
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input.ServerSideEncryption).toBeUndefined();
    await expect(new S3StorageProvider(aws).put('../etc/passwd', pngBytes(), 'image/png')).rejects.toThrow('Invalid storage key');
    expect(() => parseS3Key(`s3:../${KEY}`)).toThrow('Invalid S3 storage key');
  });

  it('presigned GET URL expires after the TTL (AWS virtual-hosted style)', async () => {
    const before = Date.now();
    const { url, expiresAt } = await new S3StorageProvider(aws).getSignedUrl(`s3:${KEY}`, 600);
    const u = new URL(url);
    expect(u.host).toBe('munshi-files.s3.me-central-1.amazonaws.com');
    expect(u.pathname).toBe(`/${KEY}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('X-Amz-Credential')).toContain('AKIATEST/');
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
  });

  it('Cloudflare R2 / MinIO: custom endpoint with path-style URLs', async () => {
    const r2 = new S3StorageProvider({ ...aws, region: 'auto', endpoint: 'https://acc123.r2.cloudflarestorage.com', forcePathStyle: true });
    const u = new URL((await r2.getSignedUrl(`s3:${KEY}`, 120)).url);
    expect(u.host).toBe('acc123.r2.cloudflarestorage.com');
    expect(u.pathname).toBe(`/munshi-files/${KEY}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('120');
  });

  it('delete and exists', async () => {
    const p = new S3StorageProvider(aws);
    await p.delete(`s3:${KEY}`);
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'munshi-files', Key: KEY });
    expect(await p.exists(`s3:${KEY}`)).toBe(false);
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3 });
    expect(await p.exists(`s3:${KEY}`)).toBe(true);
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }));
    await expect(p.exists(`s3:${KEY}`)).rejects.toThrow('AccessDenied');
    await expect(p.open()).rejects.toThrow('does not stream');
  });

  it('s3: keys route to the S3 provider', () => {
    const p = new S3StorageProvider(aws);
    useStorageProviderForTests(p);
    expect(storage()).toBe(p);
    expect(storageForKey(`s3:${KEY}`)).toBe(p);
  });
});

describe('attachments API with S3 (mocked SDK)', () => {
  it('upload stores s3:<key> and returns a presigned S3 URL', async () => {
    useStorageProviderForTests(new S3StorageProvider(aws));
    const s = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const res = await upload(s.accessToken, 'LOGO', pngBytes(), 'logo.png');
    expect(res.status).toBe(201);
    const row = await prismaAdmin.attachment.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.storageKey).toMatch(new RegExp(`^s3:${seeded().malik.id}/\\d{4}/\\d{2}/${row.id}\\.png$`));
    expect(new URL(res.body.data.url).host).toBe('munshi-files.s3.me-central-1.amazonaws.com');
    const meta = await api().get(`/api/v1/attachments/${row.id}`).set(bearer(s.accessToken));
    expect(new URL(meta.body.data.url).searchParams.get('X-Amz-Expires')).toBe('600');
  });
});

describe('npm run storage:migrate (local → s3)', () => {
  // The base seed has two site photos (Step 13 stoppage days); these tests count only their own files.
  beforeEach(async () => {
    await prismaAdmin.attachment.deleteMany({});
  });

  it('copies local files, updates the keys, and is idempotent', async () => {
    const s = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const a = await upload(s.accessToken, 'LOGO', pngBytes(400), 'a.png');
    const b = await upload(s.accessToken, 'SITE_PHOTO', pngBytes(500), 'b.png');
    const ids = [a.body.data.id as string, b.body.data.id as string];
    const before = await prismaAdmin.attachment.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const target = new S3StorageProvider(aws);
    const lines: string[] = [];
    const deps = { target, read: sourceReader('local'), log: (l: string) => lines.push(l) };

    // Dry run: nothing written, nothing changed.
    const dry = await migrateStorage({ from: 'local', to: 's3', dryRun: true }, deps);
    expect(dry).toMatchObject({ scanned: 2, copied: 0, updated: 0 });
    expect(lines.filter((l) => l.startsWith('[dry-run]'))).toHaveLength(2);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);

    const run = await migrateStorage({ from: 'local', to: 's3' }, deps);
    expect(run).toMatchObject({ scanned: 2, copied: 2, alreadyInTarget: 0, updated: 2, failed: [] });
    const puts = s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
    expect(puts.map((p) => [p.Key, (p.Body as Buffer).length, p.ServerSideEncryption]).sort()).toEqual(
      before.map((r) => [r.storageKey, r.sizeBytes, 'AES256']).sort(),
    );
    const after = await prismaAdmin.attachment.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    expect(after.map((r) => r.storageKey)).toEqual(before.map((r) => `s3:${r.storageKey}`));

    // Second run: nothing left to move.
    expect(await migrateStorage({ from: 'local', to: 's3' }, deps)).toMatchObject({ scanned: 0, copied: 0, updated: 0 });
  });

  it('an object already in the bucket is not uploaded again; a missing source file is reported and left as is', async () => {
    const s = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    const a = await upload(s.accessToken, 'LOGO', pngBytes(), 'a.png');
    const ghost = await prismaAdmin.attachment.create({
      data: { tenantId: seeded().malik.id, kind: 'DOCUMENT', storageKey: `${seeded().malik.id}/2026/01/0199a8c0-0000-7000-8000-00000000dead.pdf`, fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 1 },
    });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 512 });
    const result = await migrateStorage({ from: 'local', to: 's3' }, { target: new S3StorageProvider(aws), read: sourceReader('local'), log: () => undefined });
    // Both objects "exist" in the bucket, so no upload and both rows move.
    expect(result).toMatchObject({ scanned: 2, copied: 0, alreadyInTarget: 2, updated: 2 });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect((await prismaAdmin.attachment.findUniqueOrThrow({ where: { id: a.body.data.id } })).storageKey).toMatch(/^s3:/);

    // Not in the bucket and not on disk → failed, row untouched.
    await prismaAdmin.attachment.update({ where: { id: ghost.id }, data: { storageKey: ghost.storageKey } });
    s3.on(HeadObjectCommand).rejects(notFound());
    const again = await migrateStorage({ from: 'local', to: 's3' }, { target: new S3StorageProvider(aws), read: sourceReader('local'), log: () => undefined });
    expect(again.failed.map((f) => f.id)).toEqual([ghost.id]);
    expect((await prismaAdmin.attachment.findUniqueOrThrow({ where: { id: ghost.id } })).storageKey).toBe(ghost.storageKey);
  });

  it('Cloudinary keys map to the canonical key (extension from the public id or the MIME type)', () => {
    const base = { id: ID, tenantId: TENANT, createdAt: new Date() };
    expect(canonicalKeyFor({ ...base, storageKey: `cloudinary:image:construction/${TENANT}/2026/10/${ID}`, mimeType: 'image/jpeg' })).toBe(`${TENANT}/2026/10/${ID}.jpg`);
    expect(canonicalKeyFor({ ...base, storageKey: `cloudinary:raw:construction/${TENANT}/2026/10/${ID}.pdf`, mimeType: 'application/pdf' })).toBe(`${TENANT}/2026/10/${ID}.pdf`);
    expect(canonicalKeyFor({ ...base, storageKey: KEY, mimeType: 'image/png' })).toBe(KEY);
  });
});
