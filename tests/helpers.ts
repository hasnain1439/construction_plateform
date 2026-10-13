import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { testLogSink } from '../src/config/logger.js';
import { invalidateAccess } from '../src/core/auth/accessLoader.js';
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';
import { authenticate } from '../src/core/middleware/authenticate.js';
import { readOnlyGuard } from '../src/core/middleware/readOnlyGuard.js';
import { tenantContext } from '../src/core/middleware/tenantContext.js';
import { invalidateTenantStatus } from '../src/core/middleware/tenantContext.js';
import { clearSystemUserCache } from '../src/modules/auth/actAs.js';
import { lastSmsTo } from '../src/modules/auth/sms.provider.js';
import { clearDashboardCache } from '../src/modules/dashboard/dashboard.cache.js';
import { seed, SEED } from '../prisma/seed.js';
import { DEMO_SEEDS, parentOf, type DemoSeed } from './setup/demoSeeds.js';
import { assertTestDatabase, decodeValue, dropSnapshots, layerSchema, publicTables, readSnapshot, restoreSnapshot, SNAPSHOT, writeSnapshot } from './setup/seedSnapshot.js';

export { SEED };

/** App with one extra protected write route to exercise the standard middleware chain. */
export const app = createApp({
  extraRoutes: (api) => {
    api.post('/__test/write', authenticate, tenantContext, readOnlyGuard, (_req, res) => {
      res.status(201).json({ success: true, data: { written: true } });
    });
  },
});

export const api = () => request(app);

// ─── Database reset ─────────────────────────────────────────────────────────

// DATABASE_MIGRATION_URL = this worker's own database (tests/setup/workerDatabase.ts). Superuser.
let ownerPool: pg.Pool | undefined;
const owner = () => (ownerPool ??= new pg.Pool({ connectionString: process.env['DATABASE_MIGRATION_URL'], max: 2 }));
let tables: string[] | undefined;
let baseCreatedAt: string | undefined;

export type Seeded = Awaited<ReturnType<typeof seed>>;

async function allTables(): Promise<string[]> {
  assertTestDatabase();
  return (tables ??= await publicTables(owner()));
}

/** In-memory caches keyed by ids that restored rows reuse. */
function clearCaches() {
  invalidateTenantStatus();
  invalidateAccess();
  clearSystemUserCache();
  clearDashboardCache();
}

/**
 * Empties every table (as the schema owner) and re-seeds. Only ever on a *_test database.
 * Restores the seed snapshot (tests/setup/seedSnapshot.ts) — same rows and ids as running the
 * seed — and only seeds for real when the snapshot is missing or stale.
 */
export async function resetDatabase(): Promise<Seeded> {
  const all = await allTables();
  clearCaches();
  const snapshot = await readSnapshot(owner(), SNAPSHOT);
  if (snapshot) {
    await restoreSnapshot(owner(), snapshot, all);
    baseCreatedAt = snapshot.createdAt.toISOString();
    return decodeValue(snapshot.value) as Seeded;
  }
  await owner().query(`TRUNCATE ${all.join(', ')} CASCADE`);
  const seeded = await seed(prismaAdmin, { inventory: false, labor: false, billing: false });
  await dropSnapshots(owner(), 'layers'); // built on the old base
  baseCreatedAt = (await writeSnapshot(owner(), SNAPSHOT, seeded, null, all)).toISOString();
  return seeded;
}

/**
 * Loads a demo data set (tests/setup/demoSeeds.ts) on top of the base seed from its snapshot,
 * building it first if needed; returns the snapshot's createdAt. Call it right after
 * `useFreshDatabase()`'s reset — first thing in a `beforeEach` / test.
 */
export async function withSeedSnapshot(name: DemoSeed, s: Seeded): Promise<string> {
  if (!baseCreatedAt) throw new Error('withSeedSnapshot: call useFreshDatabase() first');
  const parent = parentOf(name);
  const snapshot = await readSnapshot(owner(), layerSchema(name));
  // Valid while built on the current base / parent snapshot (a rebuilt base drops every demo snapshot).
  const parentStamp = parent ? (await readSnapshot(owner(), layerSchema(parent)))?.createdAt.toISOString() : baseCreatedAt;
  if (snapshot && parentStamp && snapshot.base === parentStamp) {
    clearCaches();
    await restoreSnapshot(owner(), snapshot, await allTables());
    return snapshot.createdAt.toISOString();
  }
  const stamp = parent ? await withSeedSnapshot(parent, s) : baseCreatedAt;
  await DEMO_SEEDS[name].build(s);
  return (await writeSnapshot(owner(), layerSchema(name), null, stamp, await allTables())).toISOString();
}

