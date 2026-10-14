import type { RequestHandler } from 'express';
import type { TenantStatus } from '../../generated/prisma/enums.js';
import { getCtx } from '../context/requestContext.js';
import { withTenant, type Tx } from '../db/withTenant.js';
import { Forbidden, Unauthorized } from '../errors/AppError.js';
import { cachedAccess } from '../auth/accessLoader.js';
import type { CompanyRole } from '../auth/access.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { status: TenantStatus; expiresAt: number }>();

async function tenantStatus(tx: Tx, tenantId: string): Promise<TenantStatus | null> {
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.status;
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  if (!tenant) return null;
  cache.set(tenantId, { status: tenant.status, expiresAt: Date.now() + CACHE_TTL_MS });
  return tenant.status;
}

/** Call after changing a tenant's status so the change applies immediately. */
export function invalidateTenantStatus(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

interface SessionState {
  user_status: string;
  user_role: CompanyRole;
  role_id: string | null;
  perm_version: number;
  role_version: string | null;
  can_see_financials: boolean;
  device_revoked: boolean;
  family_active: boolean;
}

/**
 * Is the login behind this access token still alive? One indexed query:
 * - the user is ACTIVE (deactivation cuts access at once),
 * - the device isn't revoked (lost / stolen phone),
 * - the refresh-token family still has a live session. Normal rotation keeps the family
 *   alive, so an access token issued just before a refresh keeps working; logout,
 *   logout-all, password change/reset and reuse detection end the family.
 */
async function sessionState(tx: Tx, sessionId: string): Promise<SessionState | null> {
  const rows = await tx.$queryRaw<SessionState[]>`
    SELECT u.status::text AS user_status,
           u.role::text AS user_role,
           u."roleId" AS role_id,
           u."permVersion" AS perm_version,
           COALESCE(
             (SELECT string_agg(ar.id::text || ':' || ar.version::text, ',' ORDER BY ar.id)
                FROM "UserRoleAssignment" a JOIN "Role" ar ON ar.id = a."roleId"
               WHERE a."userId" = u.id),
             r.version::text
           ) AS role_version,
           u."canSeeFinancials" AS can_see_financials,
           (d."revokedAt" IS NOT NULL) AS device_revoked,
           EXISTS (
             SELECT 1 FROM "Session" f
             WHERE f."familyId" = s."familyId" AND f."revokedAt" IS NULL AND f."expiresAt" > now()
           ) AS family_active
    FROM "Session" s
    JOIN "User" u ON u.id = s."userId"
    JOIN "Device" d ON d.id = s."deviceId"
    LEFT JOIN "Role" r ON r.id = u."roleId"
    WHERE s.id = ${sessionId}::uuid`;
  return rows[0] ?? null;
}

/**
 * For company tokens: verifies the login is still alive (see sessionState), blocks
 * SUSPENDED/CLOSED companies (403) and flags READ_ONLY ones for readOnlyGuard.
 * Tenant status is cached for 60 s; the session check is never cached.
 */
export const tenantContext: RequestHandler = async (_req, _res, next) => {
  const ctx = getCtx();
  if (ctx.actorType !== 'USER' || !ctx.tenantId || (!ctx.sessionId && !ctx.platformAdminId)) {
    throw new Unauthorized('UNAUTHENTICATED', 'Company login required');
  }
  const tenantId = ctx.tenantId;
  // Platform super admin acting in the company: the admin session was checked in authenticate;
  // they may also open suspended / closed / read-only companies.
  if (ctx.platformAdminId) {
    ctx.readOnly = false;
    next();
    return;
  }
  const sessionId = ctx.sessionId!;

  const { status, session, access } = await withTenant(tenantId, async (tx) => {
    const session = await sessionState(tx, sessionId);
    const status = await tenantStatus(tx, tenantId);
    // Effective permissions, cached per user; the stamp changes with every permission change.
    const access =
      session && session.user_status === 'ACTIVE'
        ? await cachedAccess(
            tx,
            { id: ctx.userId!, tenantId, role: session.user_role, roleId: session.role_id, canSeeFinancials: session.can_see_financials },
            [session.user_role, session.role_id ?? '-', session.perm_version, session.role_version ?? '-', session.can_see_financials].join('|'),
          )
        : undefined;
    return { session, status, access };
  });

  if (!status) throw new Unauthorized('TOKEN_INVALID', 'Company no longer exists');
  if (!session || !session.family_active) throw new Unauthorized('SESSION_REVOKED', 'You have been signed out. Please log in again.');
  if (session.user_status !== 'ACTIVE') throw new Unauthorized('ACCOUNT_DISABLED', 'This account has been deactivated');
  if (session.device_revoked) throw new Unauthorized('DEVICE_REVOKED', 'This device has been signed out. Please log in again.');
  if (status === 'SUSPENDED' || status === 'CLOSED') {
    throw new Forbidden('COMPANY_SUSPENDED', 'This company account is suspended. Please contact support.');
  }
  ctx.readOnly = status === 'READ_ONLY';
  // Role and permissions come from the database, so a change applies on the next request.
  ctx.role = session.user_role;
  ctx.access = access;
  ctx.permissions = access?.permissions ?? [];
  next();
};
