import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { notify, type NotifyInput } from '../../src/modules/notifications/notifications.service.js';
import { lastSmsTo } from '../../src/modules/auth/sms.provider.js';
import { useFreshDatabase } from '../helpers.js';
import { api, munshi, owner, pm } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();

const send = (input: Partial<NotifyInput> & Pick<NotifyInput, 'recipients' | 'type'>) =>
  prismaAdmin.$transaction((tx) =>
    notify(tx, {
      tenantId: seeded().malik.id,
      severity: 'INFO',
      title: 'Test',
      body: 'Body',
      ref: { type: 'TEST', id: seeded().projects.dha.id },
      actorId: null,
      ...input,
    }),
  );

const names = async (ids: string[]) => (await prismaAdmin.user.findMany({ where: { id: { in: ids } }, select: { name: true } })).map((u) => u.name).sort();

describe('notify()', () => {
  it('dedupes the same (type, ref, user) within 24 h', async () => {
    const at = new Date('2026-10-01T05:00:00Z');
    expect(await send({ recipients: ['THEKEDAR'], type: 'LOW_STOCK', at })).toHaveLength(1);
    expect(await send({ recipients: ['THEKEDAR'], type: 'LOW_STOCK', at: new Date(at.getTime() + 23 * 3_600_000) })).toEqual([]);
    expect(await send({ recipients: ['THEKEDAR'], type: 'SHORTAGE_CREATED', at })).toHaveLength(1); // another type
    expect(await send({ recipients: ['THEKEDAR'], type: 'LOW_STOCK', at: new Date(at.getTime() + 25 * 3_600_000) })).toHaveLength(1);
    expect(await prismaAdmin.notification.count({ where: { type: 'LOW_STOCK' } })).toBe(2);
  });

  it('resolves recipients by role and project; skips the actor unless critical', async () => {
    const s = seeded();
    const dha = s.projects.dha.id;
    expect(await names(await send({ recipients: [{ projectRoles: ['PM', 'MUNSHI'], projectId: dha }], type: 'DISPATCH_CREATED' }))).toEqual(['Bilal Ahmed', 'Rafaqat Ali']);
    expect(await names(await send({ recipients: [{ projectRoles: ['MUNSHI'], projectId: s.projects.bahria.id }], type: 'DISPATCH_CREATED', ref: { type: 'T', id: s.projects.bahria.id } }))).toEqual(['Asif Mehmood']);
    expect(await names(await send({ recipients: ['THEKEDAR', { userIds: [s.users.bilal.id] }], type: 'SETTLEMENT_SUBMITTED', actorId: s.users.bilal.id }))).toEqual(['Khalid Malik']);
    // Another company's users are never reached.
    expect(await send({ recipients: [{ userIds: [s.users.rafaqatAhmed.id] }], type: 'DISPATCH_CREATED', ref: { type: 'T', id: s.projects.johar.id } })).toEqual([]);
  });

  it('a MUNSHI never gets money notifications; a PM without financials gets no billing ones', async () => {
    const s = seeded();
    const team = { projectRoles: ['PM', 'MUNSHI'] as const, projectId: s.projects.dha.id };
    for (const type of ['EXPENSE_PENDING_APPROVAL', 'SETTLEMENT_SUBMITTED', 'SHORTAGE_CREATED', 'MEASUREMENT_RECORDED', 'SUBCONTRACTOR_OVERPAID'] as const) {
      expect(await names(await send({ recipients: [{ ...team, projectRoles: [...team.projectRoles] }], type }))).toEqual(['Bilal Ahmed']);
    }
    const bounced = await send({ recipients: ['THEKEDAR', { ...team, projectRoles: [...team.projectRoles] }], type: 'CHEQUE_BOUNCED', severity: 'CRITICAL', sms: 'Cheque bounce ho gaya.' });
    expect(await names(bounced)).toEqual(['Khalid Malik']);
    expect(lastSmsTo(s.users.khalid.phone)?.body).toBe('Cheque bounce ho gaya.');
    expect(await prismaAdmin.notification.count({ where: { userId: s.users.rafaqatMalik.id } })).toBe(0);
  });
});

describe('/notifications', () => {
  it('lists my notifications, counts unread, marks one / all read', async () => {
    const s = seeded();
    await send({ recipients: ['THEKEDAR'], type: 'LOW_STOCK', at: new Date('2026-10-01T05:00:00Z') });
    await send({ recipients: ['THEKEDAR', { userIds: [s.users.bilal.id] }], type: 'CHEQUE_BOUNCED', severity: 'CRITICAL', at: new Date('2026-10-02T05:00:00Z') });
    const o = await owner();
    expect((await api().get('/api/v1/notifications/unread-count').set(o)).body.data).toEqual({ count: 2, critical: 1, warning: 0 });
    const list = await api().get('/api/v1/notifications').set(o);
    expect(list.body.data.map((n: { type: string }) => n.type)).toEqual(['CHEQUE_BOUNCED', 'LOW_STOCK']);
    expect(list.body.meta).toMatchObject({ total: 2 });

    const p = await pm();
    expect((await api().get('/api/v1/notifications').set(p)).body.data).toEqual([]); // Bilal: no financials → no bounce notice
    expect((await api().patch(`/api/v1/notifications/${list.body.data[0].id}/read`).set(p)).status).toBe(404); // not his

    const read = await api().patch(`/api/v1/notifications/${list.body.data[0].id}/read`).set(o);
    expect(read.body.data).toMatchObject({ read: true });
    expect((await api().get('/api/v1/notifications/unread-count').set(o)).body.data.count).toBe(1);
    expect((await api().get('/api/v1/notifications').set(o).query({ unreadOnly: 'true' })).body.data.map((n: { type: string }) => n.type)).toEqual(['LOW_STOCK']);
    expect((await api().patch('/api/v1/notifications/read-all').set(o)).body.data).toEqual({ updated: 1 });
    expect((await api().get('/api/v1/notifications/unread-count').set(o)).body.data.count).toBe(0);
  });

  it('module events notify the right people (top-up request → owner)', async () => {
    const m = await munshi(seeded().malik.id);
    expect((await api().post('/api/v1/topup-requests').set(m).send({ amountPaisa: '4000000', note: 'Wages' })).status).toBe(201);
    const list = (await api().get('/api/v1/notifications').set(await owner())).body.data;
    expect(list[0]).toMatchObject({ type: 'TOPUP_REQUESTED', severity: 'INFO', title: 'Top-up request: Rs 40,000', actionUrl: '/finance/cash-floats', read: false });
    expect((await api().get('/api/v1/notifications').set(m)).body.data).toEqual([]);
  });
});
