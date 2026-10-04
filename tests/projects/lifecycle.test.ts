import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, projectRow, SEED, useFreshDatabase } from '../helpers.js';
import { createDraft, createReadyDraft } from './fixtures.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const usage = async (auth: Record<string, string>) => (await api().get('/api/v1/subscription').set(auth)).body.data.usage.activeProjects.used as number;
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe('review + activation', () => {
  it('a tab-1-only draft lists what is missing; activation is blocked with those errors', async () => {
    const auth = await owner();
    const p = await createDraft(auth);
    const review = await api().get(`/api/v1/projects/${p.id}/review`).set(auth);
    expect(review.status).toBe(200);
    expect(review.body.data.ready).toBe(false);
    expect(codes(review.body.data.errors)).toEqual(
      expect.arrayContaining(['CONTRACT_MISSING', 'BILLING_STAGES_MISSING', 'PLOT_STRUCTURE_MISSING', 'GROUND_FLOOR_MISSING', 'COVERED_AREA_MISSING', 'NO_ROOMS']),
    );
    expect(codes(review.body.data.warnings)).toEqual(expect.arrayContaining(['NO_PM', 'NO_MUNSHI']));

    const blocked = await api().post(`/api/v1/projects/${p.id}/activate`).set(auth);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('PROJECT_NOT_READY');
    expect(codes(blocked.body.error.details.errors)).toContain('NO_ROOMS');
  });

  it('a complete draft activates (ACTIVE, activatedAt, nextStep ESTIMATE) and starts counting against the plan', async () => {
    const auth = await owner();
    const p = await createReadyDraft(auth, { endDate: '2026-12-15' });
    const review = await api().get(`/api/v1/projects/${p.id}/review`).set(auth);
    expect(review.body.data).toMatchObject({ ready: true, errors: [] });
    // 30 × 28 = 840 sq ft of rooms vs 1,000 covered → 16 % apart; schedule 1.5 months
    expect(codes(review.body.data.warnings)).toEqual(expect.arrayContaining(['ROOM_AREA_VS_COVERED', 'SHORT_SCHEDULE']));
    expect(review.body.data.summary).toMatchObject({
      contract: { contractType: 'FULL', contractTotalPaisa: '1100000000', billingStages: 8 },
      plot: { plotAreaSqft: 1125 },
      roomsPerFloor: [{ level: 'GROUND', rooms: 1, totalFloorAreaSqft: 840 }],
      supply: { contractor: 11, owner: 0 },
    });

    const before = await usage(auth);
    const res = await api().post(`/api/v1/projects/${p.id}/activate`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', nextStep: 'ESTIMATE', activatedAt: expect.any(String) });
    expect(await usage(auth)).toBe(before + 1);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'project.activate', entityId: p.id } })).toBe(1);

    const again = await api().post(`/api/v1/projects/${p.id}/activate`).set(auth);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PROJECT_NOT_DRAFT');
  });

  it('plan limit: a Starter company with 2 active projects gets 402', async () => {
    const { ahmed } = seeded();
    const auth = bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);
    while ((await usage(auth)) < 2) await projectRow(ahmed.id, 'Filler site');
    const p = await createReadyDraft(auth);
    const res = await api().post(`/api/v1/projects/${p.id}/activate`).set(auth);
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { resource: 'activeProjects', limit: 2, used: 2 } });
    expect((await prismaAdmin.project.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('DRAFT');
  });

  it('an assigned PM may review and activate; MUNSHI-only routes are not exposed to them', async () => {
    const auth = await pm();
    const p = await createReadyDraft(auth);
    expect((await api().get(`/api/v1/projects/${p.id}/review`).set(auth)).status).toBe(200);
    expect((await api().post(`/api/v1/projects/${p.id}/activate`).set(auth)).status).toBe(200);
  });
});

