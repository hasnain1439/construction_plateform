/**
 * Permission provisioning for one company — idempotent, used at sign-up, admin company create,
 * the seed and `npm run backfill:permissions`:
 *
 * 1. System role templates (ROLE_TEMPLATES) exist and their permissions equal the code
 *    definition (a changed template bumps Role.version → cached access refreshes).
 * 2. Every PM / MUNSHI without a role gets the system template of their account type.
 * 3. PMs with the old `canSeeFinancials` flag get the FINANCIAL_BUNDLE as ALLOW overrides
 *    (once — only while they have no overrides at all).
 *
 * Effective access doesn't change, so User.permVersion is not bumped (phones don't resync).
 */
import type { Tx } from '../../core/db/withTenant.js';
import { DEFAULT_TEMPLATE_FOR, FINANCIAL_BUNDLE, ROLE_TEMPLATES, type RoleTemplate } from '../../core/auth/permissionCatalog.js';

export interface PermissionProvisionResult {
  rolesCreated: number;
  rolesUpdated: number;
  usersAssigned: number;
  financialUsersMigrated: number;
}

export const MIGRATED_NOTE = 'Migrated from canSeeFinancials';

/** Creates / re-syncs the system templates; returns their ids by key. */
export async function ensureSystemRoles(tx: Tx, tenantId: string, result?: PermissionProvisionResult): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const t of ROLE_TEMPLATES) {
    const existing = await tx.role.findUnique({ where: { tenantId_key: { tenantId, key: t.key } }, include: { permissions: true } });
    if (!existing) {
      const role = await tx.role.create({
        data: { tenantId, key: t.key, name: t.name.en, nameRoman: t.name.roman, nameUrdu: t.name.urdu, description: t.description, isSystem: true, baseRole: t.baseRole },
      });
      await tx.rolePermission.createMany({ data: grantRows(tenantId, role.id, t) });
      ids.set(t.key, role.id);
      if (result) result.rolesCreated += 1;
      continue;
    }
    ids.set(t.key, existing.id);
    const want = new Map(grantRows(tenantId, existing.id, t).map((g) => [g.permissionKey, g]));
    const have = new Map(existing.permissions.map((p) => [p.permissionKey, p]));
    const same =
      want.size === have.size &&
      [...want.values()].every((w) => {
        const h = have.get(w.permissionKey);
        return h && h.scope === w.scope && (h.maxAmountPaisa ?? null) === (w.maxAmountPaisa ?? null);
      });
    const meta = existing.name === t.name.en && existing.nameRoman === t.name.roman && existing.nameUrdu === t.name.urdu && existing.description === t.description && existing.isSystem && existing.baseRole === t.baseRole;
    if (same && meta) continue;
    if (!same) {
      await tx.rolePermission.deleteMany({ where: { tenantId, roleId: existing.id } });
      await tx.rolePermission.createMany({ data: [...want.values()] });
    }
    await tx.role.update({
      where: { id: existing.id },
      data: { name: t.name.en, nameRoman: t.name.roman, nameUrdu: t.name.urdu, description: t.description, isSystem: true, baseRole: t.baseRole, ...(same ? {} : { version: { increment: 1 } }) },
    });
    if (result) result.rolesUpdated += 1;
  }
  return ids;
}

function grantRows(tenantId: string, roleId: string, t: RoleTemplate) {
  return t.grants.map((g) => ({ tenantId, roleId, permissionKey: g.key, scope: g.scope ?? ('ASSIGNED_PROJECTS' as const), maxAmountPaisa: g.maxAmountPaisa ?? null }));
}

export async function provisionPermissions(tx: Tx, tenantId: string): Promise<PermissionProvisionResult> {
  const result: PermissionProvisionResult = { rolesCreated: 0, rolesUpdated: 0, usersAssigned: 0, financialUsersMigrated: 0 };
  const roles = await ensureSystemRoles(tx, tenantId, result);

  const users = await tx.user.findMany({
    where: { tenantId, role: { in: ['PM', 'MUNSHI'] }, isSystem: false },
    select: { id: true, role: true, roleId: true, canSeeFinancials: true, _count: { select: { permissionOverrides: true } } },
  });
  for (const u of users) {
    const base = u.role as 'PM' | 'MUNSHI';
    if (!u.roleId) {
      await tx.user.update({ where: { id: u.id }, data: { roleId: roles.get(DEFAULT_TEMPLATE_FOR[base])! } });
      result.usersAssigned += 1;
      if (base === 'PM' && u.canSeeFinancials && u._count.permissionOverrides === 0) {
        await tx.userPermissionOverride.createMany({
          data: FINANCIAL_BUNDLE.map((permissionKey) => ({ tenantId, userId: u.id, permissionKey, effect: 'ALLOW' as const, note: MIGRATED_NOTE })),
          skipDuplicates: true,
        });
        result.financialUsersMigrated += 1;
      }
    }
  }
  return result;
}

/** Default role id for a new PM / MUNSHI of the company (provisions the templates if missing). */
export async function defaultRoleId(tx: Tx, tenantId: string, base: 'PM' | 'MUNSHI'): Promise<string> {
  const key = DEFAULT_TEMPLATE_FOR[base];
  const found = await tx.role.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { id: true } });
  if (found) return found.id;
  return (await ensureSystemRoles(tx, tenantId)).get(key)!;
}
