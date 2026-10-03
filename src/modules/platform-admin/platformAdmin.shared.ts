import { logger } from '../../config/logger.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { maskPhone } from '../../core/utils/phone.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { smsProvider } from '../auth/sms.provider.js';

type Tx = Prisma.TransactionClient;

/** The signed-in platform admin's id (from the platform token). */
export function adminId(): string {
  return getCtx().userId!;
}

/** Audit row for a platform-admin action (tenantId = the company affected, if any). */
export async function auditAdmin(
  tx: Tx,
  entry: { tenantId?: string | null; action: string; entityType?: string; entityId?: string; details?: Prisma.InputJsonValue },
): Promise<void> {
  await writeAudit(tx, {
    tenantId: entry.tenantId ?? null,
    actorType: 'PLATFORM_ADMIN',
    actorId: adminId(),
    action: entry.action,
    ...(entry.entityType ? { entityType: entry.entityType } : {}),
    ...(entry.entityId ? { entityId: entry.entityId } : {}),
    ...(entry.details === undefined ? {} : { details: entry.details }),
  });
}

/**
 * Next receipt number for the year of `now` (Pakistan time): RCPT-YYYY-NNNN.
 * Runs inside the approving transaction under a global advisory lock, so numbers are
 * sequential and gap-free (a rolled-back approval releases its number).
 */
export async function nextReceiptNo(tx: Tx, now = new Date()): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('receipt-numbers'))`;
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric' }).format(now);
  const prefix = `RCPT-${year}-`;
  const rows = await tx.$queryRaw<Array<{ max: number | null }>>`
    SELECT max(split_part("receiptNo", '-', 3)::int) AS max
    FROM "SubscriptionPayment"
    WHERE "receiptNo" LIKE ${`${prefix}%`}`;
  const next = (rows[0]?.max ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

/** Best-effort SMS to every active THEKEDAR of a company (never fails the request). */
export async function smsOwners(tx: Tx, tenantId: string, body: string): Promise<void> {
  const owners = await tx.user.findMany({ where: { tenantId, role: 'THEKEDAR', status: 'ACTIVE' }, select: { phone: true } });
  await Promise.all(
    owners.map((o) =>
      smsProvider()
        .send({ to: o.phone, body })
        .catch((err: unknown) => logger.error({ err, phone: maskPhone(o.phone) }, 'admin sms failed')),
    ),
  );
}
