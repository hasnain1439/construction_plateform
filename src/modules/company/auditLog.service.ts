/**
 * The company's own audit log (owner only, `company.audit.view`): who changed what — including
 * every change a platform super admin made while working inside the company (actor
 * "Platform support · <admin>"). Older entries from the former support-session flow also carry
 * the session id and reason.
 */
import { getCtx } from '../../core/context/requestContext.js';
import { inSequence } from '../../core/db/inSequence.js';
import { withTenant } from '../../core/db/withTenant.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { scrub } from '../platform-admin/catalog.service.js';
import type { CompanyAuditEntryDto, CompanyAuditQuery } from './company.schema.js';

const DAY = 86_400_000;
const PLATFORM_SUPPORT = 'Platform support';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export async function listCompanyAuditLogs(query: CompanyAuditQuery) {
  const tenantId = getCtx().tenantId!;
  const where: Prisma.AuditLogWhereInput = {
    tenantId,
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(query.action ? { action: { startsWith: query.action } } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: dateOnly(query.from) } : {}),
            ...(query.to ? { lt: new Date(dateOnly(query.to).getTime() + DAY) } : {}),
          },
        }
      : {}),
  };
  return withTenant(tenantId, async (tx) => {
    const { skip, take } = skipTake(query);
    const [rows, total] = await inSequence([
      () => tx.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
      () => tx.auditLog.count({ where }),
    ]);
    const userIds = [...new Set(rows.filter((r) => r.actorType === 'USER' && r.actorId).map((r) => r.actorId!))];
    const users = userIds.length ? await tx.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    const data: CompanyAuditEntryDto[] = rows.map((r) => {
      const details = (r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? r.details : {}) as Record<string, unknown>;
      const support =
        r.actorType === 'PLATFORM_ADMIN'
          ? {
              sessionId: str(details['actAsSessionId']) ?? (r.entityType === 'ActAsSession' ? r.entityId : null),
              adminName: str(details['adminName']),
              reason: str(details['actAsReason']) ?? str(details['reason']),
            }
          : null;
      const name =
        r.actorType === 'USER'
          ? (nameOf.get(r.actorId ?? '') ?? 'Former user')
          : r.actorType === 'SYSTEM'
            ? 'System'
            : support?.adminName
              ? `${PLATFORM_SUPPORT} · ${support.adminName}`
              : PLATFORM_SUPPORT;
      return {
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        actor: { type: r.actorType, id: r.actorType === 'PLATFORM_ADMIN' ? null : r.actorId, name },
        platformSupport: support,
        details: scrub(r.details),
        createdAt: r.createdAt.toISOString(),
      };
    });
    return { data, meta: pageMeta(query, total) };
  });
}
