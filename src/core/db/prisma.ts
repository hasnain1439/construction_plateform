import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';

export { Prisma } from '../../generated/prisma/client.js';
export type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * A pg connection that sends its queries strictly one after another.
 *
 * Prisma 7's query interpreter loads an `include` with several relations by starting the
 * child queries together (`Promise.all`). Inside an interactive transaction they all hit the
 * transaction's single connection, so pg logs "Calling client.query() when the client is
 * already executing a query is deprecated" (pg 9 will reject it). Waiting for the previous
 * query to settle before sending the next one gives the same result — one connection runs one
 * query at a time anyway — without the warning. Callback-style and Submittable calls (only
 * pg-pool's own `pool.query`, which owns the connection for that one query) pass through.
 */
export class SerialPgClient extends pg.Client {
  #tail: Promise<unknown> = Promise.resolve();

  constructor(config?: string | pg.ClientConfig) {
    super(config);
    const send = super.query.bind(this) as (...args: unknown[]) => unknown;
    const serial = (...args: unknown[]) => {
      const first = args[0] as { submit?: unknown } | undefined;
      if (typeof args[args.length - 1] === 'function' || typeof first?.submit === 'function') return send(...args);
      const run = () => send(...args) as Promise<unknown>;
      const result = this.#tail.then(run, run);
      this.#tail = result.catch(() => undefined);
      return result;
    };
    this.query = serial as typeof this.query;
  }
}

function createClient(connectionString: string) {
  const adapter = new PrismaPg({
    connectionString,
    Client: SerialPgClient,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: env.DB_TX_MAX_WAIT_MS,
  });
  // Prisma's default maxWait is 2 s: one page load's burst of parallel requests could
  // exhaust it and fail with "Unable to start a transaction in the given time".
  return new PrismaClient({ adapter, transactionOptions: { maxWait: env.DB_TX_MAX_WAIT_MS, timeout: 10_000 } });
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
 *   - src/jobs/**                   (cross-tenant background jobs, e.g. subscription lifecycle)
 *   - prisma/seed.ts, scripts/**, tests/**
 *
 * Enforced by tests/guards/prismaAdminImports.test.ts. Business modules must use
 * `withTenant()` instead.
 */
export const prismaAdmin = createClient(env.DATABASE_ADMIN_URL);

export async function disconnectDatabases(): Promise<void> {
  await Promise.all([prisma.$disconnect(), prismaAdmin.$disconnect()]);
}
