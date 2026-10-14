/**
 * Roles & permissions management (Team → Roles & Permissions).
 *
 * A member may hold SEVERAL roles (UserRoleAssignment; User.roleId = the first / primary):
 * effective = union of the roles (widest scope, highest limit) + ALLOW − DENY overrides.
 *
 * Who: THEKEDAR, or a user holding `team.member.manage` (route guard). Rules:
 * - THEKEDAR users are never edited here (403 CANNOT_EDIT_OWNER) — they always have everything.
 * - ownerOnly keys can't be granted (403 OWNER_ONLY_PERMISSION).
 * - System templates are read-only (403 ROLE_IS_SYSTEM) — duplicate one to change it.
 * - A non-owner manager can't change their own permissions (403 CANNOT_EDIT_OWN_PERMISSIONS) and
 *   can't grant more than they hold — key, scope and approval limit (403 GRANT_EXCEEDS_OWN).
 * - Every change is audited with before / after, bumps the affected users' permVersion (the
 *   permission cache key; phones resync) and keeps the deprecated User.canSeeFinancials in step.
 */
import { randomUUID } from 'node:crypto';
import { accessOf, resolveAccess, type Access, type OverrideGrant } from '../../core/auth/access.js';
import { grantsOfRoles, loadAccess, rolesOf } from '../../core/auth/accessLoader.js';
import {
  CATALOG_BY_KEY,
  FINANCIAL_BUNDLE,
  OWNER_ONLY_KEYS,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  type PermissionScope,
} from '../../core/auth/permissionCatalog.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  CreateRoleInput,
  DuplicateRoleInput,
  GrantInput,
  OverrideInput,
  RoleDto,
  SetOverridesInput,
  SetRolePermissionsInput,
  SetUserRolesInput,
  UpdateRoleInput,
  UserPermissionsDto,
} from './permissions.schema.js';
import { defaultRoleId } from './provision.js';

interface Manager {
  tenantId: string;
  userId: string;
  access: Access;
}

function manager(): Manager {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId!, access: accessOf() };
}

const roleNotFound = () => new NotFound('ROLE_NOT_FOUND', 'Role not found');
const userNotFound = () => new NotFound('USER_NOT_FOUND', 'User not found');

// ─── Catalog ────────────────────────────────────────────────────────────────

