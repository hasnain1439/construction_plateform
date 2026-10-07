import { beforeEach, describe, expect, it } from 'vitest';
import { seedMalikInventory } from '../../prisma/seedInventory.js';
import { seedMalikLabor } from '../../prisma/seedLabor.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { uuidv7 } from '../../src/core/utils/uuid.js';
import { bearer, loginMunshi, useFreshDatabase } from '../helpers.js';
import { api, owner, today } from '../labor/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  const s = seeded();
  const base = { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, projects: s.projects };
  await seedMalikInventory(prismaAdmin, base);
  await seedMalikLabor(prismaAdmin, { ...base, asifId: s.users.asif.id });
});

const DAY = 86_400_000;
const m = (type: string, payload: Record<string, unknown>, madeAgoMs: number) => ({ clientId: uuidv7(), type, payload, deviceCreatedAt: new Date(Date.now() - madeAgoMs).toISOString() });

describe('📱 late sync on the REST screens', () => {
  it('hazri, kharcha and a dispatch receipt pushed 3 days after they were made are flagged; fresh ones are not', async () => {
    const s = seeded();
    const dha = s.projects.dha.id;
    const auth = bearer((await loginMunshi(s.malik.id)).accessToken);
    const [late, fresh] = await prismaAdmin.projectWorker.findMany({ where: { tenantId: s.malik.id, projectId: dha, isActive: true }, take: 2, orderBy: { id: 'asc' } });
    const dispatch = await prismaAdmin.dispatch.findFirstOrThrow({ where: { tenantId: s.malik.id, status: 'ON_THE_WAY', toLocation: { projectId: dha } }, include: { items: true } });

    const res = await api()
      .post('/api/v1/sync/push')
      .set(auth)
      .send({
        mutations: [
          m('ATTENDANCE_UPSERT', { projectId: dha, date: today(), entries: [{ workerId: late!.workerId, status: 'FULL' }] }, 3 * DAY),
          m('ATTENDANCE_UPSERT', { projectId: dha, date: today(), entries: [{ workerId: fresh!.workerId, status: 'HALF' }] }, 60_000),
          m('CASH_EXPENSE_CREATE', { projectId: dha, category: 'TEA_WATER', amountPaisa: '30000', description: 'Chai (late)' }, 3 * DAY),
          m('DISPATCH_RECEIVE', { dispatchId: dispatch.id, items: dispatch.items.map((i) => ({ materialId: i.materialId, receivedQty: i.sentQty.toString() })) }, 3 * DAY),
        ],
      });
    expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);

    const day = await api().get(`/api/v1/projects/${dha}/attendance/today`).set(await owner());
    const flag = (workerId: string) => day.body.data.workers.find((w: { worker: { id: string } }) => w.worker.id === workerId).lateSync;
    expect([flag(late!.workerId), flag(fresh!.workerId)]).toEqual([true, false]);
    const grid = await api().get(`/api/v1/projects/${dha}/attendance`).set(await owner());
    const row = grid.body.data.workers.find((w: { worker: { id: string } }) => w.worker.id === late!.workerId);
    expect(row.days[today()].lateSync).toBe(true);

    const expenses = await api().get('/api/v1/cash-expenses').set(await owner());
    const chai = expenses.body.data.find((e: { description: string }) => e.description === 'Chai (late)');
    expect(chai.lateSync).toBe(true);
    expect(expenses.body.data.filter((e: { lateSync: boolean }) => e.lateSync)).toHaveLength(1);

    const gp = await api().get(`/api/v1/dispatches/${dispatch.id}`).set(await owner());
    expect(gp.body.data).toMatchObject({ status: 'RECEIVED', lateSync: true });
  });
});
