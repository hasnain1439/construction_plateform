import { prismaAdmin } from '../core/db/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Records start / finish / failure of a background job in JobRun (shown on
 * GET /admin/health). Works the same from the in-process scheduler and the CLI.
 */
export async function trackJobRun<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date();
  await prismaAdmin.jobRun.upsert({
    where: { name },
    create: { name, lastStartedAt: startedAt, lastStatus: 'RUNNING' },
    update: { lastStartedAt: startedAt, lastStatus: 'RUNNING', lastError: null },
  });
  try {
    const result = await fn();
    await prismaAdmin.jobRun.update({
      where: { name },
      data: { lastFinishedAt: new Date(), lastStatus: 'SUCCESS', lastResult: summarise(result) },
    });
    return result;
  } catch (err) {
    await prismaAdmin.jobRun.update({
      where: { name },
      data: { lastFinishedAt: new Date(), lastStatus: 'FAILED', lastError: err instanceof Error ? err.message.slice(0, 500) : String(err) },
    });
    throw err;
  }
}

/** Arrays of tenant ids become counts, so the row stays small. */
function summarise(result: unknown): Prisma.InputJsonValue {
  if (!result || typeof result !== 'object') return {};
  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Array.isArray(v) ? v.length : String(v)]));
}

/** Last status of every tracked job (GET /health/ready). Throws if the database is unreachable. */
export async function jobRunSummary(): Promise<Array<{ name: string; lastStatus: string; lastFinishedAt: string | null }>> {
  const rows = await prismaAdmin.jobRun.findMany({ orderBy: { name: 'asc' }, select: { name: true, lastStatus: true, lastFinishedAt: true } });
  return rows.map((r) => ({ name: r.name, lastStatus: r.lastStatus, lastFinishedAt: r.lastFinishedAt?.toISOString() ?? null }));
}
