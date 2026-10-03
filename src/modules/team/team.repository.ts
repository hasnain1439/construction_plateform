import type { DevicePlatform, InvitationStatus, Prisma, UserRole, UserStatus } from '../../generated/prisma/client.js';

type Db = Prisma.TransactionClient;

const OFFICE_ROLES: UserRole[] = ['THEKEDAR', 'PM'];

// ─── Seats ──────────────────────────────────────────────────────────────────

export function countActiveOfficeUsers(tx: Db): Promise<number> {
  return tx.user.count({ where: { status: 'ACTIVE', role: { in: OFFICE_ROLES } } });
}

export async function maxOfficeUsers(tx: Db, tenantId: string): Promise<number | null> {
  const sub = await tx.subscription.findUnique({ where: { tenantId }, select: { plan: { select: { maxOfficeUsers: true } } } });
  return sub?.plan.maxOfficeUsers ?? null;
}

// ─── Users ──────────────────────────────────────────────────────────────────

const userListInclude = {
  projectAccess: { select: { project: { select: { id: true, name: true } } } },
  devices: { select: { lastActiveAt: true }, orderBy: { lastActiveAt: 'desc' }, take: 1 },
} satisfies Prisma.UserInclude;

export type UserListRow = Prisma.UserGetPayload<{ include: typeof userListInclude }>;

export function userWhere(filters: {
  search?: string;
  role?: UserRole;
  status?: UserStatus;
  projectId?: string;
}): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];
  if (filters.search) {
    const digits = filters.search.replace(/\D/g, '').replace(/^0+/, '').replace(/^92/, '');
    and.push({
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ],
    });
  }
  if (filters.role) and.push({ role: filters.role });
  if (filters.status) and.push({ status: filters.status });
  if (filters.projectId) and.push({ OR: [{ role: 'THEKEDAR' }, { projectAccess: { some: { projectId: filters.projectId } } }] });
  return and.length ? { AND: and } : {};
}

