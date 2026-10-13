/**
 * Effective permissions of a company user, and the helpers every service uses to check them.
 *
 *   effective = THEKEDAR → every key (scope ALL_PROJECTS, no limits)
 *             | role permissions + ALLOW overrides − DENY overrides   (ownerOnly keys never)
 *
 * The request's access is resolved once per request by tenantContext (cached per user, keyed by
 * User.permVersion + Role.version, so any change applies on the next request — no token refresh
 * needed) and kept on the request context. Code that runs outside a request (seed, jobs) or for
 * another user gets the default template of that user's role (`defaultAccess`).
 */
import { tryGetCtx } from '../context/requestContext.js';
import { Forbidden } from '../errors/AppError.js';
import {
  CATALOG_BY_KEY,
  DEFAULT_TEMPLATE_FOR,
  FINANCIAL_BUNDLE,
  OWNER_ONLY_KEYS,
  PERMISSION_KEYS,
  TEMPLATE_BY_KEY,
  type FieldKey,
  type PermissionScope,
} from './permissionCatalog.js';

export type CompanyRole = 'THEKEDAR' | 'PM' | 'MUNSHI';
export type PermissionSource = 'owner' | 'role' | 'override';

export interface Grant {
  permissionKey: string;
  scope?: PermissionScope | null;
  maxAmountPaisa?: bigint | null;
}

export interface OverrideGrant extends Grant {
  effect: 'ALLOW' | 'DENY';
}

export interface FieldAccess {
  rates: boolean;
  amounts: boolean;
  profit: boolean;
  contract: boolean;
}

/** What /auth/me, /sync/pull and GET /users/:id/permissions return. */
export interface AccessDto {
  owner: boolean;
  role: { id: string | null; key: string | null; name: string | null } | null;
  permissions: string[];
  fieldAccess: FieldAccess;
  /** Scoped keys the user holds → ASSIGNED_PROJECTS / ALL_PROJECTS. */
  scopes: Record<string, PermissionScope>;
  /** Limit-capable keys the user holds → max paisa as a string, or null (no limit). */
  approvalLimits: Record<string, string | null>;
}

export interface Access extends AccessDto {
  has: ReadonlySet<string>;
  sources: Record<string, PermissionSource>;
  /** Role keys removed by a DENY override. */
  denied: string[];
}

export interface RoleInfo {
  id: string | null;
  key: string | null;
  name: string | null;
}

function build(owner: boolean, role: RoleInfo | null, granted: Map<string, { scope: PermissionScope; max: bigint | null; source: PermissionSource }>, denied: string[]): Access {
  const keys = [...granted.keys()].sort();
  const scopes: Record<string, PermissionScope> = {};
  const approvalLimits: Record<string, string | null> = {};
  const sources: Record<string, PermissionSource> = {};
  for (const k of keys) {
    const g = granted.get(k)!;
    const def = CATALOG_BY_KEY.get(k);
    sources[k] = g.source;
    if (def?.scoped) scopes[k] = g.scope;
    if (def?.limit) approvalLimits[k] = g.max === null ? null : g.max.toString();
  }
  const has = new Set(keys);
  const field = (k: FieldKey) => has.has(k);
  return {
    owner,
    role,
    permissions: keys,
    fieldAccess: { rates: field('fields.rates'), amounts: field('fields.amounts'), profit: field('fields.profit'), contract: field('fields.contract') },
    scopes,
    approvalLimits,
    has,
    sources,
    denied: denied.sort(),
  };
}

/** Every key, all projects, no limits. */
export function ownerAccess(): Access {
  const granted = new Map(PERMISSION_KEYS.map((k) => [k, { scope: 'ALL_PROJECTS' as PermissionScope, max: null, source: 'owner' as PermissionSource }]));
  return build(true, null, granted, []);
}
const OWNER = ownerAccess();

/** Pure resolution: role grants + ALLOW overrides − DENY overrides (never ownerOnly keys). */
export function resolveAccess(input: { role: CompanyRole; roleInfo?: RoleInfo | null; roleGrants: Grant[]; overrides?: OverrideGrant[] }): Access {
  if (input.role === 'THEKEDAR') return OWNER;
  const granted = new Map<string, { scope: PermissionScope; max: bigint | null; source: PermissionSource }>();
  for (const g of input.roleGrants) {
    if (!CATALOG_BY_KEY.has(g.permissionKey) || OWNER_ONLY_KEYS.has(g.permissionKey)) continue;
    granted.set(g.permissionKey, { scope: g.scope ?? 'ASSIGNED_PROJECTS', max: g.maxAmountPaisa ?? null, source: 'role' });
  }
  const denied: string[] = [];
  for (const o of input.overrides ?? []) {
    if (!CATALOG_BY_KEY.has(o.permissionKey) || OWNER_ONLY_KEYS.has(o.permissionKey)) continue;
    if (o.effect === 'ALLOW') {
      const fromRole = granted.get(o.permissionKey);
      granted.set(o.permissionKey, {
        scope: o.scope ?? fromRole?.scope ?? 'ASSIGNED_PROJECTS',
        max: o.maxAmountPaisa !== undefined && o.maxAmountPaisa !== null ? o.maxAmountPaisa : (fromRole?.max ?? null),
        source: 'override',
      });
    }
  }
  for (const o of input.overrides ?? []) {
    if (o.effect === 'DENY' && granted.delete(o.permissionKey)) denied.push(o.permissionKey);
  }
  return build(false, input.roleInfo ?? null, granted, denied);
}

