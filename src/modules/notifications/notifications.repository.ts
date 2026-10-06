import type { Tx } from '../../core/db/withTenant.js';
import type { NotificationType, Prisma } from '../../generated/prisma/client.js';

const projectRef = { select: { id: true, code: true, name: true } } as const;

export function listNotifications(tx: Tx, where: Prisma.NotificationWhereInput, skip: number, take: number) {
  return tx.notification.findMany({ where, include: { project: projectRef }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take });
}

export function countNotifications(tx: Tx, where: Prisma.NotificationWhereInput) {
  return tx.notification.count({ where });
}

/** Users who already got this (type, ref) since `since` — the 24 h dedupe. */
export async function alreadyNotified(tx: Tx, tenantId: string, type: NotificationType, refId: string, userIds: string[], since: Date): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await tx.notification.findMany({ where: { tenantId, type, refId, userId: { in: userIds }, createdAt: { gte: since } }, select: { userId: true } });
  return new Set(rows.map((r) => r.userId));
}

export function activeUsers(tx: Tx, where: Prisma.UserWhereInput) {
  return tx.user.findMany({ where: { ...where, status: 'ACTIVE' }, select: { id: true, role: true, phone: true, canSeeFinancials: true } });
}
