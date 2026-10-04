import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../core/audit/audit.js';
import { permissionsFor } from '../../core/auth/permissions.js';
import { getCtx } from '../../core/context/requestContext.js';
import { prismaAdmin } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import {
  AppError,
  BadRequest,
  Conflict,
  Forbidden,
  Gone,
  Locked,
  NotFound,
  PlanLimit,
  Unauthorized,
} from '../../core/errors/AppError.js';
import { assertWithinLimit, lockPlanUsage } from '../../core/plan/planLimits.js';
import { hashSecret } from '../../core/utils/crypto.js';
import { maskPhone } from '../../core/utils/phone.js';
import { slugify } from '../../core/utils/slug.js';
import type { TenantStatus } from '../../generated/prisma/enums.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import { provisionMasterData } from '../master-data/provision.js';
import * as repo from './auth.repository.js';
import type {
  AcceptInvitationInput,
  DeviceInput,
  ForgotPasswordInput,
  LoginInput,
  MeDto,
  OtpRequestInput,
  OtpVerifyInput,
  ResetPasswordInput,
  SessionDto,
  SignupInput,
  SubscriptionDto,
  TenantDto,
  UpdateMeInput,
  UserDto,
} from './auth.schema.js';
import { mailProvider } from './mail.provider.js';
import { checkOtp, consumeCheckedOtp, issueOtp, OTP_RESEND_SECONDS, otpMatches } from './otp.service.js';
import {
  accessTokenTtlSeconds,
  companyAccessToken,
  hashRefreshToken,
  newFamilyId,
  newRefreshToken,
  refreshExpiry,
  type IssuedTokens,
} from './token.service.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
const LOCK_MS = LOCK_MINUTES * 60_000;
const TRIAL_DAYS = 14;
const DEFAULT_MARLA_SQFT = 225;

/** Compared against when no user matches, so response time doesn't reveal accounts. */
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', env.BCRYPT_ROUNDS);

export interface AuthResult {
  tokens: IssuedTokens;
  user: UserDto;
  tenant: TenantDto;
  subscription: SubscriptionDto | null;
  permissions: string[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

const invalidCredentials = () => new Unauthorized('INVALID_CREDENTIALS', 'Incorrect email/phone or password');
const companySuspended = () =>
  new Forbidden('COMPANY_SUSPENDED', 'This company account is suspended. Please contact support.');

function assertTenantUsable(status: TenantStatus): void {
  if (status === 'SUSPENDED' || status === 'CLOSED') throw companySuspended();
}

function assertNotLocked(lockedUntil: Date | null, now: Date): void {
  if (lockedUntil && lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000);
    throw new Locked('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`, {
      retryAfterSeconds,
    });
  }
}

function multipleCompanies(users: repo.UserWithTenant[]): Conflict {
  return new Conflict('MULTIPLE_COMPANIES', 'This account belongs to more than one company. Choose one.', {
    companies: users.map((u) => ({ tenantId: u.tenantId, name: u.tenant.name, role: u.role })),
  });
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.BCRYPT_ROUNDS);
}

// ─── DTO mapping ────────────────────────────────────────────────────────────

async function toUserDto(user: repo.ProfileUser): Promise<UserDto> {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    language: user.language,
    photoUrl: await optionalSignedUrl(user.photo),
    canSeeFinancials: user.canSeeFinancials,
  };
}

async function toTenantDto(tenant: repo.ProfileTenant): Promise<TenantDto> {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    logoUrl: await optionalSignedUrl(tenant.logo),
    status: tenant.status,
    readOnly: tenant.status === 'READ_ONLY',
    region: tenant.region,
    marlaStandard: tenant.settings ? Number(tenant.settings.marlaStandardSqft) : DEFAULT_MARLA_SQFT,
  };
}

function toSubscriptionDto(tenant: repo.ProfileTenant): SubscriptionDto | null {
  const sub = tenant.subscription;
  if (!sub) return null;
  return {
    plan: { code: sub.plan.code, name: sub.plan.name },
    status: sub.status,
    renewsOn: (sub.currentPeriodEnd ?? sub.trialEndsAt)?.toISOString() ?? null,
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
  };
}

