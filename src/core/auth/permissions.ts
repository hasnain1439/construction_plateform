import type { UserRole } from '../../generated/prisma/enums.js';

export const PERMISSIONS = [
  'company.update',
  'users.manage',
  'billing.view',
  'profit.view',
  'rates.view',
  'store.manage',
  'projects.manage',
  'site.entry',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionSubject {
  role: UserRole;
  canSeeFinancials: boolean;
}

/**
 * Permissions are derived from role + per-user flags (never stored), and embedded
 * in the access token's `perms` claim.
 *
 * - THEKEDAR (owner): everything.
 * - PM: projects + rates; billing/profit only when `canSeeFinancials`.
 * - MUNSHI: site entry only — never rates or financials.
 */
export function permissionsFor(subject: PermissionSubject): Permission[] {
  switch (subject.role) {
    case 'THEKEDAR':
      return [...PERMISSIONS];
    case 'PM': {
      const perms: Permission[] = ['projects.manage', 'rates.view', 'site.entry'];
      if (subject.canSeeFinancials) perms.push('billing.view', 'profit.view');
      return perms;
    }
    case 'MUNSHI':
      return ['site.entry'];
    default: {
      const exhaustive: never = subject.role;
      throw new Error(`Unknown role: ${String(exhaustive)}`);
    }
  }
}
