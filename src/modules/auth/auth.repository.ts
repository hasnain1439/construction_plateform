/**
 * All Prisma access for the auth module. Functions take the client to use:
 *   - `prismaAdmin` (BYPASSRLS) for cross-tenant lookups before the tenant is known;
 *   - a `withTenant()` transaction for everything inside one company.
 */
import type { DevicePlatform, OtpPurpose, Prisma, UserRole } from '../../generated/prisma/client.js';

type Db = Prisma.TransactionClient;

const ACTIVE_USER = { status: 'ACTIVE' } as const;
const userWithTenant = { tenant: { select: { id: true, name: true, status: true } } } as const;

export type UserWithTenant = Prisma.UserGetPayload<{ include: typeof userWithTenant }>;

/** Serialises concurrent operations on the same key inside the current transaction. */
export async function advisoryLock(tx: Db, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

// ─── Users ──────────────────────────────────────────────────────────────────

/** Active users matching an email or E.164 phone, across tenants unless `tenantId` given. */
export function findActiveUsersByLogin(db: Db, login: string, tenantId?: string): Promise<UserWithTenant[]> {
  const byLogin = login.includes('@') ? { email: login } : { phone: login };
  return db.user.findMany({
    where: { ...byLogin, ...ACTIVE_USER, ...(tenantId ? { tenantId } : {}) },
    include: userWithTenant,
    orderBy: { createdAt: 'asc' },
  });
}

export function findActiveUsersByPhone(db: Db, phone: string, tenantId?: string): Promise<UserWithTenant[]> {
  return findActiveUsersByLogin(db, phone, tenantId);
}

export function findOwnerByPhone(db: Db, phone: string) {
  return db.user.findFirst({ where: { phone, role: 'THEKEDAR' }, select: { id: true } });
}

export function findUserById(tx: Db, userId: string) {
  return tx.user.findUnique({ where: { id: userId } });
}

export async function recordLoginFailure(
  tx: Db,
  user: { id: string; lockedUntil: Date | null },
  now: Date,
  maxAttempts: number,
  lockMs: number,
): Promise<{ attempts: number; lockedUntil: Date | null }> {
  // A lock that has expired starts a fresh count.
  if (user.lockedUntil && user.lockedUntil <= now) {
    await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  }
  const updated = await tx.user.update({
    where: { id: user.id },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (updated.failedLoginCount >= maxAttempts) {
    const lockedUntil = new Date(now.getTime() + lockMs);
    await tx.user.update({ where: { id: user.id }, data: { lockedUntil, failedLoginCount: 0 } });
    return { attempts: updated.failedLoginCount, lockedUntil };
  }
  return { attempts: updated.failedLoginCount, lockedUntil: null };
}

export function markLoginSuccess(tx: Db, userId: string, now: Date) {
  return tx.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });
}

export function updateUser(tx: Db, userId: string, data: Prisma.UserUncheckedUpdateInput) {
  return tx.user.update({ where: { id: userId }, data });
}

export function attachmentExists(tx: Db, id: string) {
  return tx.attachment.findUnique({ where: { id }, select: { id: true } });
}

export function countActiveOfficeUsers(tx: Db): Promise<number> {
  return tx.user.count({ where: { ...ACTIVE_USER, role: { in: ['THEKEDAR', 'PM'] } } });
}

export function userExistsInTenant(tx: Db, phone: string) {
  return tx.user.findFirst({ where: { phone }, select: { id: true } });
}

export function createUser(
  tx: Db,
  data: {
    tenantId: string;
    name: string;
    phone: string;
    email: string | null;
    passwordHash: string | null;
    role: UserRole;
    canSeeFinancials?: boolean;
  },
) {
  return tx.user.create({
    data: { ...data, passwordChangedAt: data.passwordHash ? new Date() : null },
  });
}

// ─── Profile ────────────────────────────────────────────────────────────────

/** Sequential on purpose: a transaction is one connection, so queries can't run in parallel. */
export async function loadProfile(tx: Db, userId: string, tenantId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, include: { photo: { select: { url: true } } } });
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    include: { settings: true, subscription: { include: { plan: { select: { code: true, name: true } } } } },
  });
  return [user, tenant] as const;
}

export type ProfileUser = NonNullable<Awaited<ReturnType<typeof loadProfile>>[0]>;
export type ProfileTenant = NonNullable<Awaited<ReturnType<typeof loadProfile>>[1]>;

