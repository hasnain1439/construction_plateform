/**
 * Platform super admin working inside a company ("act as").
 *
 * The admin console sends the admin's own token plus `X-Act-As-Tenant: <companyId>` to the
 * normal company API. The request then runs as that company's hidden system user — role
 * THEKEDAR, every permission — so every company rule, calculation and delete check applies
 * exactly as in the company's own app. Rows the admin creates point at the system user
 * ("Super Admin (Platform)"); the audit log names the real admin (see writeAudit).
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

/** The platform admin behind the token is still active and signed in (logout ends access at once). */
export async function adminSessionAlive(sessionId: string): Promise<boolean> {
  const session = await prismaAdmin.platformAdminSession.findUnique({
    where: { id: sessionId },
    select: { familyId: true, admin: { select: { isActive: true } } },
  });
  if (!session?.admin.isActive) return false;
  return (await prismaAdmin.platformAdminSession.count({ where: { familyId: session.familyId, revokedAt: null, expiresAt: { gt: new Date() } } })) > 0;
}

export const tenantExists = async (tenantId: string) => (await prismaAdmin.tenant.count({ where: { id: tenantId } })) > 0;
