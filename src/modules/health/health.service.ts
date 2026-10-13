import { prisma } from '../../core/db/prisma.js';
import { jobRunSummary } from '../../jobs/jobRuns.js';
import { schedulerStatus } from '../../jobs/scheduler.js';
import { storage } from '../attachments/storage.provider.js';

/**
 * Readiness checks for GET /health/ready. Each check has a time budget; a failing check
 * reports only an error *code* (never a connection string, host or stack).
 */

export interface CheckResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  [key: string]: unknown;
}

export interface Readiness {
  status: 'ok' | 'fail';
  checks: {
    database: CheckResult;
    storage: CheckResult & { provider: string; cached?: boolean };
    scheduler: CheckResult & { enabled: boolean; running: boolean; jobs?: Array<{ name: string; lastStatus: string; lastFinishedAt: string | null }> };
  };
}

const CHECK_TIMEOUT_MS = 3000;
/** Storage probes (S3 HeadBucket / Cloudinary Admin API ping) are cached so frequent probes stay cheap. */
const STORAGE_CACHE_MS = 30_000;

class CheckTimeout extends Error {
  constructor() {
    super('timeout');
    this.name = 'TIMEOUT';
  }
}

function withTimeout<T>(promise: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeout()), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A short, safe label for an error: Prisma / AWS / Node codes or the error class name. */
export function errorLabel(err: unknown): string {
  if (err instanceof CheckTimeout) return 'TIMEOUT';
  const e = err as { code?: unknown; name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } } | null;
  const code = typeof e?.code === 'string' ? e.code : typeof e?.Code === 'string' ? e.Code : undefined;
  const status = e?.$metadata?.httpStatusCode;
  const label = code ?? (typeof e?.name === 'string' && e.name !== 'Error' ? e.name : 'ERROR');
  return (status ? `${label} (${status})` : label).slice(0, 80);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; latencyMs: number; value: T } | { ok: false; latencyMs: number; error: string }> {
  const started = performance.now();
  const ms = () => Math.round((performance.now() - started) * 10) / 10;
  try {
    const value = await withTimeout(fn());
    return { ok: true, latencyMs: ms(), value };
  } catch (err) {
    return { ok: false, latencyMs: ms(), error: errorLabel(err) };
  }
}

async function checkDatabase(): Promise<CheckResult> {
  const result = await timed(() => prisma.$queryRaw`SELECT 1`);
  return result.ok ? { ok: true, latencyMs: result.latencyMs } : { ok: false, latencyMs: result.latencyMs, error: result.error };
}

let storageCache: { at: number; result: Readiness['checks']['storage'] } | undefined;

async function checkStorage(now = Date.now()): Promise<Readiness['checks']['storage']> {
  const provider = storage();
  if (storageCache && storageCache.result.provider === provider.name && now - storageCache.at < STORAGE_CACHE_MS) {
    return { ...storageCache.result, cached: true };
  }
  if (!provider.healthCheck) return { ok: true, latencyMs: 0, provider: provider.name, skipped: true };
  const result = await timed(() => provider.healthCheck!());
  const out: Readiness['checks']['storage'] = result.ok
    ? { ok: true, latencyMs: result.latencyMs, provider: provider.name }
    : { ok: false, latencyMs: result.latencyMs, provider: provider.name, error: result.error };
  storageCache = { at: now, result: out };
  return out;
}

/**
 * The in-process scheduler (no external queue). Job failures are reported but don't make the
 * API unready; an unreachable admin connection pool (auth, jobs) does.
 */
async function checkScheduler(): Promise<Readiness['checks']['scheduler']> {
  const status = schedulerStatus();
  const result = await timed(() => jobRunSummary());
  return result.ok
    ? { ok: true, latencyMs: result.latencyMs, ...status, jobs: result.value }
    : { ok: false, latencyMs: result.latencyMs, ...status, error: result.error };
}

export async function readiness(): Promise<Readiness> {
  // Different services / connection pools and no transaction, so the checks may overlap.
  const [database, storageCheck, scheduler] = await Promise.all([checkDatabase(), checkStorage(), checkScheduler()]);
  const ok = database.ok && storageCheck.ok && scheduler.ok;
  return { status: ok ? 'ok' : 'fail', checks: { database, storage: storageCheck, scheduler } };
}

/** Tests only. */
export function resetReadinessCacheForTests(): void {
  storageCache = undefined;
}
