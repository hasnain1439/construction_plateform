import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/** URL-safe random string from `bytes` bytes of CSPRNG output. */
export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hex SHA-256 of `value + pepper`. */
export function sha256(value: string, pepper = ''): string {
  return createHash('sha256').update(value + pepper).digest('hex');
}

/** Hash for opaque secrets we persist (refresh tokens, invitation tokens, OTP codes). */
export function hashSecret(value: string): string {
  return sha256(value, env.JWT_REFRESH_PEPPER);
}

/** 6-digit numeric code from a CSPRNG (uniform, leading zeros kept). */
export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
