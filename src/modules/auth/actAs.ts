/**
 * Platform super admin working inside a company ("act as").
 *
 * The admin console sends the admin's own token plus `X-Act-As-Tenant: <companyId>` and
 * `X-Act-As-Session: <ActAsSession id>` (started with a reason, READ_ONLY unless switched to
 * WRITE with a second reason, 60 minutes by default) to the normal company API. The request
 * then runs as that company's hidden system user — role
 * THEKEDAR, every permission — so every company rule, calculation and delete check applies
 * exactly as in the company's own app. Rows the admin creates point at the system user
 * ("Super Admin (Platform)"); the audit log names the real admin (see writeAudit).
 *
 * The system user is INACTIVE (it can never sign in), flagged `isSystem`, and kept out of
 * team lists, plan limits, owner SMS and notifications.
 */
import type { ActAsContext } from '../../core/context/requestContext.js';
import { prismaAdmin } from '../../core/db/prisma.js';
import { Forbidden } from '../../core/errors/AppError.js';

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

// ─── Act-as sessions ────────────────────────────────────────────────────────

/**
 * Every act-as request also carries `X-Act-As-Session: <ActAsSession id>` — started in the admin
 * console with a reason (POST /admin/act-as-sessions). The company header alone is refused.
 */
export const ACT_AS_SESSION_HEADER = 'x-act-as-session';
/** Methods a READ_ONLY session may use; anything else is 403 ACT_AS_READ_ONLY. */
export const ACT_AS_SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The live act-as session `sessionId` of this admin in this company, or a 403:
 * missing → ACT_AS_SESSION_REQUIRED, unknown / another admin's / another company's →
 * ACT_AS_SESSION_INVALID, ended → ACT_AS_SESSION_ENDED, past expiresAt → ACT_AS_SESSION_EXPIRED.
 */
export async function liveActAsSession(sessionId: string | undefined, adminId: string, tenantId: string): Promise<ActAsContext> {
  if (!sessionId) {
    throw new Forbidden('ACT_AS_SESSION_REQUIRED', 'Start a support session with a reason before opening this company (X-Act-As-Session).');
  }
  const session = UUID.test(sessionId)
    ? await prismaAdmin.actAsSession.findUnique({ where: { id: sessionId }, include: { admin: { select: { name: true } } } })
    : null;
  if (!session || session.adminId !== adminId || session.tenantId !== tenantId) {
    throw new Forbidden('ACT_AS_SESSION_INVALID', 'This support session does not belong to you and this company.');
  }
  if (session.endedAt) throw new Forbidden('ACT_AS_SESSION_ENDED', 'This support session has ended. Start a new one to continue.');
  if (session.expiresAt <= new Date()) throw new Forbidden('ACT_AS_SESSION_EXPIRED', 'This support session has expired. Start a new one to continue.');
  return { sessionId: session.id, adminName: session.admin.name, reason: session.reason, mode: session.mode, writeReason: session.writeReason };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
