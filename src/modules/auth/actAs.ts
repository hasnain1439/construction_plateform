/**
 * Platform super admin working inside a company ("act as").
 *
 * The admin console sends the admin's own token plus `X-Act-As-Tenant: <companyId>` to the
 * normal company API. That is direct, full access — read and write, no request, no reason, no
 * read-only mode, no expiry, and the company is not notified. (A legacy `X-Act-As-Session`
 * header is accepted and ignored.) The request runs as that company's hidden system user —
 * role THEKEDAR, every permission — so every company rule, calculation and delete check
 * applies exactly as in the company's own app. Rows the admin creates point at the system user
 * ("Super Admin (Platform)"); every audited change names the real admin (id + name, see
 * writeAudit), so the company's audit log shows "Platform support · <admin>".
 *
 * The system user is INACTIVE (it can never sign in), flagged `isSystem`, and kept out of
 * team lists, plan limits, owner SMS and notifications.
 */
import { prismaAdmin } from '../../core/db/prisma.js';

export const ACT_AS_HEADER = 'x-act-as-tenant';
export const SYSTEM_USER_NAME = 'Super Admin (Platform)';
/** Not a real number — never receives an SMS (the user is INACTIVE and never notified). */
export const SYSTEM_USER_PHONE = '+920000000000';

const cache = new Map<string, string>();

/** The company's system user id, created the first time an admin acts in that company. */
export async function systemUserId(tenantId: string): Promise<string> {
  const hit = cache.get(tenantId);
  if (hit) return hit;
  const existing = await prismaAdmin.user.findFirst({ where: { tenantId, isSystem: true }, select: { id: true } });
  const id =
    existing?.id ??
    (
      await prismaAdmin.user.upsert({
        where: { tenantId_phone: { tenantId, phone: SYSTEM_USER_PHONE } },
        create: { tenantId, name: SYSTEM_USER_NAME, phone: SYSTEM_USER_PHONE, role: 'THEKEDAR', status: 'INACTIVE', isSystem: true, canSeeFinancials: true },
        update: { isSystem: true, status: 'INACTIVE' },
        select: { id: true },
      })
    ).id;
  cache.set(tenantId, id);
  return id;
}

/** Test helper. */
export function clearSystemUserCache() {
  cache.clear();
}

/**
 * The name of the platform admin behind the token while they are still active and signed in
 * (logout or deactivation ends access at once); null otherwise.
 */
export async function liveAdminName(sessionId: string): Promise<string | null> {
  const session = await prismaAdmin.platformAdminSession.findUnique({
    where: { id: sessionId },
    select: { familyId: true, admin: { select: { isActive: true, name: true } } },
  });
  if (!session?.admin.isActive) return null;
  const alive = await prismaAdmin.platformAdminSession.count({ where: { familyId: session.familyId, revokedAt: null, expiresAt: { gt: new Date() } } });
  return alive > 0 ? session.admin.name : null;
}

export const tenantExists = async (tenantId: string) => (await prismaAdmin.tenant.count({ where: { id: tenantId } })) > 0;
