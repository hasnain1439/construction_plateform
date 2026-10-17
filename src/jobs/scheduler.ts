import pg from 'pg';
import { env, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';
import { trackJobRun } from './jobRuns.js';
import { runBillingOverdueCheck } from './billingOverdue.js';
import { runEquipmentAccrual } from './equipmentAccrual.js';
import { runEquipmentIdleCheck } from './equipmentIdle.js';
import { runMissingLogCheck } from './missingLogs.js';
import { runSyncRetention } from './syncRetention.js';
import { runSubscriptionLifecycle } from './subscriptionLifecycle.js';
import { runRetentionReminders } from './retentionReminders.js';
import { runQuoteExpiry } from './quoteExpiry.js';
import { runControlAlerts } from './controlAlerts.js';

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
    const result = await runExclusive('subscription-lifecycle', () => trackJobRun('subscription-lifecycle', () => runSubscriptionLifecycle()));
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

export async function runBillingJob(): Promise<void> {
  try {
    const result = await runExclusive('billing-overdue', () => trackJobRun('billing-overdue', () => runBillingOverdueCheck()));
    if (result) logger.info({ job: 'billing-overdue', checked: result.checked, marked: result.marked.length }, 'billing overdue check finished');
  } catch (err) {
    logger.error({ err, job: 'billing-overdue' }, 'billing overdue check failed');
  }
}

/** Every 15 minutes: the missing daily-log check (each company at its own alert time). */
export async function runMissingLogJob(): Promise<void> {
  try {
    const result = await runExclusive('missing-logs', () => runMissingLogCheck());
    if (result?.sent.length) logger.info({ job: 'missing-logs', checked: result.checked, sent: result.sent.length }, 'missing daily-log alerts sent');
  } catch (err) {
    logger.error({ err, job: 'missing-logs' }, 'missing daily-log check failed');
  }
}

/** Daily 03:00 PKT: drops sync change rows older than 30 days. */
export async function runSyncRetentionJob(): Promise<void> {
  try {
    const result = await runExclusive('sync-retention', () => trackJobRun('sync-retention', () => runSyncRetention()));
    if (result) logger.info({ job: 'sync-retention', deleted: result.deleted }, 'sync retention finished');
  } catch (err) {
    logger.error({ err, job: 'sync-retention' }, 'sync retention failed');
  }
}

/** Daily 01:30 PKT: yesterday's equipment hire and rent (Step 16). */
export async function runEquipmentAccrualJob(): Promise<void> {
  try {
    const result = await runExclusive('equipment-accrual', () => trackJobRun('equipment-accrual', () => runEquipmentAccrual()));
    if (result) logger.info({ job: 'equipment-accrual', companies: result.companies, rows: result.rows }, 'equipment accrual finished');
  } catch (err) {
    logger.error({ err, job: 'equipment-accrual' }, 'equipment accrual failed');
  }
}

/** Daily 09:00 PKT: idle rented equipment (no milestone activity at the site for N days) → EQUIPMENT_IDLE (Step 16). */
export async function runEquipmentIdleJob(): Promise<void> {
  try {
    const result = await runExclusive('equipment-idle', () => trackJobRun('equipment-idle', () => runEquipmentIdleCheck()));
    if (result) logger.info({ job: 'equipment-idle', companies: result.companies, idle: result.idle, notified: result.notified }, 'equipment idle check finished');
  } catch (err) {
    logger.error({ err, job: 'equipment-idle' }, 'equipment idle check failed');
  }
}

/** Daily 02:45 PKT: retention release reminders (Step 17 closeout). */
export async function runRetentionJob(): Promise<void> {
  try {
    const result = await runExclusive('retention-reminders', () => trackJobRun('retention-reminders', () => runRetentionReminders()));
    if (result) logger.info({ job: 'retention-reminders', checked: result.checked, reminders: result.reminders.length, due: result.due.length }, 'retention reminders finished');
  } catch (err) {
    logger.error({ err, job: 'retention-reminders' }, 'retention reminders failed');
  }
}

/** Daily 01:00 PKT: SENT / NEGOTIATION quotes past their validity → EXPIRED (Step 12). */
export async function runQuoteExpiryJob(): Promise<void> {
  try {
    const result = await runExclusive('quote-expiry', () => trackJobRun('quote-expiry', () => runQuoteExpiry()));
    if (result) logger.info({ job: 'quote-expiry', checked: result.checked, expired: result.expired.length }, 'quote expiry finished');
  } catch (err) {
    logger.error({ err, job: 'quote-expiry' }, 'quote expiry failed');
  }
}

/** Daily 06:30 PKT: control alerts — variance, behind plan, quotas, spend ahead (Step 14). */
export async function runControlAlertsJob(): Promise<void> {
  try {
    const result = await runExclusive('control-alerts', () => trackJobRun('control-alerts', () => runControlAlerts()));
    if (result) logger.info({ job: 'control-alerts', companies: result.companies.length, projects: result.projects, opened: result.opened, resolved: result.resolved, notified: result.notified, failed: result.failed }, 'control alerts finished');
  } catch (err) {
    logger.error({ err, job: 'control-alerts' }, 'control alerts failed');
  }
}

const timers: NodeJS.Timeout[] = [];

/** On startup + daily at 02:00 Asia/Karachi. Disabled in tests. */
export function startScheduledJobs(): void {
  if (isTest) return;
  timers.push(setTimeout(() => void runSubscriptionJob(), 5_000).unref());
  timers.push(setTimeout(() => void runBillingJob(), 15_000).unref());
  const scheduleBilling = () => {
    const wait = msUntilNextPkt(2) + 30 * 60_000;
    timers.push(setTimeout(() => void runBillingJob().finally(scheduleBilling), wait).unref());
  };
  scheduleBilling();
  timers.push(setInterval(() => void runMissingLogJob(), 15 * 60_000).unref());
  const scheduleRetention = () => {
    timers.push(setTimeout(() => void runSyncRetentionJob().finally(scheduleRetention), msUntilNextPkt(3)).unref());
  };
  scheduleRetention();
  const scheduleEquipment = () => {
    timers.push(setTimeout(() => void runEquipmentAccrualJob().finally(scheduleEquipment), msUntilNextPkt(1) + 30 * 60_000).unref());
  };
  scheduleEquipment();
  const scheduleEquipmentIdle = () => {
    timers.push(setTimeout(() => void runEquipmentIdleJob().finally(scheduleEquipmentIdle), msUntilNextPkt(9)).unref());
  };
  scheduleEquipmentIdle();
  const scheduleRetentionReminders = () => {
    timers.push(setTimeout(() => void runRetentionJob().finally(scheduleRetentionReminders), msUntilNextPkt(2) + 45 * 60_000).unref());
  };
  scheduleRetentionReminders();
  const scheduleQuoteExpiry = () => {
    timers.push(setTimeout(() => void runQuoteExpiryJob().finally(scheduleQuoteExpiry), msUntilNextPkt(1)).unref());
  };
  scheduleQuoteExpiry();
  const scheduleControlAlerts = () => {
    timers.push(setTimeout(() => void runControlAlertsJob().finally(scheduleControlAlerts), msUntilNextPkt(6) + 30 * 60_000).unref());
  };
  scheduleControlAlerts();
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

/** For GET /health/ready: whether this process runs the in-process job scheduler. */
export function schedulerStatus(): { enabled: boolean; running: boolean } {
  return { enabled: !isTest, running: timers.length > 0 };
}
