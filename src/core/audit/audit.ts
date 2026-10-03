import type { ActorType, Prisma } from '../../generated/prisma/client.js';
import { tryGetCtx } from '../context/requestContext.js';

export interface AuditEntry {
  tenantId: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  /** Never put passwords, tokens or OTP codes here. */
  details?: Prisma.InputJsonValue;
}

type AuditDb = Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * Writes an AuditLog row with ip / user agent / request id taken from the request
 * context. Pass the same transaction client as the change being audited so both
 * commit or roll back together (tenant rows need a `withTenant` tx for RLS).
 */
export async function writeAudit(db: AuditDb, entry: AuditEntry): Promise<void> {
  const ctx = tryGetCtx();
  await db.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ...(entry.details === undefined ? {} : { details: entry.details }),
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      requestId: ctx?.requestId ?? null,
    },
  });
}
