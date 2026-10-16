/**
 * PARITY: the default role templates must give every company route exactly the access the old
 * role checks gave. The expectations in parity.snapshot.json were RECORDED from the code before
 * permissions existed (requireRole / requirePermission + the service-level role checks):
 *
 *   PARITY_RECORD=1 npx vitest run tests/permissions/parity.test.ts   (only ever on the old code)
 *
 * Every company route (enumerated from the Express app, not from the docs) is called by each
 * persona with a non-existent id and an empty body; the outcome is "denied" (403 FORBIDDEN /
 * PERMISSION_DENIED / APPROVAL_LIMIT_EXCEEDED) or the status code the request got past the guard
 * with (400 validation, 404 unknown id, 200 list, …). Denied/allowed must match exactly, and so
 * must the status of allowed requests.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ipKeyGenerator } from 'express-rate-limit';
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { listRoutes, type RouteInfo } from '../../src/core/http/routeList.js';
import { generalRateLimit } from '../../src/core/middleware/rateLimit.js';
import { api, app, bearer, loginMobile, loginMunshi, refreshMobile, SEED, useFreshDatabase } from '../helpers.js';

const SNAPSHOT = join(import.meta.dirname, 'parity.snapshot.json');
const RECORD = process.env['PARITY_RECORD'] === '1';
const NO_ID = '0192a000-0000-7000-8000-000000000000';
const PERSONAS = ['MUNSHI', 'PM', 'PM_FIN', 'THEKEDAR'] as const;
type Persona = (typeof PERSONAS)[number];
type Outcome = 'DENIED' | number;
type Snapshot = Record<string, Record<Persona, Outcome>>;

/** Routes that are not company routes (public auth, platform admin, signed file links). */
const NOT_COMPANY = [/^\/api\/v1\/auth\//, /^\/api\/v1\/admin\//, /^\/api\/v1\/invitations\/:token\/accept$/, /^\/api\/v1\/attachments\/:id\/file$/];
export const companyRoutes = (): RouteInfo[] => listRoutes(app).filter((r) => !NOT_COMPANY.some((re) => re.test(r.path)));
const keyOf = (r: RouteInfo) => `${r.method.toUpperCase()} ${r.path}`;
const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED', 'APPROVAL_LIMIT_EXCEEDED']);

/** The general limiter would stop a sweep of ~1 000 requests; reset it between calls. */
function resetLimiter() {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    void generalRateLimit.resetKey(ip);
    void generalRateLimit.resetKey(ipKeyGenerator(ip));
  }
}

async function call(r: RouteInfo, token: string): Promise<Outcome> {
  resetLimiter();
  const path = r.path.replace(/:[A-Za-z]+/g, NO_ID);
  const req = api()[r.method](path).set(bearer(token));
  const res = r.method === 'get' || r.method === 'delete' ? await req : await req.send({});
  if (res.status === 403 && DENIED_CODES.has(res.body?.error?.code)) return 'DENIED';
  return res.status;
}

async function sweep(routes: RouteInfo[], token: string, persona: Persona, out: Snapshot) {
  for (const r of routes) {
    const k = keyOf(r);
    out[k] ??= {} as Record<Persona, Outcome>;
    out[k][persona] = await call(r, token);
  }
}

