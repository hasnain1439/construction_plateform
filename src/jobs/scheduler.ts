import pg from 'pg';
import { env, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';
import { runSubscriptionLifecycle } from './subscriptionLifecycle.js';

/** Karachi is UTC+5 all year (no DST). */
const PKT_OFFSET_MS = 5 * 3_600_000;
const DAY = 86_400_000;

/** Milliseconds until the next `hour`:00 Asia/Karachi. */
export function msUntilNextPkt(hour: number, now = new Date()): number {
  const pkt = new Date(now.getTime() + PKT_OFFSET_MS);
  const next = Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate(), hour) - PKT_OFFSET_MS;
  return next > now.getTime() ? next - now.getTime() : next + DAY - now.getTime();
}

/**
 * Runs `fn` only if this process wins `pg_try_advisory_lock(name)` on a dedicated
 * connection, so several API instances never run the same job at once. Returns
 * undefined when another instance holds the lock.
 */
export async function runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`job:${name}`]);
    if (!rows[0]?.locked) {
      logger.info({ job: name }, 'job already running elsewhere — skipped');
      return undefined;
    }
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`job:${name}`]);
    }
  } finally {
    await client.end();
  }
}

export async function runSubscriptionJob(): Promise<void> {
  const started = Date.now();
  try {
    const result = await runExclusive('subscription-lifecycle', () => runSubscriptionLifecycle());
    if (result) {
      logger.info(
        {
          job: 'subscription-lifecycle',
          ms: Date.now() - started,
          downgraded: result.downgraded.length,
          trialLapsed: result.trialLapsed.length,
          graceStarted: result.graceStarted.length,
          lapsed: result.lapsed.length,
          reminded: result.reminded.length,
        },
        'subscription lifecycle finished',
      );
    }
  } catch (err) {
    logger.error({ err, job: 'subscription-lifecycle' }, 'subscription lifecycle failed');
  }
}

const timers: NodeJS.Timeout[] = [];

/** On startup + daily at 02:00 Asia/Karachi. Disabled in tests. */
export function startScheduledJobs(): void {
  if (isTest) return;
  timers.push(setTimeout(() => void runSubscriptionJob(), 5_000).unref());
  const scheduleNext = () => {
    const wait = msUntilNextPkt(2);
    timers.push(
      setTimeout(() => {
        void runSubscriptionJob().finally(scheduleNext);
      }, wait).unref(),
    );
    logger.info({ job: 'subscription-lifecycle', nextRunInMinutes: Math.round(wait / 60_000) }, 'job scheduled');
  };
  scheduleNext();
}

export function stopScheduledJobs(): void {
  for (const t of timers.splice(0)) clearTimeout(t);
}