export async function assignedProjectIds(tx: Db, userId: string): Promise<string[]> {
  const rows = await tx.userProjectAccess.findMany({ where: { userId }, select: { projectId: true } });
  return rows.map((r) => r.projectId);
}

// ─── Tenant / plans ─────────────────────────────────────────────────────────

export function findPlanByCode(db: Db, code: string) {
  return db.plan.findFirst({ where: { code, isActive: true } });
}

export async function slugsStartingWith(db: Db, base: string): Promise<Set<string>> {
  const rows = await db.tenant.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } });
  return new Set(rows.map((r) => r.slug));
}

export function createTenant(
  tx: Db,
  data: { name: string; slug: string; region: 'PUNJAB_KP' | 'KARACHI_SINDH'; marlaStandardSqft: number; planId: string; trialEndsAt: Date },
) {
  return tx.tenant.create({
    data: {
      name: data.name,
      slug: data.slug,
      region: data.region,
      status: 'ACTIVE',
      settings: { create: { marlaStandardSqft: data.marlaStandardSqft } },
      subscription: { create: { planId: data.planId, status: 'TRIAL', trialEndsAt: data.trialEndsAt } },
    },
  });
}

export function findTenantPlan(tx: Db, tenantId: string) {
  return tx.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
}

export async function existingProjectIds(tx: Db, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await tx.project.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return rows.map((r) => r.id);
}

export function grantProjectAccess(tx: Db, tenantId: string, userId: string, projectIds: string[]) {
  if (!projectIds.length) return Promise.resolve({ count: 0 });
  return tx.userProjectAccess.createMany({
    data: projectIds.map((projectId) => ({ tenantId, userId, projectId })),
    skipDuplicates: true,
  });
}

// ─── Devices & sessions ─────────────────────────────────────────────────────

export function upsertDevice(
  tx: Db,
  data: { tenantId: string; userId: string; clientDeviceId: string; platform: DevicePlatform; model?: string | null; appVersion?: string | null },
  now: Date,
) {
  const details = { platform: data.platform, model: data.model ?? null, appVersion: data.appVersion ?? null };
  return tx.device.upsert({
    where: { userId_clientDeviceId: { userId: data.userId, clientDeviceId: data.clientDeviceId } },
    create: { tenantId: data.tenantId, userId: data.userId, clientDeviceId: data.clientDeviceId, ...details, lastActiveAt: now },
    update: { ...details, revokedAt: null, lastActiveAt: now },
  });
}

export function touchDevice(tx: Db, deviceId: string, now: Date) {
  return tx.device.update({ where: { id: deviceId }, data: { lastActiveAt: now } });
}

export function createSession(
  tx: Db,
  data: {
    tenantId: string;
    userId: string;
    deviceId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    ip?: string | null;
    userAgent?: string | null;
  },
) {
  return tx.session.create({ data: { ...data, ip: data.ip ?? null, userAgent: data.userAgent ?? null } });
}

export function findSessionByTokenHash(db: Db, tokenHash: string) {
  return db.session.findUnique({
    where: { tokenHash },
    include: { device: true, user: { include: userWithTenant } },
  });
}

/** Revokes `oldId` only if still active. Returns false when someone else got there first. */
export async function supersedeSession(tx: Db, oldId: string, newId: string, now: Date): Promise<boolean> {
  const result = await tx.session.updateMany({
    where: { id: oldId, revokedAt: null },
    data: { revokedAt: now, replacedById: newId },
  });
  return result.count === 1;
}

export function revokeSession(tx: Db, sessionId: string, now: Date) {
  return tx.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}

export function revokeFamily(tx: Db, familyId: string, now: Date) {
  return tx.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
}

export function revokeUserSessions(tx: Db, userId: string, now: Date, exceptSessionId?: string) {
  return tx.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: now },
  });
}

export function listActiveSessions(tx: Db, userId: string, now: Date) {
  return tx.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now }, device: { revokedAt: null } },
    include: { device: true },
    orderBy: { lastActiveAt: 'desc' },
  });
}

// ─── OTP ────────────────────────────────────────────────────────────────────

export function latestOtp(db: Db, phone: string, purpose: OtpPurpose) {
  return db.otpCode.findFirst({ where: { phone, purpose }, orderBy: { createdAt: 'desc' } });
}

