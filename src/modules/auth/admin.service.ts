/**
 * Platform-admin authentication. Platform admins live in their own table, get
 * `platform`-audience tokens and their own session table; they are never company users.
 */
import bcrypt from 'bcryptjs';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { prismaAdmin } from '../../core/db/prisma.js';
import { Locked, Unauthorized } from '../../core/errors/AppError.js';
import * as repo from './auth.repository.js';
import type { AdminLoginInput, PlatformAdminDto } from './auth.schema.js';
import { LOCK_MINUTES, MAX_FAILED_LOGINS } from './auth.service.js';
import {
  accessTokenTtlSeconds,
  hashRefreshToken,
  newFamilyId,
  newRefreshToken,
  platformAccessToken,
  refreshExpiry,
  type IssuedTokens,
} from './token.service.js';

const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 10);
const invalidCredentials = () => new Unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password');

function toAdminDto(admin: { id: string; email: string; name: string; lastLoginAt: Date | null }): PlatformAdminDto {
  return { id: admin.id, email: admin.email, name: admin.name, lastLoginAt: admin.lastLoginAt?.toISOString() ?? null };
}

function assertNotLocked(lockedUntil: Date | null, now: Date): void {
  if (lockedUntil && lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000);
    throw new Locked('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { retryAfterSeconds });
  }
}

export async function adminLogin(input: AdminLoginInput): Promise<{ tokens: IssuedTokens; admin: PlatformAdminDto }> {
  const now = new Date();
  const admin = await repo.findAdminByEmail(prismaAdmin, input.email);
  if (!admin || !admin.isActive) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    throw invalidCredentials();
  }
  assertNotLocked(admin.lockedUntil, now);

  if (!(await bcrypt.compare(input.password, admin.passwordHash))) {
    const { lockedUntil } = await repo.recordAdminLoginFailure(prismaAdmin, admin, now, MAX_FAILED_LOGINS, LOCK_MINUTES * 60_000);
    logger.warn({ adminId: admin.id }, 'platform admin login failed');
    if (lockedUntil) assertNotLocked(lockedUntil, now);
    throw invalidCredentials();
  }

  const ctx = getCtx();
  const refresh = newRefreshToken();
  const session = await prismaAdmin.$transaction(async (tx) => {
    const updated = await repo.markAdminLoginSuccess(tx, admin.id, now);
    const created = await repo.createAdminSession(tx, {
      adminId: admin.id,
      tokenHash: refresh.hash,
      familyId: newFamilyId(),
      expiresAt: refreshExpiry(now),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await writeAudit(tx, {
      tenantId: null,
      actorType: 'PLATFORM_ADMIN',
      actorId: admin.id,
      action: 'admin.login',
      entityType: 'PlatformAdminSession',
      entityId: created.id,
    });
    return { created, updated };
  });

  return {
    admin: toAdminDto(session.updated),
    tokens: {
      accessToken: platformAccessToken(admin.id, session.created.id),
      accessTokenExpiresIn: accessTokenTtlSeconds,
      refreshToken: refresh.token,
    },
  };
}

class RotationRace extends Error {}

export async function adminRefresh(refreshToken: string | undefined): Promise<{ tokens: IssuedTokens }> {
  const invalid = () => new Unauthorized('REFRESH_INVALID', 'Session expired. Please log in again.');
  if (!refreshToken) throw invalid();
  const now = new Date();
  const session = await repo.findAdminSessionByTokenHash(prismaAdmin, hashRefreshToken(refreshToken));
  if (!session) throw invalid();

  const reuse = async () => {
    await repo.revokeAdminFamily(prismaAdmin, session.familyId, now);
    logger.warn({ adminId: session.adminId, familyId: session.familyId }, 'platform refresh token reuse detected');
    return new Unauthorized('REFRESH_TOKEN_REUSED', 'This session was used elsewhere and has been signed out.');
  };

  if (session.revokedAt) {
    if (session.replacedById) throw await reuse();
    throw invalid();
  }
  if (session.expiresAt <= now || !session.admin.isActive) throw invalid();

  const ctx = getCtx();
  const next = newRefreshToken();
  const created = await prismaAdmin
    .$transaction(async (tx) => {
      const row = await repo.createAdminSession(tx, {
        adminId: session.adminId,
        tokenHash: next.hash,
        familyId: session.familyId,
        expiresAt: refreshExpiry(now),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (!(await repo.supersedeAdminSession(tx, session.id, row.id, now))) throw new RotationRace();
      return row;
    })
    .catch((err: unknown) => {
      if (err instanceof RotationRace) return null;
      throw err;
    });
  if (!created) throw await reuse();

  return {
    tokens: {
      accessToken: platformAccessToken(session.adminId, created.id),
      accessTokenExpiresIn: accessTokenTtlSeconds,
      refreshToken: next.token,
    },
  };
}

export async function adminLogout(): Promise<void> {
  const ctx = getCtx();
  await repo.revokeAdminSession(prismaAdmin, ctx.sessionId!, new Date());
}

export async function adminMe(): Promise<PlatformAdminDto> {
  const admin = await repo.findAdminById(prismaAdmin, getCtx().userId!);
  if (!admin || !admin.isActive) throw new Unauthorized('TOKEN_INVALID', 'Account no longer exists');
  return toAdminDto(admin);
}
