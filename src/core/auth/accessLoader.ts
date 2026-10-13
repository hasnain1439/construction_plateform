/**
 * Loads effective permissions from the database, with a per-user cache.
 *
 * Cache key = user id; an entry is valid while its stamp (role, roleId, User.permVersion,
 * Role.version, canSeeFinancials) matches what tenantContext reads on every request — every
 * change to a user's role / overrides bumps User.permVersion and every change to a role's
 * permissions bumps Role.version, so a change applies on the very next request, on every API
 * instance. Entries also expire after ACCESS_TTL_MS as a safety net.
 */
import type { Tx } from '../db/withTenant.js';
import { DEFAULT_TEMPLATE_FOR, FINANCIAL_BUNDLE } from './permissionCatalog.js';
import { ownerAccess, resolveAccess, templateGrants, type Access, type CompanyRole, type Grant, type OverrideGrant, type RoleInfo } from './access.js';

const ACCESS_TTL_MS = 60_000;
const cache = new Map<string, { stamp: string; access: Access; expiresAt: number }>();

export interface AccessUser {
  id: string;
  tenantId: string;
  role: CompanyRole;
  roleId: string | null;
  canSeeFinancials: boolean;
  permVersion?: number;
}

/** Reads role + overrides of one user and resolves them (no cache). */
export async function loadAccess(tx: Tx, user: AccessUser): Promise<Access> {
  if (user.role === 'THEKEDAR') return ownerAccess();
  const overrides = await tx.userPermissionOverride.findMany({ where: { tenantId: user.tenantId, userId: user.id }, select: { permissionKey: true, effect: true, scope: true, maxAmountPaisa: true } });
  const role = user.roleId
    ? await tx.role.findFirst({ where: { tenantId: user.tenantId, id: user.roleId }, include: { permissions: true } })
    : await tx.role.findFirst({ where: { tenantId: user.tenantId, key: DEFAULT_TEMPLATE_FOR[user.role], isSystem: true }, include: { permissions: true } });
  let roleGrants: Grant[];
  let roleInfo: RoleInfo;
  if (role) {
    roleGrants = role.permissions.map((p) => ({ permissionKey: p.permissionKey, scope: p.scope, maxAmountPaisa: p.maxAmountPaisa }));
    roleInfo = { id: role.id, key: role.key, name: role.name };
  } else {
    // Company not backfilled yet: the code template of the role.
    roleGrants = templateGrants(user.role, false);
    roleInfo = { id: null, key: DEFAULT_TEMPLATE_FOR[user.role], name: null };
  }
  // Not migrated yet (no roleId, no overrides): the old canSeeFinancials flag still counts.
  if (!user.roleId && !overrides.length && user.role === 'PM' && user.canSeeFinancials) {
    for (const k of FINANCIAL_BUNDLE) roleGrants.push({ permissionKey: k });
  }
  return resolveAccess({ role: user.role, roleInfo, roleGrants, overrides: overrides as OverrideGrant[] });
}

/** Cached access of the request's user; `stamp` must change whenever the permissions may have. */
export async function cachedAccess(tx: Tx, user: AccessUser, stamp: string): Promise<Access> {
  const hit = cache.get(user.id);
  if (hit && hit.stamp === stamp && hit.expiresAt > Date.now()) return hit.access;
  const access = await loadAccess(tx, user);
  cache.set(user.id, { stamp, access, expiresAt: Date.now() + ACCESS_TTL_MS });
  if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
  return access;
}

/** Drops cached access (one user, or everyone). Stamps already make changes visible; this is for tests / tools. */
export function invalidateAccess(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/** Access of several users at once (notifications, team lists). */
export async function loadAccessMany(tx: Tx, users: AccessUser[]): Promise<Map<string, Access>> {
  const out = new Map<string, Access>();
  for (const u of users) out.set(u.id, await loadAccess(tx, u));
  return out;
}
