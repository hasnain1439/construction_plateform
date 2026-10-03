import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';

export { Prisma } from '../../generated/prisma/client.js';
export type { PrismaClient } from '../../generated/prisma/client.js';

function createClient(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Connects as app_user. Row-level security applies, so every tenant query must run
 * inside `withTenant()` — outside of it, tenant tables return no rows.
 */
export const prisma = createClient(env.DATABASE_URL);

/**
 * ⚠️  Connects as app_admin (BYPASSRLS) — sees every tenant's data.
 *
 * Allowed ONLY in:
 *   - src/modules/auth/**           (cross-tenant lookups: login by phone/email, OTP, invitations by token)
 *   - src/modules/platform-admin/** (platform owners)
 *   - prisma/seed.ts, scripts/**, tests/**
 *
 * Enforced by tests/guards/prismaAdminImports.test.ts. Business modules must use
 * `withTenant()` instead.
 */
export const prismaAdmin = createClient(env.DATABASE_ADMIN_URL);

export async function disconnectDatabases(): Promise<void> {
  await Promise.all([prisma.$disconnect(), prismaAdmin.$disconnect()]);
}