async function loadProfileDtos(tx: Tx, userId: string, tenantId: string) {
  const [user, tenant] = await repo.loadProfile(tx, userId, tenantId);
  if (!user || !tenant) throw new Unauthorized('TOKEN_INVALID', 'Account no longer exists');
  return {
    user,
    tenant,
    dto: { user: await toUserDto(user), tenant: await toTenantDto(tenant), subscription: toSubscriptionDto(tenant) },
  };
}

// ─── Session issuing (shared by signup / login / otp / invite) ─────────────

interface SessionTarget {
  id: string;
  tenantId: string;
  role: repo.UserWithTenant['role'];
  canSeeFinancials: boolean;
}

function resolveDevice(device: DeviceInput | undefined): DeviceInput {
  // Web clients may omit the device; each such login gets its own browser device.
  return device ?? { deviceId: `web-${randomUUID()}`, platform: 'WEB' };
}

/** Upserts the device, opens a new session family and returns fresh tokens. Runs inside `tx`. */
async function openSession(tx: Tx, user: SessionTarget, deviceInput: DeviceInput | undefined, now: Date) {
  const ctx = getCtx();
  const device = resolveDevice(deviceInput);
  const deviceRow = await repo.upsertDevice(
    tx,
    {
      tenantId: user.tenantId,
      userId: user.id,
      clientDeviceId: device.deviceId,
      platform: device.platform,
      model: device.model,
      appVersion: device.appVersion,
    },
    now,
  );
  const refresh = newRefreshToken();
  const session = await repo.createSession(tx, {
    tenantId: user.tenantId,
    userId: user.id,
    deviceId: deviceRow.id,
    tokenHash: refresh.hash,
    familyId: newFamilyId(),
    expiresAt: refreshExpiry(now),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  const access = companyAccessToken(user, session.id);
  return {
    sessionId: session.id,
    permissions: access.permissions,
    tokens: { accessToken: access.token, accessTokenExpiresIn: accessTokenTtlSeconds, refreshToken: refresh.token },
  };
}

/** Final step of every successful sign-in for an existing user. */
async function completeLogin(
  user: repo.UserWithTenant,
  device: DeviceInput | undefined,
  method: 'password' | 'otp',
): Promise<AuthResult> {
  const now = new Date();
  return withTenant(user.tenantId, async (tx) => {
    if (method === 'password') {
      // Re-read the lock: parallel wrong guesses may have locked the account while this
      // request was comparing its (correct) password against a stale row.
      const fresh = await repo.findUserById(tx, user.id);
      assertNotLocked(fresh?.lockedUntil ?? null, now);
    }
    if (method === 'otp') {
      await writeAudit(tx, {
        tenantId: user.tenantId,
        actorType: 'USER',
        actorId: user.id,
        action: 'auth.otp_verified',
        entityType: 'User',
        entityId: user.id,
        details: { purpose: 'LOGIN' },
      });
    }
    await repo.markLoginSuccess(tx, user.id, now);
    const session = await openSession(tx, user, device, now);
    await writeAudit(tx, {
      tenantId: user.tenantId,
      actorType: 'USER',
      actorId: user.id,
      action: 'auth.login',
      entityType: 'Session',
      entityId: session.sessionId,
      details: { method },
    });
    const { dto } = await loadProfileDtos(tx, user.id, user.tenantId);
    return { tokens: session.tokens, permissions: session.permissions, ...dto };
  });
}

// ─── Signup ─────────────────────────────────────────────────────────────────

async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name);
  const taken = await repo.slugsStartingWith(tx, base);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

export async function signup(input: SignupInput): Promise<AuthResult> {
  const now = new Date();
  const passwordHash = await hashPassword(input.password);

  const result = await prismaAdmin.$transaction(async (tx) => {
    await repo.advisoryLock(tx, `signup:${input.phone}`);
    if (await repo.findOwnerByPhone(tx, input.phone)) {
      throw new Conflict('PHONE_TAKEN', 'This phone number already owns a company. Log in instead.');
    }
    const plan = (await repo.findPlanByCode(tx, 'TRIAL')) ?? (await repo.findPlanByCode(tx, 'STARTER'));
    if (!plan) throw new AppError(500, 'PLANS_NOT_CONFIGURED', 'No TRIAL or STARTER plan exists. Run the seed.');

    await repo.advisoryLock(tx, 'tenant-slug');
    const tenant = await repo.createTenant(tx, {
      name: input.companyName,
      slug: await uniqueSlug(tx, input.companyName),
      region: input.region,
      marlaStandardSqft: input.marlaStandard ?? DEFAULT_MARLA_SQFT,
      planId: plan.id,
      trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000),
    });
    const user = await repo.createUser(tx, {
      tenantId: tenant.id,
      name: input.ownerName,
      phone: input.phone,
      email: input.email ?? null,
      passwordHash,
      role: 'THEKEDAR',
    });
    // Starting master data: material catalog, quality categories, labour rates, billing template.
    await provisionMasterData(tx, tenant.id);
    await repo.markLoginSuccess(tx, user.id, now);
    const session = await openSession(tx, user, input.device, now);
    await writeAudit(tx, {
      tenantId: tenant.id,
      actorType: 'USER',
      actorId: user.id,
      action: 'tenant.signup',
      entityType: 'Tenant',
      entityId: tenant.id,
      details: { plan: plan.code, region: input.region },
    });
    const { dto } = await loadProfileDtos(tx, user.id, tenant.id);
    return { tokens: session.tokens, permissions: session.permissions, ...dto };
  });

  logger.info({ tenantId: result.tenant.id }, 'tenant signed up');
  return result;
}