export function listUsers(tx: Db, where: Prisma.UserWhereInput, skip: number, take: number) {
  return tx.user.findMany({
    where,
    include: userListInclude,
    orderBy: [{ status: 'asc' }, { role: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    skip,
    take,
  });
}

export function countUsers(tx: Db, where: Prisma.UserWhereInput) {
  return tx.user.count({ where });
}

export function findUser(tx: Db, id: string) {
  return tx.user.findUnique({ where: { id }, include: userListInclude });
}

export function countActiveDevices(tx: Db, userId: string) {
  return tx.device.count({ where: { userId, revokedAt: null } });
}

export function phoneTakenByOther(tx: Db, phone: string, exceptUserId: string) {
  return tx.user.findFirst({ where: { phone, id: { not: exceptUserId } }, select: { id: true } });
}

export function findUserByPhone(tx: Db, phone: string) {
  return tx.user.findFirst({ where: { phone }, select: { id: true, status: true } });
}

export function updateUser(tx: Db, id: string, data: Prisma.UserUncheckedUpdateInput) {
  return tx.user.update({ where: { id }, data });
}

export function countActiveThekedars(tx: Db) {
  return tx.user.count({ where: { role: 'THEKEDAR', status: 'ACTIVE' } });
}

export function revokeUserSessions(tx: Db, userId: string, now: Date) {
  return tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
}

export function revokeUserDevices(tx: Db, userId: string, now: Date) {
  return tx.device.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
}

// ─── Projects ───────────────────────────────────────────────────────────────

/** RLS limits the lookup to the current company, so foreign ids are never returned. */
export function findProjects(tx: Db, ids: string[]) {
  if (!ids.length) return Promise.resolve([]);
  return tx.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

export async function userProjectIds(tx: Db, userId: string): Promise<string[]> {
  const rows = await tx.userProjectAccess.findMany({ where: { userId }, select: { projectId: true } });
  return rows.map((r) => r.projectId);
}

export async function replaceUserProjects(tx: Db, tenantId: string, userId: string, projectIds: string[]) {
  // Serialise concurrent replacements for the same user (last write wins, no duplicate-key errors).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user-projects:${userId}`}))`;
  await tx.userProjectAccess.deleteMany({ where: { userId } });
  if (projectIds.length) {
    await tx.userProjectAccess.createMany({
      data: projectIds.map((projectId) => ({ tenantId, userId, projectId })),
      skipDuplicates: true,
    });
  }
}

export function findUserByEmail(tx: Db, email: string) {
  return tx.user.findFirst({ where: { email }, select: { id: true } });
}

// ─── Invitations ────────────────────────────────────────────────────────────

const invitationInclude = { invitedBy: { select: { id: true, name: true } } } satisfies Prisma.InvitationInclude;
export type InvitationRow = Prisma.InvitationGetPayload<{ include: typeof invitationInclude }>;

/** Lazily flips overdue PENDING invitations to EXPIRED. */
export function expireOverdueInvitations(tx: Db, now: Date) {
  return tx.invitation.updateMany({ where: { status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
}

export function listInvitations(tx: Db, status: InvitationStatus, skip: number, take: number) {
  return tx.invitation.findMany({ where: { status }, include: invitationInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take });
}

export function countInvitations(tx: Db, status: InvitationStatus) {
  return tx.invitation.count({ where: { status } });
}

export function findInvitation(tx: Db, id: string) {
  return tx.invitation.findUnique({ where: { id }, include: invitationInclude });
}

export function findOpenInvitationForPhone(tx: Db, phone: string, now: Date, excludeId?: string) {
  return tx.invitation.findFirst({
    where: { phone, status: 'PENDING', expiresAt: { gt: now }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
}

/** Cancels only while still open; returns false if it was accepted/cancelled meanwhile. */
export async function cancelOpenInvitation(tx: Db, id: string): Promise<boolean> {
  const result = await tx.invitation.updateMany({
    where: { id, status: { in: ['PENDING', 'EXPIRED'] } },
    data: { status: 'CANCELLED' },
  });
  return result.count === 1;
}

export function createInvitation(tx: Db, data: Prisma.InvitationUncheckedCreateInput) {
  return tx.invitation.create({ data });
}

export function updateInvitation(tx: Db, id: string, data: Prisma.InvitationUncheckedUpdateInput) {
  return tx.invitation.update({ where: { id }, data });
}

export function findSettings(tx: Db, tenantId: string) {
  return tx.tenantSettings.findUnique({ where: { tenantId }, select: { pmCanSeeFinancials: true } });
}

export function findTenantName(tx: Db, tenantId: string) {
  return tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
}

// ─── Devices ────────────────────────────────────────────────────────────────

const deviceInclude = { user: { select: { id: true, name: true, role: true } } } satisfies Prisma.DeviceInclude;

export function listDevices(tx: Db, where: { userId?: string; platform?: DevicePlatform }, skip: number, take: number) {
  return tx.device.findMany({ where, include: deviceInclude, orderBy: [{ lastActiveAt: 'desc' }, { id: 'asc' }], skip, take });
}

export function countDevices(tx: Db, where: { userId?: string; platform?: DevicePlatform }) {
  return tx.device.count({ where });
}

export function findDevice(tx: Db, id: string) {
  return tx.device.findUnique({ where: { id }, include: deviceInclude });
}

export async function currentDeviceId(tx: Db, sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const session = await tx.session.findUnique({ where: { id: sessionId }, select: { deviceId: true } });
  return session?.deviceId ?? null;
}

export function revokeDevice(tx: Db, id: string, now: Date) {
  return tx.device.update({ where: { id }, data: { revokedAt: now } });
}

export function revokeDeviceSessions(tx: Db, deviceId: string, now: Date) {
  return tx.session.updateMany({ where: { deviceId, revokedAt: null }, data: { revokedAt: now } });
}
