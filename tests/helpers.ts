import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';
import { authenticate } from '../src/core/middleware/authenticate.js';
import { readOnlyGuard } from '../src/core/middleware/readOnlyGuard.js';
import { tenantContext } from '../src/core/middleware/tenantContext.js';
import { invalidateTenantStatus } from '../src/core/middleware/tenantContext.js';
import { lastSmsTo } from '../src/modules/auth/sms.provider.js';
import { seed, SEED } from '../prisma/seed.js';

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

const owner = new pg.Pool({ connectionString: process.env['DATABASE_MIGRATION_URL'], max: 2 });
let tables: string[] | undefined;

export type Seeded = Awaited<ReturnType<typeof seed>>;

/** Empties every table (as the schema owner) and re-seeds. Only ever on a *_test database. */
export async function resetDatabase(): Promise<Seeded> {
  if (!new URL(process.env['DATABASE_MIGRATION_URL'] ?? '').pathname.endsWith('_test')) {
    throw new Error('resetDatabase() only runs against a database whose name ends with _test');
  }
  if (!tables) {
    const { rows } = await owner.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    tables = rows.map((r) => `"${r.tablename}"`);
  }
  await owner.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
  invalidateTenantStatus();
  return seed(prismaAdmin);
}

/** Registers a fresh database for every test in the file. Returns a getter for the seed. */
export function useFreshDatabase(): () => Seeded {
  let seeded: Seeded | undefined;
  beforeEach(async () => {
    seeded = await resetDatabase();
  });
  afterAll(async () => {
    // Each test file gets its own module graph; close its pools so connections don't pile up.
    await owner.end().catch(() => undefined);
    await disconnectDatabases();
  });
  return () => {
    if (!seeded) throw new Error('database not seeded yet');
    return seeded;
  };
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

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
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
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
  if (req.status !== 200) throw new Error(`otp request failed: ${req.status} ${JSON.stringify(req.body)}`);
  const dev = device();
  const res = await api()
    .post('/api/v1/auth/otp/verify')
    .send({ phone, code: lastOtp(phone), tenantId, client: 'mobile', device: dev });
  if (res.status !== 200) throw new Error(`otp verify failed: ${res.status} ${JSON.stringify(res.body)}`);
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