// ─── Password login ─────────────────────────────────────────────────────────

/** Counts a failed password attempt (and audits it). Returns the lock time if this attempt locked the account. */
async function registerFailedLogin(user: repo.UserWithTenant, now: Date): Promise<Date | null> {
  return withTenant(user.tenantId, async (tx) => {
    const result = await repo.recordLoginFailure(tx, user, now, MAX_FAILED_LOGINS, LOCK_MS);
    await writeAudit(tx, {
      tenantId: user.tenantId,
      actorType: 'USER',
      actorId: user.id,
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: user.id,
      details: { reason: 'bad_password', locked: Boolean(result.lockedUntil) },
    });
    return result.lockedUntil;
  });
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const now = new Date();
  const candidates = await repo.findActiveUsersByLogin(prismaAdmin, input.login, input.tenantId);
  if (!candidates.length) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    throw invalidCredentials();
  }

  let user: repo.UserWithTenant;
  let passwordVerified = false;

  if (candidates.length === 1) {
    user = candidates[0]!;
  } else {
    // Same phone/email in several companies and no tenantId yet. Only companies where
    // the password matches are revealed, so the list can't be used to probe accounts.
    const withPassword = candidates.filter((c) => c.passwordHash);
    if (!withPassword.length) throw new BadRequest('USE_OTP_LOGIN', 'This account signs in with a code sent by SMS.');
    const matches: repo.UserWithTenant[] = [];
    for (const candidate of withPassword) {
      const locked = candidate.lockedUntil && candidate.lockedUntil > now;
      if (!locked && (await bcrypt.compare(input.password, candidate.passwordHash!))) matches.push(candidate);
    }
    if (matches.length > 1) throw multipleCompanies(matches);
    if (matches.length === 0) {
      const unlocked = withPassword.filter((c) => !(c.lockedUntil && c.lockedUntil > now));
      if (!unlocked.length) assertNotLocked(withPassword[0]!.lockedUntil, now);
      for (const candidate of unlocked) await registerFailedLogin(candidate, now);
      throw invalidCredentials();
    }
    user = matches[0]!;
    passwordVerified = true;
  }

  assertNotLocked(user.lockedUntil, now);
  if (!user.passwordHash) throw new BadRequest('USE_OTP_LOGIN', 'This account signs in with a code sent by SMS.');

  if (!passwordVerified && !(await bcrypt.compare(input.password, user.passwordHash))) {
    const lockedUntil = await registerFailedLogin(user, now);
    if (lockedUntil) assertNotLocked(lockedUntil, now);
    throw invalidCredentials();
  }

  assertTenantUsable(user.tenant.status);
  return completeLogin(user, input.device, 'password');
}

