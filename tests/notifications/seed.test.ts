import { beforeEach, describe, expect, it } from 'vitest';
import { seedMalikNotifications } from '../../prisma/seedNotifications.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { api, mockPdf, munshi, owner, pm, seedMalikDemo } from '../dashboard/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  mockPdf();
  await seedMalikDemo(seeded());
});

const seedNotifications = () => {
  const s = seeded();
  return seedMalikNotifications(prismaAdmin, { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, projects: s.projects });
};

describe('notifications seed', () => {
  it('reflects the demo data, some read, some unread; munshi only gets site ones', async () => {
    const { created } = await seedNotifications();
    expect(created).toBeGreaterThan(10);
    expect(await seedNotifications()).toEqual({ created }); // same set again

    const o = await owner();
    const mine = (await api().get('/api/v1/notifications').set(o).query({ limit: 50 })).body.data as Array<{ type: string; title: string; read: boolean; smsSent: boolean; severity: string }>;
    const types = mine.map((n) => n.type);
    expect(types).toEqual(
      expect.arrayContaining(['CHEQUE_BOUNCED', 'INVOICE_OVERDUE', 'SHORTAGE_CREATED', 'EXPENSE_PENDING_APPROVAL', 'SETTLEMENT_SUBMITTED', 'TOPUP_REQUESTED', 'SUBCONTRACTOR_OVERPAID', 'LOW_STOCK']),
    );
    expect(mine.find((n) => n.type === 'CHEQUE_BOUNCED')).toMatchObject({ severity: 'CRITICAL', read: false, smsSent: true, title: 'Cheque bounced — DHA Phase 6 · 10 Marla' });
    expect(mine.find((n) => n.type === 'SHORTAGE_CREATED')!.title).toBe('Shortage on GP-0142');
    expect(mine.find((n) => n.type === 'TOPUP_REQUESTED')!.title).toBe('Top-up request: Rs 40,000');
    expect(mine.some((n) => n.read)).toBe(true);
    const count = (await api().get('/api/v1/notifications/unread-count').set(o)).body.data;
    expect(count.critical).toBe(1);
    expect(count.count).toBe(mine.filter((n) => !n.read).length);

    // Bilal (no financials): wages to approve, GP-0144 on the way, measurement — nothing about owner money.
    const bilal = ((await api().get('/api/v1/notifications').set(await pm())).body.data as Array<{ type: string }>).map((n) => n.type).sort();
    expect(bilal).toEqual(['DISPATCH_CREATED', 'MEASUREMENT_RECORDED', 'SETTLEMENT_SUBMITTED']);
    // Rafaqat: only GP-0144 on the way.
    const rafaqat = (await api().get('/api/v1/notifications').set(await munshi(seeded().malik.id))).body.data as Array<{ type: string; title: string }>;
    expect(rafaqat.map((n) => n.type)).toEqual(['DISPATCH_CREATED']);
    expect(rafaqat[0]!.title).toBe('GP-0144 on the way to DHA Phase 6 · 10 Marla');
  });
});
