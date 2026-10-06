import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { projectCost } from '../../src/modules/billing/projectCost.service.js';
import { useFreshDatabase } from '../helpers.js';
import { materialId, siteOf, stockIn } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();
const cost = () => prismaAdmin.$transaction((tx) => projectCost(tx, seeded().malik.id, seeded().projects.dha.id));

describe('projectCost', () => {
  it('nothing spent → all zero', async () => {
    expect(await cost()).toEqual({ materialPaisa: 0n, wagesPaisa: 0n, advancesPaisa: 0n, subcontractPaisa: 0n, kharchaPaisa: 0n, lossesPaisa: 0n, totalPaisa: 0n });
  });

  it('adds site material (not owner-supplied), paid wages, peshgi, sub-contract payments, kharcha (not recoverable / rejected) and written-off losses', async () => {
    const t = seeded().malik.id;
    const dha = seeded().projects.dha.id;
    const site = await siteOf(t, dha);
    const cement = await materialId(t, 'Cement OPC');
    await stockIn(t, site.id, cement, 100, 145000n); // Rs 1,45,000
    await stockIn(t, site.id, cement, 50, 0n, true); // owner-supplied: 0

    const worker = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: t, name: 'Shahid' } });
    await prismaAdmin.advance.create({ data: { tenantId: t, projectId: dha, payeeType: 'WORKER', workerId: worker.id, amountPaisa: 200000n, date: new Date(), paidFrom: 'OFFICE_CASH' } });
    const settlement = await prismaAdmin.wageSettlement.create({ data: { tenantId: t, projectId: dha, weekStart: new Date('2026-09-21'), weekEnd: new Date('2026-09-27'), status: 'APPROVED' } });
    const line = { tenantId: t, settlementId: settlement.id, workerId: worker.id, fullDays: 6, halfDays: 0, daysWorked: 6, dailyRatePaisa: 160000n, overtimeHours: 0, overtimePaisa: 0n, grossPaisa: 960000n, advanceAdjustedPaisa: 200000n, netPaisa: 760000n };
    await prismaAdmin.wageSettlementLine.create({ data: { ...line, paymentStatus: 'PAID' } });
    const other = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId: t, name: 'Riaz' } });
    await prismaAdmin.wageSettlementLine.create({ data: { ...line, workerId: other.id, paymentStatus: 'UNPAID' } }); // not paid yet → not counted

    const sub = await prismaAdmin.subcontractor.findFirstOrThrow({ where: { tenantId: t, name: 'Ustad Sharif Shuttering' } });
    const asg = await prismaAdmin.subcontractAssignment.create({ data: { tenantId: t, projectId: dha, subcontractorId: sub.id, scope: 'Slab', rateType: 'PER_SQFT', ratePaisa: 4500n, startDate: new Date() } });
    for (const [type, amount] of [['WORK_VALUE', 5000000n], ['RUNNING_PAYMENT', -3000000n], ['RETENTION_RELEASE', -100000n], ['DEDUCTION', -50000n]] as const) {
      await prismaAdmin.subcontractLedgerEntry.create({ data: { tenantId: t, assignmentId: asg.id, type, amountPaisa: amount, occurredAt: new Date() } });
    }

    const acc = await prismaAdmin.cashAccount.create({ data: { tenantId: t, holderUserId: seeded().users.rafaqatMalik.id, name: 'Rafaqat' } });
    const entry = (amount: bigint, extra: Record<string, unknown>) =>
      prismaAdmin.cashEntry.create({ data: { tenantId: t, accountId: acc.id, projectId: dha, type: 'EXPENSE', amountPaisa: amount, description: 'x', status: 'APPROVED', occurredAt: new Date(), ...extra } });
    await entry(-565000n, { category: 'FUEL', costBucket: 'EQUIPMENT' }); // counted
    await entry(-280000n, { category: 'OWNER_PURCHASE', costBucket: 'RECOVERABLE_FROM_OWNER' }); // owner pays it back
    await entry(-100000n, { category: 'OTHER', costBucket: 'OVERHEAD', status: 'REJECTED' }); // owed back by the munshi

    const c = await cost();
    expect(c).toEqual({
      materialPaisa: 14500000n,
      wagesPaisa: 760000n,
      advancesPaisa: 200000n,
      subcontractPaisa: 3100000n,
      kharchaPaisa: 565000n,
      lossesPaisa: 0n,
      totalPaisa: 14500000n + 760000n + 200000n + 3100000n + 565000n,
    });
  });
});
