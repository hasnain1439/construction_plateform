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
  // A platform super admin acting inside a company: the row names the real admin, not the
  // company's system user the change was made with.
  const admin = ctx?.platformAdminId && entry.actorType === 'USER' ? ctx.platformAdminId : null;
  const details: Prisma.InputJsonValue | undefined = admin
    ? {
        ...(entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details) ? (entry.details as Prisma.InputJsonObject) : entry.details === undefined ? {} : { value: entry.details }),
        actingAsCompany: true,
      }
    : entry.details;
  await db.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      actorType: admin ? 'PLATFORM_ADMIN' : entry.actorType,
      actorId: admin ?? entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ...(details === undefined ? {} : { details }),
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      requestId: ctx?.requestId ?? null,
    },
  });
}