/** The code template of a role (+ the old financial flag) — used before a company is backfilled and outside requests. */
export function templateGrants(role: 'PM' | 'MUNSHI', canSeeFinancials = false): Grant[] {
  const t = TEMPLATE_BY_KEY.get(DEFAULT_TEMPLATE_FOR[role])!;
  const grants: Grant[] = t.grants.map((g) => ({ permissionKey: g.key, scope: g.scope ?? null, maxAmountPaisa: g.maxAmountPaisa ?? null }));
  if (role === 'PM' && canSeeFinancials) for (const k of FINANCIAL_BUNDLE) grants.push({ permissionKey: k });
  return grants;
}

const defaults = new Map<string, Access>();
/** Default template access of a role (no overrides). */
export function defaultAccess(role: CompanyRole, canSeeFinancials = false): Access {
  if (role === 'THEKEDAR') return OWNER;
  const key = `${role}:${canSeeFinancials}`;
  let hit = defaults.get(key);
  if (!hit) {
    const t = TEMPLATE_BY_KEY.get(DEFAULT_TEMPLATE_FOR[role])!;
    hit = resolveAccess({ role, roleInfo: { id: null, key: t.key, name: t.name.en }, roleGrants: templateGrants(role, canSeeFinancials) });
    defaults.set(key, hit);
  }
  return hit;
}

export function toAccessDto(a: Access): AccessDto {
  return { owner: a.owner, role: a.role, permissions: a.permissions, fieldAccess: a.fieldAccess, scopes: a.scopes, approvalLimits: a.approvalLimits };
}

/**
 * Old permission names, derived from the new keys — still returned as `legacyPermissions` so
 * clients built against the old model keep working while they move to keys. Deprecated.
 */
export function legacyPermissions(a: Access): string[] {
  const out: string[] = [];
  if (a.owner) out.push('company.update', 'users.manage');
  if (a.has.has('fields.amounts')) out.push('billing.view');
  if (a.has.has('fields.profit')) out.push('profit.view');
  if (a.has.has('fields.rates')) out.push('rates.view');
  if (a.owner) out.push('store.manage');
  if (a.has.has('projects.project.edit')) out.push('projects.manage');
  if (a.has.has('labor.attendance.create') || a.has.has('dailylog.log.create')) out.push('site.entry');
  return out;
}

// ─── Checks ─────────────────────────────────────────────────────────────────

/** Anything that carries a user id and role (the module "actors"). */
export interface Subject {
  userId: string;
  role: CompanyRole | string;
}

/**
 * Access of `subject` (default: the request's user). The request's resolved access when it is the
 * same user; otherwise the default template of the subject's role.
 */
export function accessOf(subject?: Subject): Access {
  const ctx = tryGetCtx();
  if (ctx?.access && (!subject || subject.userId === ctx.userId)) return ctx.access;
  if (!subject) {
    if (ctx?.role && ctx.role !== 'PLATFORM_ADMIN') return defaultAccess(ctx.role);
    return defaultAccess('MUNSHI');
  }
  return defaultAccess(subject.role as CompanyRole);
}

export function can(key: string, subject?: Subject): boolean {
  return accessOf(subject).has.has(key);
}

export function permissionDenied(key: string | string[], message?: string): Forbidden {
  const keys = Array.isArray(key) ? key : [key];
  return new Forbidden('PERMISSION_DENIED', message ?? 'You do not have permission to do this', { permission: keys[0], ...(keys.length > 1 ? { anyOf: keys } : {}) });
}

export function assertPerm(key: string, subject?: Subject, message?: string): void {
  if (!can(key, subject)) throw permissionDenied(key, message);
}

/** Does the grant of `key` cover every project (owner, or scope ALL_PROJECTS)? */
export function scopeAll(key: string, subject?: Subject): boolean {
  const a = accessOf(subject);
  return a.owner || a.scopes[key] === 'ALL_PROJECTS';
}

/** Approval limit of `key` in paisa (null = no limit). */
export function approvalLimit(key: string, subject?: Subject): bigint | null {
  const a = accessOf(subject);
  if (a.owner) return null;
  const v = a.approvalLimits[key];
  return v === undefined || v === null ? null : BigInt(v);
}

/** 403 APPROVAL_LIMIT_EXCEEDED when `amountPaisa` is above the caller's limit for `key`. */
export function assertApprovalLimit(key: string, amountPaisa: bigint, subject?: Subject): void {
  const max = approvalLimit(key, subject);
  const amount = amountPaisa < 0n ? -amountPaisa : amountPaisa;
  if (max !== null && amount > max) {
    throw new Forbidden('APPROVAL_LIMIT_EXCEEDED', 'This is above your approval limit — the owner has to approve it', {
      permission: key,
      maxAmountPaisa: max.toString(),
      amountPaisa: amount.toString(),
    });
  }
}

/** Field visibility of the request's user (or of `subject`). */
export function fieldAccess(subject?: Subject): FieldAccess {
  return accessOf(subject).fieldAccess;
}

/** The effective-permission fields of login results, /auth/me and /sync/pull (`access`). */
export function accessFieldsOf(a: Access) {
  return {
    permissions: a.permissions,
    legacyPermissions: legacyPermissions(a),
    fieldAccess: a.fieldAccess,
    scopes: a.scopes,
    approvalLimits: a.approvalLimits,
    permissionRole: a.owner ? null : a.role,
  };
}