export function latestUnconsumedOtp(db: Db, phone: string, purpose: OtpPurpose) {
  return db.otpCode.findFirst({ where: { phone, purpose, consumedAt: null }, orderBy: { createdAt: 'desc' } });
}

export function countOtpsSince(db: Db, phone: string, since: Date) {
  return db.otpCode.count({ where: { phone, createdAt: { gte: since } } });
}

export function consumeOpenOtps(db: Db, phone: string, purpose: OtpPurpose, now: Date) {
  return db.otpCode.updateMany({ where: { phone, purpose, consumedAt: null }, data: { consumedAt: now } });
}

export function createOtp(db: Db, data: { phone: string; purpose: OtpPurpose; codeHash: string; expiresAt: Date; now: Date }) {
  return db.otpCode.create({
    data: {
      phone: data.phone,
      purpose: data.purpose,
      codeHash: data.codeHash,
      expiresAt: data.expiresAt,
      lastSentAt: data.now,
      createdAt: data.now,
    },
  });
}

export function incrementOtpAttempts(db: Db, id: string) {
  return db.otpCode.update({ where: { id }, data: { attempts: { increment: 1 } }, select: { attempts: true } });
}

/** Marks consumed only if still open; false when it was already used. */
export async function consumeOtp(db: Db, id: string, now: Date, tenantId?: string | null): Promise<boolean> {
  const result = await db.otpCode.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: now, ...(tenantId ? { tenantId } : {}) },
  });
  return result.count === 1;
}

// ─── Invitations ────────────────────────────────────────────────────────────

export function findInvitationByTokenHash(db: Db, tokenHash: string) {
  return db.invitation.findUnique({
    where: { tokenHash },
    include: { tenant: { select: { id: true, name: true, status: true } } },
  });
}

export function markInvitationExpired(db: Db, id: string) {
  return db.invitation.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
}

export async function markInvitationAccepted(tx: Db, id: string, userId: string, now: Date): Promise<boolean> {
  const result = await tx.invitation.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'ACCEPTED', acceptedUserId: userId, acceptedAt: now },
  });
  return result.count === 1;
}

// ─── Platform admins ────────────────────────────────────────────────────────

export function findAdminByEmail(db: Db, email: string) {
  return db.platformAdmin.findUnique({ where: { email } });
}

export function findAdminById(db: Db, id: string) {
  return db.platformAdmin.findUnique({ where: { id } });
}

export async function recordAdminLoginFailure(
  db: Db,
  admin: { id: string; lockedUntil: Date | null },
  now: Date,
  maxAttempts: number,
  lockMs: number,
): Promise<{ lockedUntil: Date | null }> {
  if (admin.lockedUntil && admin.lockedUntil <= now) {
    await db.platformAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  }
  const updated = await db.platformAdmin.update({
    where: { id: admin.id },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (updated.failedLoginCount >= maxAttempts) {
    const lockedUntil = new Date(now.getTime() + lockMs);
    await db.platformAdmin.update({ where: { id: admin.id }, data: { lockedUntil, failedLoginCount: 0 } });
    return { lockedUntil };
  }
  return { lockedUntil: null };
}

export function markAdminLoginSuccess(db: Db, id: string, now: Date) {
  return db.platformAdmin.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
}

export function createAdminSession(
  db: Db,
  data: { adminId: string; tokenHash: string; familyId: string; expiresAt: Date; ip?: string | null; userAgent?: string | null },
) {
  return db.platformAdminSession.create({ data: { ...data, ip: data.ip ?? null, userAgent: data.userAgent ?? null } });
}

export function findAdminSessionByTokenHash(db: Db, tokenHash: string) {
  return db.platformAdminSession.findUnique({ where: { tokenHash }, include: { admin: true } });
}

export async function supersedeAdminSession(db: Db, oldId: string, newId: string, now: Date): Promise<boolean> {
  const result = await db.platformAdminSession.updateMany({
    where: { id: oldId, revokedAt: null },
    data: { revokedAt: now, replacedById: newId },
  });
  return result.count === 1;
}

export function revokeAdminSession(db: Db, id: string, now: Date) {
  return db.platformAdminSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
}

export function revokeAdminFamily(db: Db, familyId: string, now: Date) {
  return db.platformAdminSession.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
}
