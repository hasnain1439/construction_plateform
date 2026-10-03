import { readFileSync } from 'node:fs';
import { env } from '../../config/env.js';
import { prismaAdmin } from '../../core/db/prisma.js';
import { mailProvider } from '../auth/mail.provider.js';
import { smsProvider } from '../auth/sms.provider.js';
import { storage } from '../attachments/storage.provider.js';

const DAY = 86_400_000;

const version: string = (() => {
  try {
    // src/modules/platform-admin → project root (same depth from dist/)
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

/** "2026-10" for a date in Pakistan time. */
function monthKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).format(date).slice(0, 7);
}

/** The last 12 month keys, oldest first, ending with the current month (PKT). */
function last12Months(now: Date): string[] {
  const [y, m] = monthKey(now).split('-').map(Number) as [number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (11 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export async function getOverview(now = new Date()) {
  const db = prismaAdmin;
  const live = { status: 'ACTIVE' as const };
  const [activeCompanies, trialCompanies, graceCompanies, readOnlyCompanies, suspendedCompanies] = [
    await db.subscription.count({ where: { status: 'ACTIVE', tenant: live } }),
    await db.subscription.count({ where: { status: 'TRIAL', tenant: live } }),
    await db.subscription.count({ where: { status: 'GRACE', tenant: live } }),
    await db.tenant.count({ where: { status: 'READ_ONLY' } }),
    await db.tenant.count({ where: { status: 'SUSPENDED' } }),
  ];

  const mrrRows = await db.$queryRaw<Array<{ mrr: bigint | null }>>`
    SELECT sum(p."priceMonthlyPaisa")::bigint AS mrr
    FROM "Subscription" s JOIN "Plan" p ON p.id = s."planId"
    WHERE s.status IN ('ACTIVE', 'GRACE')`;

  const paymentsAwaitingReview = await db.subscriptionPayment.count({ where: { status: 'PENDING_REVIEW' } });
  const trialsEndingThisWeek = await db.subscription.count({
    where: { status: 'TRIAL', trialEndsAt: { gt: now, lte: new Date(now.getTime() + 7 * DAY) } },
  });

  const byPlan = await db.subscription.groupBy({ by: ['planId'], _count: { _all: true } });
  const plans = await db.plan.findMany({ where: { id: { in: byPlan.map((b) => b.planId) } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  const planDistribution = plans.map((p) => ({ planCode: p.code, count: byPlan.find((b) => b.planId === p.id)!._count._all }));

  const months = last12Months(now);
  const revenue = await db.$queryRaw<Array<{ month: string; amount: bigint }>>`
    SELECT to_char(date_trunc('month', "paidOn"), 'YYYY-MM') AS month, sum("amountPaisa")::bigint AS amount
    FROM "SubscriptionPayment"
    WHERE status = 'APPROVED' AND "paidOn" >= ${new Date(`${months[0]}-01T00:00:00.000Z`)}
    GROUP BY 1`;
  const revenueByMonth = months.map((month) => ({
    month,
    amountPaisa: (revenue.find((r) => r.month === month)?.amount ?? 0n).toString(),
  }));

  return {
    activeCompanies,
    trialCompanies,
    graceCompanies,
    readOnlyCompanies,
    suspendedCompanies,
    mrrPaisa: (mrrRows[0]?.mrr ?? 0n).toString(),
    paymentsAwaitingReview,
    trialsEndingThisWeek,
    planDistribution,
    revenueByMonth,
  };
}

export async function getHealth() {
  const started = performance.now();
  let database: { ok: boolean; latencyMs: number; error?: string };
  try {
    await prismaAdmin.$queryRaw`SELECT 1`;
    database = { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch (err) {
    database = { ok: false, latencyMs: Math.round(performance.now() - started), error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' };
  }
  const job = await prismaAdmin.jobRun.findUnique({ where: { name: 'subscription-lifecycle' } }).catch(() => null);
  return {
    api: { ok: true },
    database,
    smsProvider: smsProvider().name,
    mailProvider: mailProvider().name,
    storageProvider: storage().name,
    version,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    jobs: {
      subscriptionLifecycle: job
        ? {
            lastRunAt: job.lastStartedAt.toISOString(),
            lastFinishedAt: job.lastFinishedAt?.toISOString() ?? null,
            lastStatus: job.lastStatus,
            lastError: job.lastError,
          }
        : { lastRunAt: null, lastFinishedAt: null, lastStatus: 'NEVER_RAN', lastError: null },
    },
  };
}
