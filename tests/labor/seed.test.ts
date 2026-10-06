import { describe, expect, it } from 'vitest';
import { seedMalikLabor } from '../../prisma/seedLabor.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { api, munshi, owner, pm } from './fixtures.js';

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

describe('labour & cash book seed', () => {
  it('builds the Malik & Sons demo: two settlements, sub-contract accounts, Rafaqat and Asif cash', async () => {
    expect(await seedLabor()).toEqual({ skipped: false });
    expect(await seedLabor()).toEqual({ skipped: true }); // idempotent

    const auth = await owner();
    const dha = seeded().projects.dha.id;
    const settlements = (await api().get(`/api/v1/projects/${dha}/settlements`).set(auth)).body.data;
    expect(settlements.map((x: { weekStart: string; status: string; grossPaisa: string; netPaisa: string; paidPaisa: string }) => [x.weekStart, x.status, x.grossPaisa, x.netPaisa, x.paidPaisa])).toEqual([
      ['2026-09-21', 'SUBMITTED', '8360000', '7110000', '0'],
      ['2026-09-14', 'APPROVED', '6840000', '6840000', '6840000'],
    ]);
    const detail = (await api().get(`/api/v1/settlements/${settlements[0].id}`).set(auth)).body.data;
    const net = Object.fromEntries(detail.lines.map((l: { worker: { name: string }; daysWorked: number; advanceAdjustedPaisa: string; netPaisa: string }) => [l.worker.name, [l.daysWorked, l.advanceAdjustedPaisa, l.netPaisa]]));
    expect(net).toEqual({
      'Ustad Akram': [6, '500000', '1180000'],
      'Ustad Nadeem': [5.5, '0', '1540000'],
      Shahid: [6, '200000', '760000'],
      Jameel: [6, '0', '960000'],
      Riaz: [4, '150000', '490000'],
      Arif: [6, '300000', '660000'],
      Saleem: [5, '100000', '800000'],
      'Ghulam Rasool': [6, '0', '720000'],
    });

    const accounts = (await api().get(`/api/v1/projects/${dha}/subcontract-accounts`).set(auth)).body.data.items;
    const acc = (name: string) => accounts.find((a: { subcontractor: { name: string } }) => a.subcontractor.name === name).account;
    expect(acc('Ustad Sharif Shuttering')).toMatchObject({ valuePaisa: '36900000', paidPaisa: '32000000', balanceDuePaisa: '3055000', overpaid: false });
    expect(acc('Ustad Latif Steel Fixing')).toMatchObject({ valuePaisa: '12780000', paidPaisa: '14500000', balanceDuePaisa: '-2359000', overpaid: true });
    expect(acc('Haji Plumbing Works')).toMatchObject({ valuePaisa: '4800000', paidPaisa: '3000000', balanceDuePaisa: '1560000' });
    expect(acc('Ali Electric Works')).toMatchObject({ valuePaisa: '7603750', paidPaisa: '6000000' });

    const cash = (await api().get('/api/v1/cash-accounts').set(auth)).body.data.items;
    const holder = (name: string) => cash.find((a: { holder: { name: string } }) => a.holder.name === name);
    expect(holder('Rafaqat Ali')).toMatchObject({ balancePaisa: '930000', pendingAckPaisa: '0', pendingApprovalPaisa: '0' });
    expect(holder('Asif Mehmood')).toMatchObject({ balancePaisa: '2150000', pendingApprovalPaisa: '3200000' });
    const counts = (await api().get('/api/v1/cash-counts').set(auth)).body.data;
    expect(counts[0]).toMatchObject({ differencePaisa: '-10000', note: 'Change to tea boy' });
    const topups = (await api().get('/api/v1/topup-requests').set(auth).query({ status: 'PENDING' })).body.data;
    expect(topups).toEqual([expect.objectContaining({ amountPaisa: '4000000', holder: expect.objectContaining({ name: 'Rafaqat Ali' }) })]);

    // Rafaqat's own book: running balance never goes negative and ends at 9,300
    const m = await munshi(seeded().malik.id);
    const entries = (await api().get(`/api/v1/cash-accounts/${holder('Rafaqat Ali').id}/entries`).set(m).query({ limit: 100 })).body.data;
    expect(entries[0].runningBalancePaisa).toBe('930000');
    expect(entries.every((e: { runningBalancePaisa: string }) => BigInt(e.runningBalancePaisa) >= 0n)).toBe(true);
    expect(await prismaAdmin.attendance.count({ where: { projectId: dha } })).toBeGreaterThan(100);
  });

  it('office overview, worker and sub-contractor summaries (MUNSHI → 403)', async () => {
    await seedLabor();
    const auth = await owner();
    const overview = (await api().get('/api/v1/labor/overview').set(auth)).body.data;
    expect(overview).toMatchObject({ cashWithSiteStaffPaisa: '3080000', pending: { settlements: 1, topups: 1, measurements: 1 } });
    expect(overview.hazriToday.assigned).toBe(8);
    expect((await api().get('/api/v1/labor/overview').set(await munshi(seeded().malik.id))).status).toBe(403);

    const akram = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Ustad Akram' } });
    const w = (await api().get(`/api/v1/workers/${akram.id}/labor-summary`).set(auth)).body.data;
    expect(w.projects).toEqual([expect.objectContaining({ dailyRatePaisa: '280000', isActive: true })]);
    expect(w.outstandingAdvancePaisa).toBe('500000'); // cut only in the submitted (not yet approved) week
    expect(w.settlements.map((l: { weekStart: string; netPaisa: string }) => [l.weekStart, l.netPaisa])).toEqual([
      ['2026-09-21', '1180000'],
      ['2026-09-14', '1680000'],
    ]);

    const latif = await prismaAdmin.subcontractor.findFirstOrThrow({ where: { tenantId: seeded().malik.id, name: 'Ustad Latif Steel Fixing' } });
    const sub = (await api().get(`/api/v1/subcontractors/${latif.id}/labor-summary`).set(await pm())).body.data;
    expect(sub.assignments[0]).toMatchObject({ project: { code: 'MSB-2026-012' }, account: { overpaid: true, overpaidPaisa: '2359000' } });
    expect((await api().get(`/api/v1/workers/${akram.id}/labor-summary`).set(await munshi(seeded().malik.id))).status).toBe(403);
  });
});
