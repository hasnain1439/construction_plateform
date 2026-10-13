import { PostHog } from 'posthog-node';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { tryGetCtx } from '../context/requestContext.js';
import { hashUserId } from './hash.js';

/**
 * Product analytics (PostHog), optional: with no POSTHOG_KEY every call is a no-op.
 *
 * Only a fixed list of events and an allow-list of properties ever leave the server.
 * Never money values, names, phones, emails or free text. The person is a hash of the user
 * id (same value as web / mobile, see hash.ts); the company is a PostHog group keyed by its id.
 * Support sessions (platform admin acting inside a company) are not tracked.
 */

export const ANALYTICS_EVENTS = ['login', 'project_activated', 'hazri_marked', 'purchase_saved', 'invoice_issued', 'sync_error'] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** The only property keys ever sent (same list in web and mobile). */
export const ALLOWED_PROPS = [
  'client',
  'platform',
  'method',
  'source',
  'role',
  'status',
  'kind',
  'count',
  'error_code',
  'app_version',
  'offline',
  'duration_ms',
] as const;
export type AnalyticsProps = Partial<Record<(typeof ALLOWED_PROPS)[number], string | number | boolean | null | undefined>>;

const ALLOWED = new Set<string>(ALLOWED_PROPS);
const NUMERIC_KEYS = new Set(['count', 'duration_ms']);
const FORBIDDEN_KEY = /amount|paisa|price|rate|total|balance|money|name|phone|email|cnic|address|token/i;
const EMAIL = /@/;
const MANY_DIGITS = /(?:\d[\s-]?){7,}/;
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]+\./;
const MONEY = /^\s*(?:rs\.?|pkr)?\s*-?[\d,]+(?:\.\d+)?\s*$/i;

/** Drops every property that is not allow-listed or could carry money / personal data. */
export function filterProps(props: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!ALLOWED.has(key) || FORBIDDEN_KEY.test(key)) continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') {
      if (NUMERIC_KEYS.has(key) && Number.isFinite(value)) out[key] = value;
    } else if (typeof value === 'string') {
      if (value.length === 0 || value.length > 64) continue;
      if (EMAIL.test(value) || MANY_DIGITS.test(value) || LONG_TOKEN.test(value) || MONEY.test(value)) continue;
      out[key] = value;
    }
  }
  return out;
}

export interface AnalyticsMessage {
  distinctId: string;
  event: AnalyticsEvent;
  properties: Record<string, string | number | boolean>;
  groups?: Record<string, string>;
}

export interface AnalyticsSink {
  capture(message: AnalyticsMessage): void;
  shutdown(): Promise<void>;
}

let sink: AnalyticsSink | null | undefined;

function posthogSink(key: string, host: string): AnalyticsSink {
  const client = new PostHog(key, { host, flushAt: 20, flushInterval: 10_000, disableGeoip: true });
  client.on('error', (err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'posthog error'));
  return {
    capture: (m) => client.capture({ ...m, disableGeoip: true }),
    shutdown: () => client.shutdown(2000),
  };
}

function currentSink(): AnalyticsSink | null {
  if (sink === undefined) sink = env.POSTHOG_KEY ? posthogSink(env.POSTHOG_KEY, env.POSTHOG_HOST) : null;
  return sink;
}

export function analyticsEnabled(): boolean {
  return currentSink() !== null;
}

/**
 * Records a product event for the current request's user and company (or the given actor).
 * Never throws and never blocks: PostHog batches in the background.
 */
export function track(event: AnalyticsEvent, props: AnalyticsProps = {}, actor?: { userId?: string; tenantId?: string }): void {
  try {
    const target = currentSink();
    if (!target || !ANALYTICS_EVENTS.includes(event)) return;
    const ctx = tryGetCtx();
    if (!actor && ctx?.platformAdminId) return; // support session, not product usage
    const userId = actor?.userId ?? ctx?.userId;
    const tenantId = actor?.tenantId ?? ctx?.tenantId;
    if (!userId && !tenantId) return;
    target.capture({
      distinctId: userId ? hashUserId(userId) : `company:${tenantId}`,
      event,
      // source: 'api' (REST) unless the caller says 'sync'; role = THEKEDAR / PM / MUNSHI.
      properties: { source: 'api', ...(ctx?.role ? { role: ctx.role } : {}), ...filterProps(props) },
      ...(tenantId ? { groups: { company: tenantId } } : {}),
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), event }, 'analytics track failed');
  }
}

/** Flushes queued events (on shutdown). */
export async function shutdownAnalytics(): Promise<void> {
  if (sink) await sink.shutdown().catch(() => undefined);
}

/** Tests only: capture into the given sink; `undefined` = back to the env-configured one. */
export function setAnalyticsSinkForTests(next: AnalyticsSink | null | undefined): void {
  sink = next;
}