/** Registers a fresh database for every test in the file. Returns a getter for the seed. */
export function useFreshDatabase(): () => Seeded {
  let seeded: Seeded | undefined;
  beforeEach(async () => {
    seeded = await resetDatabase();
  });
  afterAll(async () => {
    // Close this file's pools so connections don't pile up (each file has its own module graph).
    await ownerPool?.end().catch(() => undefined);
    ownerPool = undefined;
    await disconnectDatabases();
  });
  return () => {
    if (!seeded) throw new Error('database not seeded yet');
    return seeded;
  };
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

/** For 5xx answers: the server-side error behind it (last error log line), to make failures readable. */
function serverError(status: number): string {
  if (status < 500) return '';
  const line = [...testLogSink].reverse().find((l) => l.includes('"level":50'));
  if (!line) return '';
  const { err, msg } = JSON.parse(line) as { msg?: string; err?: { type?: string; code?: string; message?: string } };
  return ` — server: ${msg ?? ''} ${err?.type ?? ''} ${err?.code ?? ''} ${(err?.message ?? '').slice(0, 300)}`;
}

let deviceCounter = 0;
export function device(platform: 'ANDROID' | 'IOS' | 'WEB' = 'ANDROID') {
  deviceCounter += 1;
  return { deviceId: `test-device-${Date.now()}-${deviceCounter}`, platform, model: 'Test Phone', appVersion: '1.0.0' };
}

export interface MobileSession {
  accessToken: string;
  refreshToken: string;
  body: Record<string, any>;
  deviceId: string;
}

export async function loginMobile(login: string, password: string, tenantId?: string): Promise<MobileSession> {
  const dev = device();
  const res = await api()
    .post('/api/v1/auth/login')
    .send({ login, password, client: 'mobile', device: dev, ...(tenantId ? { tenantId } : {}) });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}${serverError(res.status)}`);
  return { accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, body: res.body, deviceId: dev.deviceId };
}

export async function refreshMobile(refreshToken: string) {
  return api().post('/api/v1/auth/refresh').send({ client: 'mobile', refreshToken });
}

/** Latest OTP code sent by SMS to `phone` (console provider outbox). */
export function lastOtp(phone: string): string {
  const sms = lastSmsTo(phone);
  const code = sms?.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no OTP sent to ${phone}`);
  return code;
}

/** Pretends the latest OTP for `phone` was sent long ago (skip the 60 s resend wait). */
export async function ageOtps(phone: string, seconds = 120) {
  await prismaAdmin.$executeRaw`
    UPDATE "OtpCode" SET "lastSentAt" = "lastSentAt" - make_interval(secs => ${seconds}),
                         "createdAt"  = "createdAt"  - make_interval(secs => ${seconds})
    WHERE phone = ${phone}`;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Munshi Rafaqat signs in with an SMS code for the given company (mobile tokens). */
export async function loginMunshi(tenantId: string): Promise<MobileSession> {
  const phone = SEED.malik.munshi.phone;
  await ageOtps(phone, 120);
  const req = await api().post('/api/v1/auth/otp/request').send({ phone });
  if (req.status !== 200) throw new Error(`otp request failed: ${req.status} ${JSON.stringify(req.body)}${serverError(req.status)}`);
  const dev = device();
  const res = await api()
    .post('/api/v1/auth/otp/verify')
    .send({ phone, code: lastOtp(phone), tenantId, client: 'mobile', device: dev });
  if (res.status !== 200) throw new Error(`otp verify failed: ${res.status} ${JSON.stringify(res.body)}${serverError(res.status)}`);
  return { accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, body: res.body, deviceId: dev.deviceId };
}

/** Bytes that pass the PNG signature check (content beyond the header is irrelevant here). */
export function pngBytes(size = 512): Buffer {
  const buf = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
}

export function upload(token: string, kind: string, file: Buffer, filename = 'logo.png', contentType = 'image/png') {
  return api().post('/api/v1/attachments').set(bearer(token)).field('kind', kind).attach('file', file, { filename, contentType });
}

/** Relative path + query of an absolute signed URL, for supertest. */
export const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/** Platform admin (seed) — mobile-style tokens. */
export async function loginAdmin(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await api()
    .post('/api/v1/admin/auth/login')
    .send({ email: SEED.admin.email, password: SEED.admin.password, client: 'mobile' });
  if (res.status !== 200) throw new Error(`admin login failed: ${res.status} ${JSON.stringify(res.body)}${serverError(res.status)}`);
  return { accessToken: res.body.data.accessToken, refreshToken: res.body.data.refreshToken };
}

/** Next receipt number expected for this year, given how many the seed already used. */
export function expectedReceipt(offset: number): string {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric' }).format(new Date());
  const seededMax = year === '2026' ? 381 : 0; // seed: RCPT-2026-0371, 0372, 0381
  return `RCPT-${year}-${String(seededMax + offset).padStart(4, '0')}`;
}

let projectCounter = 0;
/** Inserts a bare project row (default ACTIVE) straight into the database, for plan / lifecycle tests. */
export function projectRow(tenantId: string, name: string, data: { status?: 'DRAFT' | 'ACTIVE' | 'CLOSEOUT' | 'HANDED_OVER' | 'CLOSED' | 'READ_ONLY' } = {}) {
  projectCounter += 1;
  return prismaAdmin.project.create({
    data: { tenantId, name, code: `TST-${Date.now()}-${projectCounter}`, status: data.status ?? 'ACTIVE' },
  });
}

/** Gives a PM the old "canSeeFinancials" access (= the financial permission bundle as overrides). */
export async function grantFinancials(tenantId: string, userId: string) {
  const { setFinancialAccess } = await import('../src/modules/permissions/permissions.service.js');
  const { ownerAccess } = await import('../src/core/auth/access.js');
  await prismaAdmin.$transaction((tx) => setFinancialAccess(tx, { tenantId, userId, access: ownerAccess() }, userId, true));
}
