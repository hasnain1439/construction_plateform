/**
 * Step 18 · performance check. Warm response times of the heavy read endpoints on the full
 * Malik & Sons demo (`malik_reports`: stock, labour, billing, schedule + control, equipment,
 * closeout, change orders). Target < 500 ms each (dashboard / finance / control / reports /
 * estimate / schedule). The test fails only above 1500 ms so a loaded PC does not turn it red;
 * the numbers are logged (`PERF <ms> <queries> <path>`, median of 3 warm calls; `queries` = SQL
 * statements of one call) for the progress log.
 * The dashboard cache is off in tests, so every call measures the real work.
 */
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, loginMobile, SEED, useFreshDatabase, withSeedSnapshot } from '../helpers.js';

// SQL statements per request (BEGIN / SET / COMMIT included): wraps pg's Client.query.
let queries = 0;
const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
const original = proto.query;
proto.query = function (this: unknown, ...args: unknown[]) {
  queries += 1;
  return original.apply(this, args);
};

const seeded = useFreshDatabase();
const LIMIT_MS = 1500;
const RUNS = 3;

let auth: Record<string, string>;
beforeEach(async () => {
  await withSeedSnapshot('malik_reports', seeded());
  auth = bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
});

function paths(): string[] {
  const dha = seeded().projects.dha.id;
  const johar = seeded().projects.johar.id;
  const reports = ['project-summary', 'material-audit', 'labor-peshgi', 'cash-book', 'supplier-ageing', 'receivables-ageing', 'stock-valuation', 'delay-analysis', 'variance', 'change-orders', 'equipment-utilisation', 'snags'];
  return [
    '/dashboard/overview',
    `/dashboard/site/${dha}`,
    '/finance/pnl',
    '/finance/receivables',
    '/finance/cash-flow',
    '/finance/cash-floats',
    '/receivables',
    `/projects/${dha}/receivables`,
    '/control/summary',
    '/control/alerts',
    `/projects/${dha}/control/material-variance`,
    `/projects/${dha}/control/cost-variance`,
    `/projects/${dha}/control/burn-rate`,
    `/projects/${dha}/control/delay-analysis`,
    `/projects/${johar}/control/cost-variance`,
    ...reports.map((r) => `/reports/${r}`),
    `/reports/delay-analysis/${dha}`,
    `/reports/variance/${dha}`,
    `/reports/snags/${johar}`,
    `/projects/${dha}/estimate`,
    `/projects/${dha}/schedule`,
    `/projects/${dha}/schedule/delays`,
  ];
}

describe('performance (warm, seed)', () => {
  it('every heavy read endpoint answers well under the limit', async () => {
    const results: Array<{ path: string; ms: number; queries: number }> = [];
    for (const path of paths()) {
      const url = `/api/v1${path}`;
      const warm = await api().get(url).set(auth);
      expect(warm.status, `${path}: ${JSON.stringify(warm.body).slice(0, 300)}`).toBe(200);
      const times: number[] = [];
      let count = 0;
      for (let i = 0; i < RUNS; i++) {
        queries = 0;
        const t0 = performance.now();
        const res = await api().get(url).set(auth);
        times.push(performance.now() - t0);
        count = queries;
        expect(res.status).toBe(200);
      }
      times.sort((a, b) => a - b);
      results.push({ path, ms: Math.round(times[Math.floor(RUNS / 2)]!), queries: count });
    }
    for (const r of results) console.log(`PERF ${String(r.ms).padStart(5)} ms ${String(r.queries).padStart(4)} q  ${r.path.replace(/[0-9a-f-]{36}/g, ':id')}`);
    const slow = results.filter((r) => r.ms > LIMIT_MS);
    expect(slow, `slower than ${LIMIT_MS} ms`).toEqual([]);
  });
});
