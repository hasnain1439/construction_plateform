import { describe, expect, it } from 'vitest';
import { seedMalikLabor } from '../../prisma/seedLabor.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { api, munshi, owner, pm, rs } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();

const seedLabor = () => {
  const s = seeded();
  return seedMalikLabor(prismaAdmin, {
    tenantId: s.malik.id,
    ownerId: s.users.khalid.id,
    bilalId: s.users.bilal.id,
    rafaqatId: s.users.rafaqatMalik.id,
    asifId: s.users.asif.id,
    projects: s.projects,
  });
};

type Group = { type: string; count: number; items: Array<{ id: string; type: string; amountPaisa: string | null; quickActions: Array<{ action: string }>; project: { code: string } | null }> };
const inbox = async (auth: Record<string, string>) => (await api().get('/api/v1/approvals').set(auth)).body.data as { total: number; groups: Group[] };
const counts = (d: { groups: Group[] }) => Object.fromEntries(d.groups.map((g) => [g.type, g.count]));

describe('/approvals', () => {
  it('THEKEDAR sees everything; a PM only their projects and the actions they may take; MUNSHI 403', async () => {
    await seedLabor();
    const o = await inbox(await owner());
    expect(counts(o)).toEqual({ SETTLEMENT_SUBMITTED: 1, EXPENSE_PENDING_APPROVAL: 1, TOPUP_PENDING: 1, MEASUREMENT_TO_VERIFY: 1 });
    expect(o.total).toBe(4);
    const expense = o.groups.find((g) => g.type === 'EXPENSE_PENDING_APPROVAL')!.items[0]!;
    expect(expense).toMatchObject({ amountPaisa: rs(32000), project: { code: 'MSB-2026-014' } });
    expect(expense.quickActions.map((q) => q.action)).toEqual(['approve', 'reject']);
    expect(o.groups.find((g) => g.type === 'SETTLEMENT_SUBMITTED')!.items[0]).toMatchObject({ amountPaisa: rs(71100) });

    // Bilal manages DHA + Johar: no Bahria kharcha, no top-ups (owner decides those).
    const p = await inbox(await pm());
    expect(counts(p)).toEqual({ SETTLEMENT_SUBMITTED: 1, MEASUREMENT_TO_VERIFY: 1 });

    expect((await api().get('/api/v1/approvals').set(await munshi(seeded().malik.id))).status).toBe(403);
  });

  it('money items need billing.view; cheque / invoice quick actions are owner-only', async () => {
    const s = seeded();
    await prismaAdmin.clientPayment.create({
      data: { tenantId: s.malik.id, projectId: s.projects.dha.id, number: 'RV-2026-9001', receivedOn: new Date('2026-10-05'), amountPaisa: 50000000n, method: 'CHEQUE', chequeNo: '200001', bankName: 'HBL', status: 'PENDING' },
    });
    const o = await inbox(await owner());
    expect(o.groups.find((g) => g.type === 'CHEQUE_PENDING')!.items[0]!.quickActions.map((q) => q.action)).toEqual(['clear', 'bounce']);
    expect(counts(await inbox(await pm()))).toEqual({}); // Bilal has no financials
  });

  it('bulk: runs each item through its module and reports failures per item', async () => {
    await seedLabor();
    const o = await owner();
    const before = await inbox(o);
    const id = (type: string) => before.groups.find((g) => g.type === type)!.items[0]!.id;
    const res = await api()
      .post('/api/v1/approvals/bulk')
      .set(o)
      .send({
        items: [
          { type: 'EXPENSE_PENDING_APPROVAL', id: id('EXPENSE_PENDING_APPROVAL'), action: 'approve', note: 'Motor was burnt' },
          { type: 'MEASUREMENT_TO_VERIFY', id: id('MEASUREMENT_TO_VERIFY'), action: 'verify' },
          { type: 'MEASUREMENT_TO_VERIFY', id: id('MEASUREMENT_TO_VERIFY'), action: 'verify' }, // already verified now
          { type: 'TOPUP_PENDING', id: id('TOPUP_PENDING'), action: 'approve' }, // no method
          { type: 'SETTLEMENT_SUBMITTED', id: id('SETTLEMENT_SUBMITTED'), action: 'return' }, // no note
          { type: 'SHORTAGE_OPEN', id: id('TOPUP_PENDING'), action: 'approve' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ succeeded: 2, failed: 4 });
    expect(res.body.data.results.map((r: { ok: boolean; error: { code: string } | null }) => (r.ok ? 'ok' : r.error!.code))).toEqual([
      'ok',
      'ok',
      'MEASUREMENT_NOT_PENDING',
      'METHOD_REQUIRED',
      'NOTE_REQUIRED',
      'UNSUPPORTED_ACTION',
    ]);
    expect(counts(await inbox(o))).toEqual({ SETTLEMENT_SUBMITTED: 1, TOPUP_PENDING: 1 });
    expect((await prismaAdmin.cashEntry.findUniqueOrThrow({ where: { id: id('EXPENSE_PENDING_APPROVAL') } })).status).toBe('APPROVED');
  });

  it('bulk respects each module’s rules for a PM', async () => {
    await seedLabor();
    const o = await inbox(await owner());
    const topup = o.groups.find((g) => g.type === 'TOPUP_PENDING')!.items[0]!.id;
    const settlement = o.groups.find((g) => g.type === 'SETTLEMENT_SUBMITTED')!.items[0]!.id;
    const res = await api()
      .post('/api/v1/approvals/bulk')
      .set(await pm())
      .send({ items: [{ type: 'TOPUP_PENDING', id: topup, action: 'reject', note: 'Not now' }, { type: 'SETTLEMENT_SUBMITTED', id: settlement, action: 'approve' }] });
    expect(res.body.data.results.map((r: { ok: boolean; error: { code: string } | null }) => (r.ok ? 'ok' : r.error!.code))).toEqual(['FORBIDDEN', 'ok']);
  });
});
