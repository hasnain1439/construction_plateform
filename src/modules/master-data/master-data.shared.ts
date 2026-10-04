import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { Conflict } from '../../core/errors/AppError.js';

export function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId!, role: ctx.role };
}

/** Audit row for a company user's master-data change. */
export function audit(tx: Tx, action: string, entityType: string, entityId: string, details?: Prisma.InputJsonValue) {
  const { tenantId, userId } = current();
  return writeAudit(tx, { tenantId, actorType: 'USER', actorId: userId, action, entityType, entityId, ...(details === undefined ? {} : { details }) });
}

/** Maps a unique-constraint violation to a 409 with `code`; rethrows anything else. */
export function conflictOn(code: string, message: string) {
  return (err: unknown): never => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new Conflict(code, message);
    throw err;
  };
}

export const paisa = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
export const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