// ─── OTP login ──────────────────────────────────────────────────────────────

export async function requestLoginOtp(input: OtpRequestInput) {
  const users = await repo.findActiveUsersByPhone(prismaAdmin, input.phone);
  if (!users.length) throw new NotFound('PHONE_NOT_REGISTERED', 'No account uses this phone number.');
  const { expiresIn } = await issueOtp(input.phone, input.purpose);
  return { sent: true as const, expiresIn, resendAfter: OTP_RESEND_SECONDS };
}

export async function verifyLoginOtp(input: OtpVerifyInput): Promise<AuthResult> {
  const otp = await checkOtp(input.phone, 'LOGIN', input.code);

  const users = await repo.findActiveUsersByPhone(prismaAdmin, input.phone, input.tenantId);
  if (!users.length) {
    await consumeCheckedOtp(otp.id, null);
    throw invalidCredentials();
  }
  // Keep the OTP open so the client can resend with the chosen tenantId.
  if (users.length > 1) throw multipleCompanies(users);

  const user = users[0]!;
  assertTenantUsable(user.tenant.status);
  // Consumed first so the same code can't open two sessions; the audit row is written
  // in the same transaction as the session (completeLogin).
  await consumeCheckedOtp(otp.id, user.tenantId);
  return completeLogin(user, input.device, 'otp');
}

// ─── Refresh / logout ───────────────────────────────────────────────────────

export interface RefreshResult {
  tokens: IssuedTokens;
}

class RotationRace extends Error {}