describe('status transitions', () => {
  async function activeProject(auth: Record<string, string>) {
    const p = await createReadyDraft(auth);
    expect((await api().post(`/api/v1/projects/${p.id}/activate`).set(auth)).status).toBe(200);
    return p;
  }
  const move = (auth: Record<string, string>, id: string, status: string) => api().patch(`/api/v1/projects/${id}/status`).set(auth).send({ status, note: 'Test' });

  it('ACTIVE → CLOSEOUT → ACTIVE (reopen) → CLOSEOUT → HANDED_OVER → CLOSED; others → 409', async () => {
    const auth = await owner();
    const p = await activeProject(auth);
    expect((await move(auth, p.id, 'HANDED_OVER')).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect((await move(auth, p.id, 'CLOSEOUT')).body.data.status).toBe('CLOSEOUT');
    expect((await move(auth, p.id, 'ACTIVE')).body.data.status).toBe('ACTIVE');
    expect((await move(auth, p.id, 'CLOSEOUT')).status).toBe(200);
    expect((await move(auth, p.id, 'HANDED_OVER')).body.data.status).toBe('HANDED_OVER');
    expect((await move(auth, p.id, 'ACTIVE')).status).toBe(409);
    expect((await move(auth, p.id, 'CLOSED')).body.data.status).toBe('CLOSED');
    expect((await move(auth, p.id, 'ACTIVE')).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    const audit = await prismaAdmin.auditLog.findMany({ where: { action: 'project.status_change', entityId: p.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => (a.details as { to: string }).to)).toEqual(['CLOSEOUT', 'ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED']);
  });

  it('only THEKEDAR changes status; DRAFT and READ_ONLY cannot be moved by hand', async () => {
    const auth = await owner();
    const draft = await createDraft(auth);
    expect((await move(auth, draft.id, 'ACTIVE')).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    const dha = seeded().projects.dha.id;
    expect((await move(await pm(), dha, 'CLOSEOUT')).status).toBe(403);
    await prismaAdmin.project.update({ where: { id: dha }, data: { status: 'READ_ONLY' } });
    expect((await move(auth, dha, 'ACTIVE')).status).toBe(409);
  });

  it('CLOSEOUT still counts against the plan; HANDED_OVER does not', async () => {
    const auth = await owner();
    const p = await activeProject(auth);
    const active = await usage(auth);
    await move(auth, p.id, 'CLOSEOUT');
    expect(await usage(auth)).toBe(active);
    await move(auth, p.id, 'HANDED_OVER');
    expect(await usage(auth)).toBe(active - 1);
  });

  it('HANDED_OVER, CLOSED, CLOSEOUT and READ_ONLY projects reject wizard and room edits → 409 PROJECT_LOCKED', async () => {
    const auth = await owner();
    const p = await activeProject(auth);
    const edits = async () => [
      await api().patch(`/api/v1/projects/${p.id}/basic`).set(auth).send({ name: 'Locked?' }),
      await api().patch(`/api/v1/projects/${p.id}/coverage`).set(auth).send({ coveredAreaSqft: 1200, boundaryWall: false }),
      await api().post(`/api/v1/floors/${p.groundFloorId}/rooms`).set(auth).send({ type: 'STORE', lengthFt: 6, widthFt: 5 }),
      await api().patch(`/api/v1/rooms/${p.roomId}`).set(auth).send({ name: 'Locked?' }),
    ];
    // ACTIVE is editable
    expect((await edits()).map((r) => r.status)).toEqual([200, 200, 201, 200]);

    for (const status of ['CLOSEOUT', 'HANDED_OVER', 'CLOSED', 'READ_ONLY'] as const) {
      await prismaAdmin.project.update({ where: { id: p.id }, data: { status } });
      const results = await edits();
      expect(results.map((r) => r.status), status).toEqual([409, 409, 409, 409]);
      expect(results.every((r) => r.body.error.code === 'PROJECT_LOCKED')).toBe(true);
    }
  });
});
