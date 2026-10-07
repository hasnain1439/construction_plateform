/**
 * "📱 late sync": an entry made on a phone that reached the server more than 48 h later.
 * Tables with their own `deviceCreatedAt` use `isLateSync` directly; receipts (dispatch /
 * purchase receive, site purchases) are looked up in the push log (SyncIdMap).
 */
import type { Tx } from '../../core/db/withTenant.js';

/** Synced later than this after it was written on the phone → late. */
export const LATE_SYNC_MS = 48 * 3_600_000;

export const isLateSync = (deviceCreatedAt: Date | null | undefined, receivedAt: Date) => Boolean(deviceCreatedAt && receivedAt.getTime() - deviceCreatedAt.getTime() > LATE_SYNC_MS);

export const RECEIPT_MUTATIONS = ['DISPATCH_RECEIVE', 'PURCHASE_RECEIVE', 'SITE_PURCHASE_CREATE'];

/** Server ids among `serverIds` whose phone mutation (of these types) arrived late. */
export async function lateSyncedIds(tx: Tx, tenantId: string, serverIds: string[], entities: string[] = RECEIPT_MUTATIONS): Promise<Set<string>> {
  if (!serverIds.length) return new Set();
  const rows = await tx.syncIdMap.findMany({
    where: { tenantId, entity: { in: entities }, status: 'APPLIED', serverId: { in: serverIds }, deviceCreatedAt: { not: null } },
    select: { serverId: true, deviceCreatedAt: true, createdAt: true },
  });
  return new Set(rows.filter((r) => isLateSync(r.deviceCreatedAt, r.createdAt)).map((r) => r.serverId!));
}