export async function refresh(refreshToken: string | undefined): Promise<RefreshResult> {
  if (!refreshToken) throw new Unauthorized('REFRESH_INVALID', 'Session expired. Please log in again.');
  const now = new Date();
  const session = await repo.findSessionByTokenHash(prismaAdmin, hashRefreshToken(refreshToken));
  if (!session) throw new Unauthorized('REFRESH_INVALID', 'Session expired. Please log in again.');

  const reuseDetected = async () => {
    await withTenant(session.tenantId, async (tx) => {
      await repo.revokeFamily(tx, session.familyId, now);
      await writeAudit(tx, {
        tenantId: session.tenantId,
        actorType: 'USER',
        actorId: session.userId,
        action: 'auth.refresh_reuse_detected',
        entityType: 'Session',
        entityId: session.id,
        details: { familyId: session.familyId },
      });
    });
    logger.warn({ tenantId: session.tenantId, userId: session.userId, familyId: session.familyId }, 'refresh token reuse detected');
    return new Unauthorized('REFRESH_TOKEN_REUSED', 'This session was used elsewhere and has been signed out. Please log in again.');
  };

  // Checked first: revoking a device also revokes its sessions, and the client should
  // learn *why* it was signed out.
  if (session.device.revokedAt) {
    if (!session.revokedAt) await withTenant(session.tenantId, (tx) => repo.revokeSession(tx, session.id, now));
    throw new Unauthorized('DEVICE_REVOKED', 'This device has been signed out. Please log in again.');
  }
  if (session.revokedAt) {
    // A rotated-away token coming back means it was copied: kill the whole family.
    if (session.replacedById) throw await reuseDetected();
    throw new Unauthorized('REFRESH_INVALID', 'Session expired. Please log in again.');
  }
  if (session.expiresAt <= now) throw new Unauthorized('REFRESH_INVALID', 'Session expired. Please log in again.');
  if (session.user.status !== 'ACTIVE') throw new Unauthorized('REFRESH_INVALID', 'Session expired. Please log in again.');
  assertTenantUsable(session.user.tenant.status);

  const ctx = getCtx();
  const next = newRefreshToken();
  const rotated = await withTenant(session.tenantId, async (tx) => {
    const created = await repo.createSession(tx, {
      tenantId: session.tenantId,
      userId: session.userId,
      deviceId: session.deviceId,
      tokenHash: next.hash,
      familyId: session.familyId,
      expiresAt: refreshExpiry(now),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    // Another request rotated this token first: throw so the new session rolls back.
    if (!(await repo.supersedeSession(tx, session.id, created.id, now))) throw new RotationRace();
    await repo.touchDevice(tx, session.deviceId, now);
    return created;
  }).catch((err: unknown) => {
    if (err instanceof RotationRace) return null;
    throw err;
  });

  if (!rotated) throw await reuseDetected();

  const access = companyAccessToken(session.user, rotated.id);
  return { tokens: { accessToken: access.token, accessTokenExpiresIn: accessTokenTtlSeconds, refreshToken: next.token } };
}

export async function logout(): Promise<void> {
  const ctx = getCtx();
  const now = new Date();
  await withTenant(ctx.tenantId!, async (tx) => {
    await repo.revokeSession(tx, ctx.sessionId!, now);
    await writeAudit(tx, {
      tenantId: ctx.tenantId!,
      actorType: 'USER',
      actorId: ctx.userId!,
      action: 'auth.logout',
      entityType: 'Session',
      entityId: ctx.sessionId!,
    });
  });
}

export async function logoutAll(): Promise<{ revoked: number }> {
  const ctx = getCtx();
  const now = new Date();
  return withTenant(ctx.tenantId!, async (tx) => {
    const { count } = await repo.revokeUserSessions(tx, ctx.userId!, now);
    await writeAudit(tx, {
      tenantId: ctx.tenantId!,
      actorType: 'USER',
      actorId: ctx.userId!,
      action: 'auth.logout_all',
      entityType: 'User',
      entityId: ctx.userId!,
      details: { revoked: count },
    });
    return { revoked: count };
  });
}

// ─── Forgot / reset password ────────────────────────────────────────────────

export async function forgotPassword(input: ForgotPasswordInput): Promise<{ sent: true }> {
  const users = await repo.findActiveUsersByLogin(prismaAdmin, input.login);
  if (!users.length) {
    logger.info('password reset requested for unknown login');
    return { sent: true };
  }
  // One code per phone; an email that maps to several phones gets a code on each.
  const phones = [...new Set(users.map((u) => u.phone))];
  for (const phone of phones) {
    try {
      const { code } = await issueOtp(phone, 'PASSWORD_RESET');
      const emails = [...new Set(users.filter((u) => u.phone === phone && u.email).map((u) => u.email!))];
      for (const email of emails) {
        await mailProvider().send({
          to: email,
          subject: 'Your password reset code',
          text: `Your password reset code is ${code}. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes.\nIf you did not request this, you can ignore this email.`,
        });
      }
    } catch (err) {
      // Never reveal rate limits or delivery failures here (account enumeration).
      if (err instanceof AppError) logger.info({ phone: maskPhone(phone), errorCode: err.code }, 'password reset code not sent');
      else logger.error({ err }, 'password reset delivery failed');
    }
  }
  return { sent: true };
}

export async function resetPassword(input: ResetPasswordInput): Promise<{ reset: true }> {
  const users = await repo.findActiveUsersByLogin(prismaAdmin, input.login, input.tenantId);
  if (!users.length) throw new BadRequest('OTP_INVALID', 'The code is incorrect. Request a new code.');

  // An email can belong to users with different phones; each phone got its own code.
  // Find the phone whose code this is before revealing anything about the accounts.
  const phones = [...new Set(users.map((u) => u.phone))];
  let phone = phones[0]!;
  if (phones.length > 1) {
    for (const candidate of phones) {
      if (await otpMatches(candidate, 'PASSWORD_RESET', input.code)) {
        phone = candidate;
        break;
      }
    }
  }
  const otp = await checkOtp(phone, 'PASSWORD_RESET', input.code);
  const owners = users.filter((u) => u.phone === phone);
  // The code proved control of the phone, so listing its companies is safe now.
  if (owners.length > 1) throw multipleCompanies(owners);

  const user = owners[0]!;
  const passwordHash = await hashPassword(input.newPassword);
  await consumeCheckedOtp(otp.id, user.tenantId);

  const now = new Date();
  await withTenant(user.tenantId, async (tx) => {
    await repo.updateUser(tx, user.id, {
      passwordHash,
      passwordChangedAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
    });
    const { count } = await repo.revokeUserSessions(tx, user.id, now);
    await writeAudit(tx, {
      tenantId: user.tenantId,
      actorType: 'USER',
      actorId: user.id,
      action: 'auth.password_reset',
      entityType: 'User',
      entityId: user.id,
      details: { sessionsRevoked: count },
    });
  });
  return { reset: true };
}

// ─── Me ─────────────────────────────────────────────────────────────────────

export async function getMe(): Promise<MeDto> {
  const ctx = getCtx();
  return withTenant(ctx.tenantId!, async (tx) => {
    const { user, dto } = await loadProfileDtos(tx, ctx.userId!, ctx.tenantId!);
    if (user.status !== 'ACTIVE') throw new Unauthorized('TOKEN_INVALID', 'Account is disabled');
    const assigned = user.role === 'THEKEDAR' ? [] : await repo.assignedProjectIds(tx, user.id);
    return { ...dto, permissions: permissionsFor(user), assignedProjectIds: assigned };
  });
}

export async function updateMe(input: UpdateMeInput): Promise<MeDto> {
  const ctx = getCtx();
  const tenantId = ctx.tenantId!;
  const userId = ctx.userId!;

  let newPasswordHash: string | undefined;
  if (input.newPassword) {
    const current = await withTenant(tenantId, (tx) => repo.findUserById(tx, userId));
    if (!current) throw new Unauthorized('TOKEN_INVALID', 'Account no longer exists');
    const valid = current.passwordHash ? await bcrypt.compare(input.currentPassword!, current.passwordHash) : false;
    if (!valid) throw new BadRequest('CURRENT_PASSWORD_WRONG', 'Current password is incorrect');
    newPasswordHash = await hashPassword(input.newPassword);
  }

  const now = new Date();
  await withTenant(tenantId, async (tx) => {
    if (input.photoAttachmentId && !(await repo.attachmentExists(tx, input.photoAttachmentId))) {
      throw new NotFound('ATTACHMENT_NOT_FOUND', 'Photo not found');
    }
    await repo.updateUser(tx, userId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.photoAttachmentId !== undefined ? { photoAttachmentId: input.photoAttachmentId } : {}),
      ...(newPasswordHash ? { passwordHash: newPasswordHash, passwordChangedAt: now } : {}),
    });
    if (newPasswordHash) {
      const { count } = await repo.revokeUserSessions(tx, userId, now, ctx.sessionId);
      await writeAudit(tx, {
        tenantId,
        actorType: 'USER',
        actorId: userId,
        action: 'auth.password_changed',
        entityType: 'User',
        entityId: userId,
        details: { otherSessionsRevoked: count },
      });
    }
  });
  return getMe();
}