export function catalog() {
  return {
    modules: Object.entries(PERMISSION_MODULES).map(([key, label]) => ({ key, label })),
    permissions: PERMISSION_CATALOG.map((p) => {
      const [, resource = '', action = ''] = p.key.split('.');
      return {
        key: p.key,
        module: p.module,
        resource: p.field ? 'field' : resource,
        action: p.field ? 'view' : action,
        label: p.label,
        description: p.description,
        ownerOnly: Boolean(p.ownerOnly),
        scoped: Boolean(p.scoped),
        limit: Boolean(p.limit),
        field: Boolean(p.field),
      };
    }),
    templates: ROLE_TEMPLATES.map((t) => ({ key: t.key, name: t.name, baseRole: t.baseRole, description: t.description, permissions: t.grants.map((g) => g.key) })),
    financialBundle: [...FINANCIAL_BUNDLE],
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

interface CleanGrant {
  key: string;
  scope: PermissionScope | null;
  maxAmountPaisa: bigint | null;
}

/** Does the manager hold at least this grant (key, scope, limit)? */
function within(m: Manager, g: CleanGrant): boolean {
  const a = m.access;
  if (a.owner) return true;
  if (!a.has.has(g.key)) return false;
  const def = CATALOG_BY_KEY.get(g.key)!;
  if (def.scoped && g.scope === 'ALL_PROJECTS' && a.scopes[g.key] !== 'ALL_PROJECTS') return false;
  if (def.limit) {
    const own = a.approvalLimits[g.key];
    if (own !== null && own !== undefined && (g.maxAmountPaisa === null || g.maxAmountPaisa > BigInt(own))) return false;
  }
  return true;
}

function cleanGrant(m: Manager, g: { key: string; scope?: PermissionScope | undefined; maxAmountPaisa?: bigint | null | undefined }, granting: boolean): CleanGrant {
  const def = CATALOG_BY_KEY.get(g.key);
  if (!def) throw new BadRequest('UNKNOWN_PERMISSION', `Unknown permission: ${g.key}`, { permission: g.key });
  if (def.ownerOnly) throw new Forbidden('OWNER_ONLY_PERMISSION', 'Only the owner can have this permission', { permission: g.key });
  if (g.scope !== undefined && !def.scoped) throw new BadRequest('SCOPE_NOT_SUPPORTED', `${g.key} is not about project data — it has no scope`, { permission: g.key });
  if (g.maxAmountPaisa !== undefined && g.maxAmountPaisa !== null && !def.limit) {
    throw new BadRequest('LIMIT_NOT_SUPPORTED', `${g.key} has no approval limit`, { permission: g.key });
  }
  const clean: CleanGrant = { key: g.key, scope: def.scoped ? (g.scope ?? null) : null, maxAmountPaisa: g.maxAmountPaisa ?? null };
  if (granting && !within(m, clean)) throw new Forbidden('GRANT_EXCEEDS_OWN', 'You can only give permissions you have yourself (same scope, same or lower limit)', { permission: g.key });
  return clean;
}

function cleanGrants(m: Manager, list: GrantInput[]): CleanGrant[] {
  const seen = new Set<string>();
  return list.map((g) => {
    if (seen.has(g.key)) throw new BadRequest('DUPLICATE_PERMISSION', `${g.key} is listed twice`, { permission: g.key });
    seen.add(g.key);
    const c = cleanGrant(m, g, true);
    return { ...c, scope: CATALOG_BY_KEY.get(c.key)!.scoped ? (c.scope ?? 'ASSIGNED_PROJECTS') : null };
  });
}

// ─── Roles ──────────────────────────────────────────────────────────────────

const roleInclude = { permissions: { orderBy: { permissionKey: 'asc' } }, _count: { select: { assignments: true } } } satisfies Prisma.RoleInclude;
type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

function toRoleDto(r: RoleRow): RoleDto {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    nameRoman: r.nameRoman,
    nameUrdu: r.nameUrdu,
    description: r.description,
    isSystem: r.isSystem,
    baseRole: r.baseRole,
    userCount: r._count.assignments,
    permissions: r.permissions.map((p) => ({ key: p.permissionKey, scope: CATALOG_BY_KEY.get(p.permissionKey)?.scoped ? p.scope : null, maxAmountPaisa: p.maxAmountPaisa?.toString() ?? null })),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const grantsOf = (r: RoleRow) => r.permissions.map((p) => ({ key: p.permissionKey, scope: CATALOG_BY_KEY.get(p.permissionKey)?.scoped ? p.scope : null, maxAmountPaisa: p.maxAmountPaisa?.toString() ?? null }));

async function findRole(tx: Tx, tenantId: string, id: string): Promise<RoleRow> {
  const r = await tx.role.findFirst({ where: { tenantId, id }, include: roleInclude });
  if (!r) throw roleNotFound();
  return r;
}

export async function listRoles(): Promise<RoleDto[]> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => {
    const rows = await tx.role.findMany({ where: { tenantId: m.tenantId }, include: roleInclude, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] });
    // System templates in catalogue order (Administrator first), then custom roles by name.
    const order = new Map(ROLE_TEMPLATES.map((t, i) => [t.key, i]));
    const rank = (r: RoleRow) => (r.isSystem ? (order.get(r.key) ?? 50) : 100);
    return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map(toRoleDto);
  });
}

export async function getRole(id: string): Promise<RoleDto> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => toRoleDto(await findRole(tx, m.tenantId, id)));
}

