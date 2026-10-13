import * as Sentry from '@sentry/node';
import { env, type Env } from '../../config/env.js';
import { scrubBreadcrumb, scrubEvent, type ScrubbableBreadcrumb, type ScrubbableEvent } from './scrub.js';
import { setSentrySdk } from './sentryScope.js';

// The middlewares use these through sentryScope.ts, which does not load the SDK itself.
export { captureError, tagSentryScope } from './sentryScope.js';

/** scrub.ts is typed structurally (no Sentry import); Sentry's event types are narrower. */
const scrubbed = <T>(event: T): T => scrubEvent(event as unknown as ScrubbableEvent) as unknown as T;

/**
 * Sentry error + performance monitoring. Off unless SENTRY_DSN is set: with no DSN,
 * `Sentry.init` is never called and every helper here is a no-op.
 *
 * Full auto-instrumentation (Express, http, pg spans) needs Sentry to load before Express:
 * `npm start` runs `node --import ./dist/instrument.js`. `server.ts` also imports
 * `instrument.ts` first, so errors are always reported even without the flag.
 */

let enabled = false;

/** Liveness / readiness probes are never traced. */
const IGNORED_TRANSACTIONS = [/\/health(\/ready)?$/];

export type SentryConfig = Pick<Env, 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'SENTRY_RELEASE' | 'SENTRY_TRACES_SAMPLE_RATE' | 'NODE_ENV'>;

export function sentryOptions(config: SentryConfig): Sentry.NodeOptions {
  return {
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.SENTRY_RELEASE,
    // Whole transactions (not streamed spans) so beforeSendTransaction can scrub every span.
    traceLifecycle: 'static',
    tracesSampler:({ name, inheritOrSampleWith }) =>
      IGNORED_TRANSACTIONS.some((re) => re.test(name)) ? 0 : inheritOrSampleWith(config.SENTRY_TRACES_SAMPLE_RATE),
    // Collect as little as possible (no user info, cookies, bodies, query strings, SQL values,
    // local variables); scrubEvent below is the second line of defence.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    includeLocalVariables: false,
    serverName: 'construction-api',
    beforeSend: (event) => scrubbed(event),
    beforeSendTransaction: (event) => scrubbed(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb as ScrubbableBreadcrumb) as typeof crumb,
  };
}

/**
 * Initialises Sentry once. Returns false (and does nothing) when SENTRY_DSN is empty.
 * `extra` lets tests plug in a transport.
 */
export function initSentry(config: SentryConfig = env, extra: Partial<Sentry.NodeOptions> = {}): boolean {
  if (enabled) return true;
  if (!config.SENTRY_DSN) return false;
  Sentry.init({ ...sentryOptions(config), ...extra });
  setSentrySdk(Sentry);
  enabled = true;
  return true;
}

export function sentryEnabled(): boolean {
  return enabled;
}

/** Sends queued events before the process exits. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}

/** Tests only: shuts the client down so another test can initialise again. */
export async function closeSentryForTests(): Promise<void> {
  if (!enabled) return;
  await Sentry.close(1000);
  setSentrySdk(undefined);
  enabled = false;
}