export async function listSessions(): Promise<SessionDto[]> {
  const ctx = getCtx();
  const sessions = await withTenant(ctx.tenantId!, (tx) => repo.listActiveSessions(tx, ctx.userId!, new Date()));
  return sessions.map((s) => ({
    id: s.id,
    platform: s.device.platform,
    model: s.device.model,
    appVersion: s.device.appVersion,
    ip: s.ip,
    userAgent: s.userAgent,
    lastActiveAt: s.lastActiveAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    current: s.id === ctx.sessionId,
  }));
}

// ─── Invitations ────────────────────────────────────────────────────────────

/** Maps an invitation's state to the right error (null = usable). */
function invitationProblem(inv: { status: string; expiresAt: Date }, now: Date): AppError | null {
  if (inv.status === 'CANCELLED') return new Gone('INVITE_CANCELLED', 'This invitation was cancelled.');
  if (inv.status === 'ACCEPTED') return new Conflict('INVITE_ALREADY_ACCEPTED', 'This invitation has already been used. Log in instead.');
  if (inv.status === 'EXPIRED' || inv.expiresAt <= now) return new Gone('INVITE_EXPIRED', 'This invitation has expired. Ask for a new one.');
  return null;
}

export async function acceptInvitation(token: string, input: AcceptInvitationInput): Promise<AuthResult> {
  const now = new Date();
  const tokenHash = hashSecret(token);
  const invitation = await repo.findInvitationByTokenHash(prismaAdmin, tokenHash);
  if (!invitation) throw new NotFound('INVITE_NOT_FOUND', 'This invitation link is not valid.');
  const problem = invitationProblem(invitation, now);
  if (problem) {
    if (problem.code === 'INVITE_EXPIRED') await repo.markInvitationExpired(prismaAdmin, invitation.id);
    throw problem;
  }
  assertTenantUsable(invitation.tenant.status);
  if (invitation.role !== 'MUNSHI' && !input.password) {
    throw new BadRequest('VALIDATION_ERROR', 'Some fields are invalid', {
      fields: [{ field: 'password', message: 'Password is required' }],
    });
  }

  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const tenantId = invitation.tenantId;

  const result = await withTenant(tenantId, async (tx) => {
    // Serialise seat checks per company so two acceptances can't both take the last seat.
    await lockPlanUsage(tx, tenantId);

    // Re-read under the lock: it may have been cancelled or resent (new token) meanwhile.
    const current = await repo.findInvitationById(tx, invitation.id);
    if (!current || current.tokenHash !== tokenHash) throw new NotFound('INVITE_NOT_FOUND', 'This invitation link is not valid.');
    const late = invitationProblem(current, now);
    if (late) throw late;

    // A THEKEDAR invite created by the platform admin for a brand-new company is that
    // company's first user: the owner always gets in, whatever the plan.
    const firstUser = invitation.role === 'THEKEDAR' && !(await repo.tenantHasUsers(tx));
    if (invitation.role !== 'MUNSHI' && !firstUser) {
      // This invite already reserved its seat; compare against real users only.
      await assertWithinLimit(tx, tenantId, 'officeUsers', 1, { countPendingInvites: false });
    }
    if (await repo.userExistsInTenant(tx, invitation.phone)) {
      throw new Conflict('PHONE_TAKEN', 'A user with this phone number already exists in this company.');
    }
    if (invitation.email && (await repo.emailTakenInTenant(tx, invitation.email))) {
      throw new Conflict('EMAIL_TAKEN', 'A user with this email already exists in this company. Ask for a new invitation.');
    }

    const user = await repo.createUser(tx, {
      tenantId,
      name: input.name ?? invitation.name,
      phone: invitation.phone,
      email: invitation.email,
      passwordHash,
      role: invitation.role,
      canSeeFinancials: invitation.role === 'PM' && invitation.canSeeFinancials,
    });
    if (!(await repo.markInvitationAccepted(tx, invitation.id, user.id, now))) {
      throw new Conflict('INVITE_ALREADY_ACCEPTED', 'This invitation has already been used. Log in instead.');
    }
    // RLS limits this lookup to the inviting company, so foreign ids are dropped.
    const projectIds = await repo.existingProjectIds(tx, invitation.projectIds);
    await repo.grantProjectAccess(tx, tenantId, user.id, projectIds);

    await repo.markLoginSuccess(tx, user.id, now);
    const session = await openSession(tx, user, input.device, now);
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: user.id,
      action: 'invite.accept',
      entityType: 'Invitation',
      entityId: invitation.id,
      details: { role: invitation.role, projects: projectIds.length },
    });
    const { dto } = await loadProfileDtos(tx, user.id, tenantId);
    return { tokens: session.tokens, permissions: session.permissions, ...dto };
  });
  return result;
}
