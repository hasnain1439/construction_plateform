import type { Prisma, SubscriptionStatus, TenantStatus } from '../../generated/prisma/client.js';

/**
 * Subscription status → company (tenant) status.
 *   TRIAL / ACTIVE / GRACE → ACTIVE      LAPSED / CANCELLED → READ_ONLY
 * SUSPENDED and CLOSED are platform-admin decisions and are never overwritten here.
 */
export function tenantStatusFor(status: SubscriptionStatus): TenantStatus {
  return status === 'LAPSED' || status === 'CANCELLED' ? 'READ_ONLY' : 'ACTIVE';
}

/**
 * Brings Tenant.status in line with the subscription. Returns true when it changed.
 * Callers must call `invalidateTenantStatus(tenantId)` after their transaction commits.
 */
export async function syncTenantStatus(
  db: Pick<Prisma.TransactionClient, 'tenant'>,
  tenantId: string,
  status: SubscriptionStatus,
): Promise<boolean> {
  const target = tenantStatusFor(status);
  const result = await db.tenant.updateMany({
    where: { id: tenantId, status: { in: ['ACTIVE', 'READ_ONLY'] }, NOT: { status: target } },
    data: { status: target },
  });
  return result.count > 0;
}
