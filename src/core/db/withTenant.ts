import { env } from '../../config/env.js';
import { prisma, type Prisma } from './prisma.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Prisma.TransactionClient;

/**
 * Runs `fn` in a transaction whose PostgreSQL session has `app.tenant_id` set, so
 * row-level security limits every query to that tenant. The setting is
 * transaction-local (`is_local = true`) and disappears on commit/rollback, so a
 * pooled connection never carries one tenant's context into another request.
 *
 * All tenant-scoped reads and writes go through this function.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('withTenant: tenantId must be a UUID');
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { maxWait: env.DB_TX_MAX_WAIT_MS, timeout: options?.timeout ?? 10_000 },
  );
}
