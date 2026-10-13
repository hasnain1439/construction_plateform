import { createHash } from 'node:crypto';

/**
 * Pseudonymous user id for Sentry and PostHog: the first 32 hex chars of
 * SHA-256("user:" + userId). Web and mobile compute the same value, so one person's events
 * line up across apps without the raw id (or any name / phone) leaving our systems.
 */
export function hashUserId(userId: string): string {
  return createHash('sha256').update(`user:${userId}`).digest('hex').slice(0, 32);
}
