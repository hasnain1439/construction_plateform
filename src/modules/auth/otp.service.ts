import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prismaAdmin } from '../../core/db/prisma.js';
import { BadRequest, Gone, TooManyRequests } from '../../core/errors/AppError.js';
import { generateOtp, hashSecret, safeEqual } from '../../core/utils/crypto.js';
import { maskPhone } from '../../core/utils/phone.js';
import type { OtpPurpose } from '../../generated/prisma/enums.js';
import * as repo from './auth.repository.js';
import { smsProvider } from './sms.provider.js';

export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_SENDS_PER_HOUR = 5;
export const OTP_MAX_ATTEMPTS = 3;

function hashOtp(phone: string, purpose: OtpPurpose, code: string): string {
  return hashSecret(`${phone}:${purpose}:${code}`);
}

const MESSAGES: Record<OtpPurpose, (code: string, minutes: number) => string> = {
  LOGIN: (code, minutes) => `Your login code is ${code}. It expires in ${minutes} minutes. Do not share it with anyone.`,
  PASSWORD_RESET: (code, minutes) =>
    `Your password reset code is ${code}. It expires in ${minutes} minutes. If you did not ask for this, ignore this message.`,
};

/**
 * Creates a new OTP for `phone` and returns the plain code to the caller so it can be
 * delivered (SMS here; email too for password reset). Enforces the 60 s resend wait and
 * 5 sends/hour per phone. Earlier open codes for the same purpose are invalidated.
 */
export async function issueOtp(phone: string, purpose: OtpPurpose): Promise<{ code: string; expiresIn: number }> {
  const now = new Date();
  const code = generateOtp();

  await prismaAdmin.$transaction(async (tx) => {
    await repo.advisoryLock(tx, `otp:${phone}`);

    const latest = await repo.latestOtp(tx, phone, purpose);
    if (latest) {
      const waited = (now.getTime() - latest.lastSentAt.getTime()) / 1000;
      if (waited < OTP_RESEND_SECONDS) {
        const retryAfterSeconds = Math.ceil(OTP_RESEND_SECONDS - waited);
        throw new TooManyRequests('OTP_RESEND_WAIT', `Please wait ${retryAfterSeconds} seconds before requesting a new code`, {
          retryAfterSeconds,
        });
      }
    }

    const sentLastHour = await repo.countOtpsSince(tx, phone, new Date(now.getTime() - 3_600_000));
    if (sentLastHour >= OTP_MAX_SENDS_PER_HOUR) {
      throw new TooManyRequests('OTP_LIMIT_REACHED', 'Too many codes requested. Please try again later.', {
        retryAfterSeconds: 3600,
      });
    }

    await repo.consumeOpenOtps(tx, phone, purpose, now);
    await repo.createOtp(tx, {
      phone,
      purpose,
      codeHash: hashOtp(phone, purpose, code),
      expiresAt: new Date(now.getTime() + env.OTP_TTL_SECONDS * 1000),
      now,
    });
  });

  const minutes = Math.max(1, Math.round(env.OTP_TTL_SECONDS / 60));
  await smsProvider().send({ to: phone, body: MESSAGES[purpose](code, minutes) });
  logger.info({ phone: maskPhone(phone), purpose }, 'otp issued');
  return { code, expiresIn: env.OTP_TTL_SECONDS };
}

/**
 * Checks `code` against the latest open OTP for phone + purpose. Does NOT consume it —
 * the caller consumes once the whole operation succeeds (so a MULTIPLE_COMPANIES
 * answer keeps the code usable).
 *
 * Errors: 400 OTP_INVALID (wrong / none), 410 OTP_EXPIRED,
 *         429 OTP_TOO_MANY_ATTEMPTS (3rd wrong attempt consumes the code).
 */
export async function checkOtp(phone: string, purpose: OtpPurpose, code: string): Promise<{ id: string }> {
  const now = new Date();
  // Serialised per phone (same lock as issueOtp), so parallel guesses are counted one by
  // one and can never exceed OTP_MAX_ATTEMPTS comparisons against a code.
  const outcome = await prismaAdmin.$transaction(async (tx) => {
    await repo.advisoryLock(tx, `otp:${phone}`);
    const otp = await repo.latestUnconsumedOtp(tx, phone, purpose);
    if (!otp) return { error: new BadRequest('OTP_INVALID', 'The code is incorrect. Request a new code.') };
    if (otp.expiresAt <= now) return { error: new Gone('OTP_EXPIRED', 'The code has expired. Request a new code.') };
    if (safeEqual(otp.codeHash, hashOtp(phone, purpose, code))) return { id: otp.id };

    const { attempts } = await repo.incrementOtpAttempts(tx, otp.id);
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await repo.consumeOtp(tx, otp.id, now);
      return { error: new TooManyRequests('OTP_TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Request a new code.') };
    }
    return { error: new BadRequest('OTP_INVALID', 'The code is incorrect.', { attemptsLeft: OTP_MAX_ATTEMPTS - attempts }) };
  });
  // Errors are returned (not thrown) so the attempt counter commits.
  if ('error' in outcome && outcome.error) throw outcome.error;
  return { id: outcome.id! };
}

/** True when `code` is the open, unexpired code for this phone. Does not count an attempt. */
export async function otpMatches(phone: string, purpose: OtpPurpose, code: string): Promise<boolean> {
  const otp = await repo.latestUnconsumedOtp(prismaAdmin, phone, purpose);
  return Boolean(otp && otp.expiresAt > new Date() && safeEqual(otp.codeHash, hashOtp(phone, purpose, code)));
}

/** Consumes a checked OTP. Fails if another request consumed it in the meantime. */
export async function consumeCheckedOtp(id: string, tenantId: string | null): Promise<void> {
  const consumed = await repo.consumeOtp(prismaAdmin, id, new Date(), tenantId);
  if (!consumed) throw new BadRequest('OTP_INVALID', 'The code has already been used. Request a new code.');
}