async function uniqueName(tx: Tx, tenantId: string, name: string) {
  if (await tx.role.findFirst({ where: { tenantId, name: { equals: name, mode: 'insensitive' } }, select: { id: true } })) {
    throw new Conflict('ROLE_NAME_TAKEN', 'A role with this name already exists', { name });
  }
}

async function insertRole(
  tx: Tx,
  m: Manager,
  data: { name: string; nameRoman?: string | null | undefined; nameUrdu?: string | null | undefined; description?: string | null | undefined; baseRole: 'PM' | 'MUNSHI' | 'OTHER' },
  grants: CleanGrant[],
  details: Record<string, unknown>,
): Promise<RoleDto> {
  await uniqueName(tx, m.tenantId, data.name);
  const role = await tx.role.create({
    data: {
      tenantId: m.tenantId,
      key: `CUSTOM_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      name: data.name,
      nameRoman: data.nameRoman ?? null,
      nameUrdu: data.nameUrdu ?? null,
      description: data.description ?? null,
      baseRole: data.baseRole,
      isSystem: false,
    },
  });
  if (grants.length) {
    await tx.rolePermission.createMany({
      data: grants.map((g) => ({ tenantId: m.tenantId, roleId: role.id, permissionKey: g.key, scope: g.scope ?? 'ASSIGNED_PROJECTS', maxAmountPaisa: g.maxAmountPaisa })),
    });
  }
  const row = await findRole(tx, m.tenantId, role.id);
  await writeAudit(tx, {
    tenantId: m.tenantId,
    actorType: 'USER',
    actorId: m.userId,
    action: 'role.create',
    entityType: 'Role',
    entityId: role.id,
    details: { ...details, after: { name: row.name, baseRole: row.baseRole, permissions: grantsOf(row) } } as Prisma.InputJsonObject,
  });
  return toRoleDto(row);
}

export async function createRole(input: CreateRoleInput): Promise<RoleDto> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => {
    const source = input.fromRoleId ? await findRole(tx, m.tenantId, input.fromRoleId) : null;
    const grants = input.permissions
      ? cleanGrants(m, input.permissions)
      : source
        ? cleanGrants(m, source.permissions.map((p) => ({ key: p.permissionKey, ...(CATALOG_BY_KEY.get(p.permissionKey)?.scoped ? { scope: p.scope } : {}), maxAmountPaisa: p.maxAmountPaisa })))
        : [];
    return insertRole(tx, m, { ...input, baseRole: input.baseRole ?? source?.baseRole ?? 'OTHER' }, grants, { fromRoleId: source?.id ?? null });
  });
}

export async function duplicateRole(id: string, input: DuplicateRoleInput): Promise<RoleDto> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => {
    const source = await findRole(tx, m.tenantId, id);
    const grants = cleanGrants(m, source.permissions.map((p) => ({ key: p.permissionKey, ...(CATALOG_BY_KEY.get(p.permissionKey)?.scoped ? { scope: p.scope } : {}), maxAmountPaisa: p.maxAmountPaisa })));
    let name = input.name ?? `${source.name} (copy)`;
    if (!input.name) for (let n = 2; await tx.role.findFirst({ where: { tenantId: m.tenantId, name }, select: { id: true } }); n++) name = `${source.name} (copy ${n})`;
    return insertRole(
      tx,
      m,
      { name, nameRoman: input.nameRoman ?? source.nameRoman, nameUrdu: input.nameUrdu ?? source.nameUrdu, description: input.description ?? source.description, baseRole: source.baseRole },
      grants,
      { fromRoleId: source.id },
    );
  });
}

function assertEditableRole(m: Manager, role: RoleRow, ownRoleIds: string[]) {
  if (role.isSystem) throw new Forbidden('ROLE_IS_SYSTEM', 'System templates are read-only — duplicate it to make changes', { roleId: role.id });
  if (!m.access.owner && ownRoleIds.includes(role.id)) throw new Forbidden('CANNOT_EDIT_OWN_PERMISSIONS', 'You cannot change your own permissions');
}

/** Roles the manager holds (a non-owner can't edit those). */
async function managerRoleIds(tx: Tx, m: Manager): Promise<string[]> {
  const ids = (await tx.userRoleAssignment.findMany({ where: { tenantId: m.tenantId, userId: m.userId }, select: { roleId: true } })).map((a) => a.roleId);
  const primary = (await tx.user.findUnique({ where: { id: m.userId }, select: { roleId: true } }))?.roleId;
  return primary && !ids.includes(primary) ? [...ids, primary] : ids;
}

export async function updateRole(id: string, input: UpdateRoleInput): Promise<RoleDto> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => {
    const role = await findRole(tx, m.tenantId, id);
    assertEditableRole(m, role, await managerRoleIds(tx, m));
    if (input.name && input.name.toLowerCase() !== role.name.toLowerCase()) await uniqueName(tx, m.tenantId, input.name);
    if (input.baseRole && input.baseRole !== role.baseRole && input.baseRole !== 'OTHER') {
      const mismatched = await tx.user.count({ where: { tenantId: m.tenantId, roleAssignments: { some: { roleId: id } }, role: { not: input.baseRole } } });
      if (mismatched) throw new Conflict('ROLE_IN_USE', `${mismatched} user(s) with another account type have this role`, { users: mismatched });
    }
    const before = { name: role.name, nameRoman: role.nameRoman, nameUrdu: role.nameUrdu, description: role.description, baseRole: role.baseRole };
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    await tx.role.update({ where: { id }, data });
    const after = await findRole(tx, m.tenantId, id);
    await writeAudit(tx, {
      tenantId: m.tenantId,
      actorType: 'USER',
      actorId: m.userId,
      action: 'role.update',
      entityType: 'Role',
      entityId: id,
      details: { before, after: { name: after.name, nameRoman: after.nameRoman, nameUrdu: after.nameUrdu, description: after.description, baseRole: after.baseRole } } as Prisma.InputJsonObject,
    });
    return toRoleDto(after);
  });
}

export async function setRolePermissions(id: string, input: SetRolePermissionsInput): Promise<RoleDto> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => {
    const role = await findRole(tx, m.tenantId, id);
    assertEditableRole(m, role, await managerRoleIds(tx, m));
    const grants = cleanGrants(m, input.permissions);
    const before = grantsOf(role);
    await tx.rolePermission.deleteMany({ where: { tenantId: m.tenantId, roleId: id } });
    if (grants.length) {
      await tx.rolePermission.createMany({
        data: grants.map((g) => ({ tenantId: m.tenantId, roleId: id, permissionKey: g.key, scope: g.scope ?? 'ASSIGNED_PROJECTS', maxAmountPaisa: g.maxAmountPaisa })),
      });
    }
    await tx.role.update({ where: { id }, data: { version: { increment: 1 } } });
    await permissionsChanged(tx, m.tenantId, { roleId: id });
    const after = await findRole(tx, m.tenantId, id);
    await writeAudit(tx, {
      tenantId: m.tenantId,
      actorType: 'USER',
      actorId: m.userId,
      action: 'role.permissions_update',
      entityType: 'Role',
      entityId: id,
      details: { role: role.name, before, after: grantsOf(after), usersAffected: after._count.assignments } as Prisma.InputJsonObject,
    });
    return toRoleDto(after);
  });
}

// ─── Users ──────────────────────────────────────────────────────────────────

const userSelect = { id: true, tenantId: true, name: true, role: true, roleId: true, canSeeFinancials: true, isSystem: true, permVersion: true } as const;
type TargetUser = Prisma.UserGetPayload<{ select: typeof userSelect }>;

async function findTarget(tx: Tx, tenantId: string, id: string): Promise<TargetUser> {
  const u = await tx.user.findFirst({ where: { tenantId, id, isSystem: false }, select: userSelect });
  if (!u) throw userNotFound();
  return u;
}

/** A user this manager may change permissions of. */
export function assertManageable(m: { userId: string; access: Access }, target: { id: string; role: string }) {
  if (target.role === 'THEKEDAR') throw new Forbidden('CANNOT_EDIT_OWNER', 'An owner always has every permission and cannot be changed here');
  if (target.id === m.userId && !m.access.owner) throw new Forbidden('CANNOT_EDIT_OWN_PERMISSIONS', 'You cannot change your own permissions');
}

const accessUser = (u: TargetUser) => ({ id: u.id, tenantId: u.tenantId, role: u.role, roleId: u.roleId, canSeeFinancials: u.canSeeFinancials });

/**
 * After any change of role / overrides / role permissions: bump permVersion (cache key; the
 * phones resync) and keep the deprecated canSeeFinancials column equal to "PM with fields.amounts".
 */
export async function permissionsChanged(tx: Tx, tenantId: string, where: { userId?: string; roleId?: string }): Promise<void> {
  const users = await tx.user.findMany({
    where: { tenantId, isSystem: false, role: { not: 'THEKEDAR' }, ...(where.userId ? { id: where.userId } : {}), ...(where.roleId ? { roleAssignments: { some: { roleId: where.roleId } } } : {}) },
    select: userSelect,
  });
  for (const u of users) {
    const access = await loadAccess(tx, accessUser(u));
    const fin = u.role === 'PM' && access.has.has('fields.amounts');
    await tx.user.update({ where: { id: u.id }, data: { permVersion: { increment: 1 }, ...(fin !== u.canSeeFinancials ? { canSeeFinancials: fin } : {}) } });
  }
}

const overrideDto = (o: { permissionKey: string; effect: 'ALLOW' | 'DENY'; scope: PermissionScope | null; maxAmountPaisa: bigint | null; note: string | null }) => ({
  key: o.permissionKey,
  effect: o.effect,
  scope: o.scope,
  maxAmountPaisa: o.maxAmountPaisa?.toString() ?? null,
  note: o.note,
});

async function userPermissionsTx(tx: Tx, tenantId: string, id: string): Promise<UserPermissionsDto> {
  const u = await findTarget(tx, tenantId, id);
  const access = await loadAccess(tx, accessUser(u));
  const overrides = await tx.userPermissionOverride.findMany({ where: { tenantId, userId: id }, orderBy: { permissionKey: 'asc' } });
  const roleById = new Map(access.roles.map((r) => [r.id, r]));
  return {
    user: { id: u.id, name: u.name, role: u.role },
    owner: access.owner,
    role: access.role,
    roles: access.roles,
    effective: access.permissions.map((key) => ({
      key,
      source: access.sources[key]!,
      roles: (access.grantedBy[key] ?? []).map((rid) => roleById.get(rid)).filter((r): r is NonNullable<typeof r> => Boolean(r)),
      scope: access.scopes[key] ?? null,
      maxAmountPaisa: CATALOG_BY_KEY.get(key)?.limit ? (access.approvalLimits[key] ?? null) : null,
    })),
    overrides: overrides.map(overrideDto),
    denied: access.denied,
    permissions: access.permissions,
    fieldAccess: access.fieldAccess,
    scopes: access.scopes,
    approvalLimits: access.approvalLimits,
  };
}

export async function getUserPermissions(id: string): Promise<UserPermissionsDto> {
  const m = manager();
  return withTenant(m.tenantId, (tx) => userPermissionsTx(tx, m.tenantId, id));
}

function cleanOverrides(m: Manager, list: OverrideInput[]) {
  const seen = new Set<string>();
  return list.map((o) => {
    if (seen.has(o.key)) throw new BadRequest('DUPLICATE_PERMISSION', `${o.key} is listed twice`, { permission: o.key });
    seen.add(o.key);
    if (o.effect === 'DENY') {
      if (o.scope !== undefined || (o.maxAmountPaisa !== undefined && o.maxAmountPaisa !== null)) {
        throw new BadRequest('DENY_HAS_NO_SCOPE', 'A removed permission has no scope or limit', { permission: o.key });
      }
      const c = cleanGrant(m, { key: o.key }, false);
      return { ...c, effect: 'DENY' as const, note: o.note ?? null };
    }
    const c = cleanGrant(m, o, true);
    return { ...c, effect: 'ALLOW' as const, note: o.note ?? null };
  });
}

/** An override as stored on an invitation (Invitation.permissionOverrides JSONB) until accept. */
export interface StoredOverride {
  key: string;
  effect: 'ALLOW' | 'DENY';
  scope: PermissionScope | null;
  maxAmountPaisa: string | null;
  note: string | null;
}

/**
 * Invitations: validates the overrides exactly like PUT /users/:id/permission-overrides (known
 * keys, no ownerOnly, scope / limit only where supported, a non-owner only grants what they hold)
 * and returns them in the stored (JSON-safe) shape.
 */
export function validateInviteOverrides(m: { tenantId: string; userId: string; access: Access }, list: OverrideInput[]): StoredOverride[] {
  return cleanOverrides(m as Manager, list).map((o) => ({ key: o.key, effect: o.effect, scope: o.scope, maxAmountPaisa: o.maxAmountPaisa?.toString() ?? null, note: o.note }));
}

/** Reads Invitation.permissionOverrides defensively (keys removed from the catalogue since are dropped). */
export function storedOverrides(value: unknown): StoredOverride[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): StoredOverride[] => {
    const o = v as Partial<StoredOverride> | null;
    if (!o || typeof o.key !== 'string' || (o.effect !== 'ALLOW' && o.effect !== 'DENY')) return [];
    const def = CATALOG_BY_KEY.get(o.key);
    if (!def || def.ownerOnly) return [];
    const allow = o.effect === 'ALLOW';
    return [
      {
        key: o.key,
        effect: o.effect,
        scope: allow && def.scoped && (o.scope === 'ALL_PROJECTS' || o.scope === 'ASSIGNED_PROJECTS') ? o.scope : null,
        maxAmountPaisa: allow && def.limit && typeof o.maxAmountPaisa === 'string' ? o.maxAmountPaisa : null,
        note: typeof o.note === 'string' ? o.note : null,
      },
    ];
  });
}

/**
 * Accepting an invitation: the invite's overrides become UserPermissionOverride rows of the new
 * user (same tx as the user creation; they replace any canSeeFinancials rows of the same key).
 * Audited `user.permissions_update` with the inviter as actor. Returns what was applied.
 */
export async function applyInviteOverrides(
  tx: Tx,
  input: { tenantId: string; userId: string; invitationId: string; invitedById: string | null; overrides: unknown },
): Promise<StoredOverride[]> {
  const list = storedOverrides(input.overrides);
  if (!list.length) return list;
  const { tenantId, userId } = input;
  const before = (await tx.userPermissionOverride.findMany({ where: { tenantId, userId }, orderBy: { permissionKey: 'asc' } })).map(overrideDto);
  await tx.userPermissionOverride.deleteMany({ where: { tenantId, userId, permissionKey: { in: list.map((o) => o.key) } } });
  await tx.userPermissionOverride.createMany({
    data: list.map((o) => ({
      tenantId,
      userId,
      permissionKey: o.key,
      effect: o.effect,
      scope: o.scope,
      maxAmountPaisa: o.maxAmountPaisa === null ? null : BigInt(o.maxAmountPaisa),
      note: o.note,
      createdById: input.invitedById,
    })),
  });
  await permissionsChanged(tx, tenantId, { userId });
  const after = (await tx.userPermissionOverride.findMany({ where: { tenantId, userId }, orderBy: { permissionKey: 'asc' } })).map(overrideDto);
  await writeAudit(tx, {
    tenantId,
    actorType: 'USER',
    actorId: input.invitedById ?? userId,
    action: 'user.permissions_update',
    entityType: 'User',
    entityId: userId,
    details: { via: 'invitation', invitationId: input.invitationId, before, after } as Prisma.InputJsonObject,
  });
  return list;
}

export async function setOverrides(id: string, input: SetOverridesInput): Promise<UserPermissionsDto> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => {
    const target = await findTarget(tx, m.tenantId, id);
    assertManageable(m, target);
    const next = cleanOverrides(m, input.overrides);
    const before = (await tx.userPermissionOverride.findMany({ where: { tenantId: m.tenantId, userId: id }, orderBy: { permissionKey: 'asc' } })).map(overrideDto);
    await tx.userPermissionOverride.deleteMany({ where: { tenantId: m.tenantId, userId: id } });
    if (next.length) {
      await tx.userPermissionOverride.createMany({
        data: next.map((o) => ({ tenantId: m.tenantId, userId: id, permissionKey: o.key, effect: o.effect, scope: o.scope, maxAmountPaisa: o.maxAmountPaisa, note: o.note, createdById: m.userId })),
      });
    }
    await assignDefaultRoleIfMissing(tx, target);
    await permissionsChanged(tx, m.tenantId, { userId: id });
    const after = await userPermissionsTx(tx, m.tenantId, id);
    await writeAudit(tx, {
      tenantId: m.tenantId,
      actorType: 'USER',
      actorId: m.userId,
      action: 'user.permissions_update',
      entityType: 'User',
      entityId: id,
      details: { before, after: after.overrides } as Prisma.InputJsonObject,
    });
    return after;
  });
}

/** Replaces a member's roles (in order; the first = User.roleId, the primary role). */
export async function assignRoles(tx: Tx, tenantId: string, userId: string, roleIds: string[]): Promise<void> {
  await tx.userRoleAssignment.deleteMany({ where: { tenantId, userId } });
  if (roleIds.length) await tx.userRoleAssignment.createMany({ data: roleIds.map((roleId, position) => ({ tenantId, userId, roleId, position })) });
  await tx.user.update({ where: { id: userId }, data: { roleId: roleIds[0] ?? null } });
}

/** Overrides only make sense on top of stored roles: pin the current / default one (unchanged access). */
async function assignDefaultRoleIfMissing(tx: Tx, target: TargetUser) {
  if (target.role === 'THEKEDAR') return;
  if (await tx.userRoleAssignment.count({ where: { tenantId: target.tenantId, userId: target.id } })) return;
  const roleId = target.roleId ?? (await defaultRoleId(tx, target.tenantId, target.role));
  await assignRoles(tx, target.tenantId, target.id, [roleId]);
  target.roleId = roleId;
}

/** Checks roles for an account type (and the manager's own grants); returns them in the given order. */
async function assignableRoles(tx: Tx, m: Manager, roleIds: string[], accountRole: 'PM' | 'MUNSHI'): Promise<RoleRow[]> {
  if (new Set(roleIds).size !== roleIds.length) throw new BadRequest('DUPLICATE_ROLE', 'A role is listed twice');
  const roles: RoleRow[] = [];
  for (const roleId of roleIds) {
    const role = await findRole(tx, m.tenantId, roleId);
    if (role.baseRole !== 'OTHER' && role.baseRole !== accountRole) {
      throw new BadRequest('ROLE_NOT_FOR_ACCOUNT', `This role is for ${role.baseRole === 'PM' ? 'office (PM)' : 'site (Munshi)'} accounts`, { roleId: role.id, baseRole: role.baseRole, userRole: accountRole });
    }
    if (!m.access.owner) {
      for (const p of role.permissions) {
        cleanGrant(m, { key: p.permissionKey, ...(CATALOG_BY_KEY.get(p.permissionKey)?.scoped ? { scope: p.scope } : {}), maxAmountPaisa: p.maxAmountPaisa }, true);
      }
    }
    roles.push(role);
  }
  return roles;
}

/** PATCH /users/:id/role (one role) and PUT /users/:id/roles (several). Audited `user.role_change`. */
export async function setUserRoles(id: string, input: SetUserRolesInput): Promise<UserPermissionsDto> {
  const m = manager();
  return withTenant(m.tenantId, async (tx) => {
    const target = await findTarget(tx, m.tenantId, id);
    assertManageable(m, target);
    if (target.role === 'THEKEDAR') throw new Forbidden('CANNOT_EDIT_OWNER', 'An owner always has every permission and cannot be changed here');
    const roles = await assignableRoles(tx, m, input.roleIds, target.role);
    const before = (await rolesOf(tx, accessUser(target))).map((r) => ({ roleId: r.id, name: r.name }));
    await assignRoles(tx, m.tenantId, id, roles.map((r) => r.id));
    await permissionsChanged(tx, m.tenantId, { userId: id });
    await writeAudit(tx, {
      tenantId: m.tenantId,
      actorType: 'USER',
      actorId: m.userId,
      action: 'user.role_change',
      entityType: 'User',
      entityId: id,
      details: { before, after: roles.map((r) => ({ roleId: r.id, name: r.name })) } as Prisma.InputJsonObject,
    });
    return userPermissionsTx(tx, m.tenantId, id);
  });
}

export const setUserRole = (id: string, roleId: string) => setUserRoles(id, { roleIds: [roleId] });

// ─── canSeeFinancials compatibility ─────────────────────────────────────────

/**
 * The old `canSeeFinancials` flag (team PATCH / invitations): on = ALLOW overrides for the
 * FINANCIAL_BUNDLE (replacing DENYs of those keys), off = those overrides removed (and DENY for
 * bundle keys the role itself grants). Returns whether anything changed. Caller audits.
 */
export async function setFinancialAccess(tx: Tx, m: { tenantId: string; userId: string; access: Access }, userId: string, on: boolean): Promise<boolean> {
  const target = await findTarget(tx, m.tenantId, userId);
  if (on && !m.access.owner) for (const k of FINANCIAL_BUNDLE) cleanGrant(m as Manager, { key: k }, true);
  await assignDefaultRoleIfMissing(tx, target);
  const existing = await tx.userPermissionOverride.findMany({ where: { tenantId: m.tenantId, userId, permissionKey: { in: FINANCIAL_BUNDLE } } });
  const roleAccess = resolveAccess({
    role: target.role,
    roleGrants: grantsOfRoles(await rolesOf(tx, accessUser(target))),
  });
  const want: OverrideGrant[] = on
    ? FINANCIAL_BUNDLE.filter((k) => !roleAccess.has.has(k)).map((k) => ({ permissionKey: k, effect: 'ALLOW' as const }))
    : FINANCIAL_BUNDLE.filter((k) => roleAccess.has.has(k)).map((k) => ({ permissionKey: k, effect: 'DENY' as const }));
  const same = existing.length === want.length && want.every((w) => existing.some((e) => e.permissionKey === w.permissionKey && e.effect === w.effect));
  if (same) return false;
  await tx.userPermissionOverride.deleteMany({ where: { tenantId: m.tenantId, userId, permissionKey: { in: FINANCIAL_BUNDLE } } });
  if (want.length) {
    await tx.userPermissionOverride.createMany({
      data: want.map((w) => ({ tenantId: m.tenantId, userId, permissionKey: w.permissionKey, effect: w.effect, note: 'canSeeFinancials', createdById: m.userId })),
    });
  }
  await permissionsChanged(tx, m.tenantId, { userId });
  return true;
}

/** Validates an invitation's roles for the invited account type (and the inviter's own grants). */
export async function assertAssignableRoles(tx: Tx, m: { tenantId: string; userId: string; access: Access }, roleIds: string[], accountRole: 'PM' | 'MUNSHI'): Promise<void> {
  await assignableRoles(tx, m as Manager, roleIds, accountRole);
}

export const isOwnerOnly = (key: string) => OWNER_ONLY_KEYS.has(key);
export { manager as permissionManager };