/** Old-code-compatible way to give the PM financial access (PATCH canSeeFinancials). */
async function grantFinancials(ownerToken: string, pmId: string) {
  const res = await api().patch(`/api/v1/users/${pmId}`).set(bearer(ownerToken)).send({ canSeeFinancials: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe('permission parity (default templates = old role checks)', () => {
  useFreshDatabase();

  it('every company route gives THEKEDAR / PM / PM with financials / MUNSHI the old access', { timeout: 600_000 }, async () => {
    const routes = companyRoutes();
    expect(routes.length).toBeGreaterThan(200);
    const malik = await prismaAdmin.tenant.findUniqueOrThrow({ where: { slug: SEED.malik.slug } });
    const pm = await prismaAdmin.user.findFirstOrThrow({ where: { tenantId: malik.id, phone: SEED.malik.pm.phone } });

    const outcomes: Snapshot = {};
    const munshi = await loginMunshi(malik.id);
    await sweep(routes, munshi.accessToken, 'MUNSHI', outcomes);
    const pmSession = await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password);
    await sweep(routes, pmSession.accessToken, 'PM', outcomes);
    const owner = await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password);
    resetLimiter();
    await grantFinancials(owner.accessToken, pm.id);
    const refreshed = await refreshMobile(pmSession.refreshToken); // the old code put permissions in the token
    expect(refreshed.status).toBe(200);
    await sweep(routes, refreshed.body.data.accessToken, 'PM_FIN', outcomes);
    await sweep(routes, owner.accessToken, 'THEKEDAR', outcomes);

    if (RECORD) {
      writeFileSync(SNAPSHOT, `${JSON.stringify(outcomes, null, 1)}\n`);
      return;
    }
    expect(existsSync(SNAPSHOT), 'parity.snapshot.json is missing').toBe(true);
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
    const problems: string[] = [];
    for (const [route, want] of Object.entries(expected)) {
      const got = outcomes[route];
      if (!got) {
        problems.push(`${route}: route disappeared`);
        continue;
      }
      for (const p of PERSONAS) if (got[p] !== want[p]) problems.push(`${route} ${p}: expected ${want[p]}, got ${got[p]}`);
    }
    const added = Object.keys(outcomes).filter((k) => !expected[k]);
    for (const k of added) if (!NEW_ROUTES[k]) problems.push(`${k}: new route without a parity expectation`);
    for (const [k, want] of Object.entries(NEW_ROUTES)) {
      for (const p of PERSONAS) if (outcomes[k]?.[p] !== want[p]) problems.push(`${k} ${p}: expected ${want[p]}, got ${outcomes[k]?.[p]}`);
    }
    expect(problems).toEqual([]);
  });
});

/** Routes added with permissions (not in the old snapshot): their expected default outcome. */
const owner = (status: Outcome): Record<Persona, Outcome> => ({ MUNSHI: 'DENIED', PM: 'DENIED', PM_FIN: 'DENIED', THEKEDAR: status });
const NEW_ROUTES: Snapshot = {
  'GET /api/v1/permissions/catalog': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'GET /api/v1/roles': owner(200),
  'POST /api/v1/roles': owner(400),
  'GET /api/v1/roles/:id': owner(404),
  'PATCH /api/v1/roles/:id': owner(400),
  'POST /api/v1/roles/:id/duplicate': owner(404),
  'PUT /api/v1/roles/:id/permissions': owner(400),
  'GET /api/v1/users/:id/permissions': owner(404),
  'PUT /api/v1/users/:id/permission-overrides': owner(400),
  'PATCH /api/v1/users/:id/role': owner(400),
  'PUT /api/v1/users/:id/roles': owner(400),
  'GET /api/v1/company/audit-logs': owner(200),
  // Pilot · Part 7 — onboarding: checklist, opening balances, demo (owner), imports (the entity's create permission)
  'GET /api/v1/onboarding/checklist': owner(200),
  'POST /api/v1/onboarding/checklist/dismiss': owner(200),
  'POST /api/v1/onboarding/checklist/rates-reviewed': owner(200),
  'GET /api/v1/opening-balances': owner(200),
  'POST /api/v1/opening-balances': owner(400),
  'POST /api/v1/demo': owner(201),
  'DELETE /api/v1/demo': owner(200),
  ...imports('workers', { MUNSHI: true, PM: true }),
  ...imports('subcontractors', { MUNSHI: false, PM: true }),
  ...imports('suppliers', { MUNSHI: false, PM: true }),
  ...imports('materials', { MUNSHI: false, PM: true }),
  ...imports('clients', { MUNSHI: false, PM: true }),
  // Estimate (BoQ): projects.estimate.view / .manage — Project Manager template (404 = unknown project id), never the Munshi
  'GET /api/v1/projects/:id/estimate': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'PUT /api/v1/projects/:id/estimate/settings': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  // Contract value from the estimate: projects.project.edit + fields.contract + fields.rates (404 = unknown project id)
  'POST /api/v1/projects/:id/contract/from-estimate': { MUNSHI: 'DENIED', PM: 'DENIED', PM_FIN: 404, THEKEDAR: 404 },
  // Walls per room side: projects.project.edit like the other room routes (body {} → 400 walls missing; auto with {} → 404 unknown floor)
  'PUT /api/v1/rooms/:id/walls': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/floors/:id/walls/auto': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  // Step 11 · saved estimates: projects.estimate.view / .manage (404 = unknown id); approve = estimate.revision.approve (owner / Administrator only)
  'POST /api/v1/projects/:id/estimates': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/estimates': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/owner-shopping-list': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/owner-shopping-list/pdf': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/estimates/:a/compare/:b': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/estimates/:id': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/estimates/:id/pdf': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/estimates/:id/regenerate': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'PATCH /api/v1/estimates/:id/lines/:lineId': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/estimates/:id/approve': owner(404),
  // Step 11 · company rulebook: rulebook.override.view (PM template) / .manage (owner, Administrator)
  'GET /api/v1/rulebook': { MUNSHI: 'DENIED', PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'GET /api/v1/rulebook/overrides': { MUNSHI: 'DENIED', PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'PUT /api/v1/rulebook/overrides': owner(400),
  'DELETE /api/v1/rulebook/overrides/:key': owner(404),
  // Step 16 — equipment: view / receiving.create / loss.create (Munshi, PM, Store Keeper), transfer.create + rental.manage (PM), manage + loss.approve (owner / Administrator)
  'GET /api/v1/equipment/balances': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'GET /api/v1/equipment/movements': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'GET /api/v1/equipment/charges': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'POST /api/v1/equipment/accruals/run': owner(200),
  'GET /api/v1/equipment/transfers': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'POST /api/v1/equipment/transfers': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/equipment/transfers/:id': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/equipment/transfers/:id/receive': { MUNSHI: 400, PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/equipment/transfers/:id/cancel': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/equipment/rentals': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'POST /api/v1/equipment/rentals': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/equipment/rentals/:id': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/equipment/rentals/:id/extend': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/equipment/rentals/:id/return': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/equipment/rentals/:id/close': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/equipment/losses': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'POST /api/v1/equipment/losses': { MUNSHI: 400, PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/equipment/losses/:id': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/equipment/losses/:id/charge': owner(400),
  'GET /api/v1/equipment': { MUNSHI: 200, PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'POST /api/v1/equipment': owner(400),
  'GET /api/v1/equipment/:id': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'PATCH /api/v1/equipment/:id': owner(400),
  'POST /api/v1/equipment/:id/stock-in': owner(400),
  'POST /api/v1/equipment/:id/adjust': owner(400),
  'GET /api/v1/projects/:id/equipment': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  // Step 17 · Closeout: Munshi drawing.view + snag.view / create; PM all closeout keys; cost needs fields.amounts; completing the handover projects.project.manage
  'GET /api/v1/projects/:id/drawings': all(404),
  'POST /api/v1/projects/:id/drawings': office(400),
  'GET /api/v1/projects/:id/snags': all(404),
  'POST /api/v1/projects/:id/snags': all(400),
  'GET /api/v1/projects/:id/handover': office(404),
  'PUT /api/v1/projects/:id/handover/items/:key': office(400),
  'POST /api/v1/projects/:id/handover/sign-off': office(400),
  'POST /api/v1/projects/:id/handover/complete': owner(404),
  'GET /api/v1/projects/:id/handover/certificate': office(404),
  'GET /api/v1/projects/:id/retention': office(404),
  'PATCH /api/v1/projects/:id/retention': office(400),
  'GET /api/v1/drawings/:id': all(404),
  'PATCH /api/v1/drawings/:id': office(400),
  'DELETE /api/v1/drawings/:id': office(404),
  'POST /api/v1/drawings/:id/revisions': office(400),
  'PATCH /api/v1/drawing-revisions/:id': office(400),
  'GET /api/v1/snags/:id': all(404),
  'PATCH /api/v1/snags/:id': office(400),
  'DELETE /api/v1/snags/:id': office(404),
  'POST /api/v1/snags/:id/fix': all(404),
  'POST /api/v1/snags/:id/verify': office(404),
  'POST /api/v1/snags/:id/reopen': office(400),
  'PUT /api/v1/snags/:id/cost': { MUNSHI: 'DENIED', PM: 'DENIED', PM_FIN: 400, THEKEDAR: 400 },
  // Step 13 · schedule: schedule.plan.view (Munshi, PM, Accountant) / .plan.manage + .stoppage.approve (PM) / .progress.edit + .stoppage.create (Munshi, PM)
  'GET /api/v1/projects/:id/schedule': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/projects/:id/schedule/generate': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/projects/:id/schedule/replan': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/projects/:id/schedule/baseline': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/schedule/versions': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/schedule/delays': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/schedule/quotas': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/schedule/today': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'GET /api/v1/projects/:id/stoppages': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/projects/:id/stoppages': { MUNSHI: 400, PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/milestones/:id': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'PATCH /api/v1/milestones/:id': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/milestones/:id/progress': { MUNSHI: 400, PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/stoppages/:id': { MUNSHI: 404, PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/stoppages/:id/approve': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/stoppages/:id/reject': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  // Step 12 · quotes: sales.quote.view / .create / .edit (PM template), send also fields.contract (PM_FIN), won = sales.quote.approve (owner / Administrator), delete = .manage; never the Munshi
  'GET /api/v1/quotes/assumptions': { MUNSHI: 'DENIED', PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'GET /api/v1/quotes/insights': { MUNSHI: 'DENIED', PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'POST /api/v1/quotes/preview': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/quotes': { MUNSHI: 'DENIED', PM: 200, PM_FIN: 200, THEKEDAR: 200 },
  'POST /api/v1/quotes': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'GET /api/v1/quotes/:id': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'PATCH /api/v1/quotes/:id': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'DELETE /api/v1/quotes/:id': owner(404),
  'GET /api/v1/quotes/:id/revisions': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/quotes/:id/revisions': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/quotes/:id/send': { MUNSHI: 'DENIED', PM: 'DENIED', PM_FIN: 404, THEKEDAR: 404 },
  'POST /api/v1/quotes/:id/negotiation': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/quotes/:id/lost': { MUNSHI: 'DENIED', PM: 400, PM_FIN: 400, THEKEDAR: 400 },
  'POST /api/v1/quotes/:id/won': owner(404),
  'GET /api/v1/quotes/:id/pdf': { MUNSHI: 'DENIED', PM: 404, PM_FIN: 404, THEKEDAR: 404 },
  // Step 15 · change orders: view / create / edit / approve (PM), manage = billing (owner / Admin / Accountant); site instructions: instruction.create (Munshi, PM; own only) / .view (PM)
  'GET /api/v1/projects/:id/change-orders': office(404),
  'POST /api/v1/projects/:id/change-orders': office(400),
  'GET /api/v1/projects/:id/change-orders/rates': office(404),
  'GET /api/v1/projects/:id/site-instructions': all(404),
  'POST /api/v1/projects/:id/site-instructions': all(400),
  'GET /api/v1/change-orders/:id': office(404),
  'PATCH /api/v1/change-orders/:id': office(400),
  'DELETE /api/v1/change-orders/:id': office(404),
  'POST /api/v1/change-orders/:id/send': office(404),
  'POST /api/v1/change-orders/:id/approve': office(404),
  'POST /api/v1/change-orders/:id/reject': office(400),
  'POST /api/v1/change-orders/:id/reopen': office(404),
  'POST /api/v1/change-orders/:id/start': office(404),
  'POST /api/v1/change-orders/:id/complete': office(404),
  'POST /api/v1/change-orders/:id/bill': owner(400),
  'GET /api/v1/change-orders/:id/pdf': office(404),
  'GET /api/v1/site-instructions/:id': all(404),
  'POST /api/v1/site-instructions/:id/convert': office(404),
  'POST /api/v1/site-instructions/:id/dismiss': office(400),
  'POST /api/v1/snags/:id/change-order': office(404),
};

function all(status: Outcome): Record<Persona, Outcome> {
  return { MUNSHI: status, PM: status, PM_FIN: status, THEKEDAR: status };
}
function office(status: Outcome): Record<Persona, Outcome> {
  return { MUNSHI: 'DENIED', PM: status, PM_FIN: status, THEKEDAR: status };
}

/** Template 200; preview / commit without a file 400 FILE_REQUIRED — for whoever holds the create permission. */
function imports(entity: string, who: { MUNSHI: boolean; PM: boolean }): Snapshot {
  const out = (ok: Outcome): Record<Persona, Outcome> => ({ MUNSHI: who.MUNSHI ? ok : 'DENIED', PM: who.PM ? ok : 'DENIED', PM_FIN: who.PM ? ok : 'DENIED', THEKEDAR: ok });
  return {
    [`GET /api/v1/imports/${entity}/template`]: out(200),
    [`POST /api/v1/imports/${entity}/preview`]: out(400),
    [`POST /api/v1/imports/${entity}/commit`]: out(400),
  };
}

describe('every company route is guarded by a permission', () => {
  /** Things every signed-in company user may do (own data, uploads, static lists, sync with its own per-table rules). */
  const OPEN = new Set([
    'POST /api/v1/attachments',
    'GET /api/v1/attachments/:id',
    'GET /api/v1/company/holidays',
    'GET /api/v1/permissions/catalog',
    'GET /api/v1/material-groups',
    'GET /api/v1/notifications',
    'GET /api/v1/notifications/unread-count',
    'PATCH /api/v1/notifications/read-all',
    'PATCH /api/v1/notifications/:id/read',
    'GET /api/v1/sync/pull',
    'POST /api/v1/sync/push',
    'GET /api/v1/sync/status',
    'GET /api/v1/supply-presets',
  ]);
  it('has a requirePerm unless it is on the open list', () => {
    const unguarded = companyRoutes().filter((r) => !r.permissions.length).map(keyOf);
    expect(unguarded.sort()).toEqual([...OPEN].sort());
  });
});
