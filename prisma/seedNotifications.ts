/**
 * Malik & Sons notifications (Phase 1 · Step 9), written after the stock, labour and billing
 * demo so each one points at a real record. Uses the same alert builders as the app (so
 * recipients and the MUNSHI / no-financials rules apply), backdated to when each thing happened.
 * The demo seeds already raised notifications as they ran; this set replaces all of the
 * company's notifications, so running it again gives the same result. The main seed only
 * calls it when the billing demo was written in the same run. Records already handled on a
 * used database (e.g. the kharcha approved) are simply left out.
 */
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { dayMonth } from '../src/core/pdf/templates.js';
import { balanceOf } from '../src/modules/inventory/stock.js';
import { subAccounts } from '../src/modules/labor/subcontractLedger.js';
import * as alerts from '../src/modules/notifications/alerts.js';

export interface NotificationsSeedInput {
  tenantId: string;
  ownerId: string;
  bilalId: string;
  rafaqatId: string;
  projects: { dha: { id: string }; johar: { id: string } };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

export async function seedMalikNotifications(db: PrismaClient, s: NotificationsSeedInput): Promise<{ created: number }> {
  const t = s.tenantId;

  const bounced = await db.clientPayment.findFirstOrThrow({ where: { tenantId: t, status: 'BOUNCED', chequeNo: '118845' }, include: { project: true } });
  const overdue = await db.invoice.findMany({ where: { tenantId: t, status: { in: ['ISSUED', 'PARTLY_PAID'] }, dueDate: { lt: new Date() }, balancePaisa: { gt: 0n } }, include: { project: true }, orderBy: { dueDate: 'asc' } });
  const gp142 = await db.dispatch.findFirstOrThrow({ where: { tenantId: t, number: 'GP-0142' }, include: { toLocation: true } });
  const gp144 = await db.dispatch.findFirstOrThrow({ where: { tenantId: t, number: 'GP-0144' }, include: { toLocation: true, items: { include: { material: true } } } });
  const shortages = await db.shortage.count({ where: { tenantId: t, dispatchId: gp142.id, status: 'OPEN' } });
  const expense = await db.cashEntry.findFirst({ where: { tenantId: t, type: 'EXPENSE', status: 'PENDING_APPROVAL' }, include: { account: { include: { holder: true } } } });
  const settlement = await db.wageSettlement.findFirst({ where: { tenantId: t, status: 'SUBMITTED' }, include: { project: true } });
  const topup = await db.topupRequest.findFirst({ where: { tenantId: t, status: 'PENDING' }, include: { account: { include: { holder: true } } } });
  const measurement = await db.workMeasurement.findFirst({ where: { tenantId: t, status: 'RECORDED' }, include: { project: true, assignment: { include: { subcontractor: true } } } });
  const latif = await db.subcontractAssignment.findFirstOrThrow({ where: { tenantId: t, subcontractor: { name: { contains: 'Latif' } } }, include: { subcontractor: true } });
  const latifAccount = (await subAccounts(db, t, [latif])).get(latif.id)!;
  const store = await db.stockLocation.findFirstOrThrow({ where: { tenantId: t, type: 'STORE' } });
  const sandLevel = await db.lowStockLevel.findFirst({ where: { tenantId: t, locationId: store.id, material: { name: 'Chenab sand' } }, include: { material: true } });

  await db.notification.deleteMany({ where: { tenantId: t } });

  await db.$transaction(async (tx) => {
    await alerts.chequeBounced(tx, {
      tenantId: t,
      projectId: bounced.projectId,
      projectName: bounced.project.name,
      paymentId: bounced.id,
      cheque: [bounced.bankName, 'cheque', bounced.chequeNo].filter(Boolean).join(' '),
      amountPaisa: bounced.amountPaisa,
      reason: bounced.bounceReason ?? 'bounced',
      sms: false,
      at: bounced.bouncedAt ?? bounced.updatedAt,
    });
    for (const inv of overdue) {
      const days = Math.floor((Date.now() - inv.dueDate!.getTime()) / 86_400_000);
      await alerts.invoiceOverdue(tx, { tenantId: t, projectId: inv.projectId, projectName: inv.project.name, invoiceId: inv.id, number: inv.number!, balancePaisa: inv.balancePaisa, overdueDays: days, at: hours(inv.dueDate!, 24 + 21.5) });
    }
    await alerts.shortageCreated(tx, { tenantId: t, projectId: gp142.toLocation.projectId, refType: 'DISPATCH', refId: gp142.id, number: gp142.number, where: gp142.toLocation.name, count: shortages, at: gp142.receivedAt ?? gp142.updatedAt });
    await alerts.dispatchCreated(tx, {
      tenantId: t,
      projectId: gp144.toLocation.projectId!,
      projectName: gp144.toLocation.name,
      dispatchId: gp144.id,
      number: gp144.number,
      lines: gp144.items.map((i) => `${i.material.name} ${Number(i.sentQty)} ${i.material.unit}`),
      at: gp144.dispatchedAt,
    });
    if (expense) await alerts.expensePending(tx, { tenantId: t, projectId: expense.projectId, entryId: expense.id, holder: expense.account.holder.name, amountPaisa: -expense.amountPaisa, description: expense.description, at: expense.occurredAt });
    if (settlement) await alerts.settlementSubmitted(tx, {
      tenantId: t,
      projectId: settlement.projectId,
      projectName: settlement.project.name,
      settlementId: settlement.id,
      week: `${dayMonth(ymd(settlement.weekStart))} – ${dayMonth(ymd(settlement.weekEnd))}`,
      netPaisa: settlement.netPaisa,
      at: settlement.submittedAt ?? settlement.updatedAt,
    });
    if (topup) await alerts.topupRequested(tx, { tenantId: t, topupId: topup.id, holder: topup.account.holder.name, amountPaisa: topup.amountPaisa, at: topup.createdAt });
    if (measurement) await alerts.measurementRecorded(tx, {
      tenantId: t,
      projectId: measurement.projectId,
      projectName: measurement.project.name,
      measurementId: measurement.id,
      subcontractor: measurement.assignment.subcontractor.name,
      quantity: String(Number(measurement.quantity)),
      unit: measurement.unit,
      at: measurement.createdAt,
    });
    if (latifAccount.overpaid) {
      await alerts.subcontractorOverpaid(tx, { tenantId: t, projectId: latif.projectId, assignmentId: latif.id, subcontractor: latif.subcontractor.name, overpaidPaisa: -latifAccount.balanceDuePaisa, at: new Date('2026-10-01T07:05:00Z') });
    }
    if (sandLevel) {
      const left = (await balanceOf(tx, t, { locationId: store.id, materialId: sandLevel.materialId, ownerSupplied: false })).qty;
      await alerts.lowStock(tx, { tenantId: t, materialId: sandLevel.materialId, material: sandLevel.material.name, unit: sandLevel.material.unit, left: String(Number(left)), min: String(Number(sandLevel.minQty)), store: store.name, at: new Date('2026-10-02T11:00:00Z') });
    }
  });

  // The bounce went out by SMS too; Khalid has already looked at the older ones.
  await db.notification.updateMany({ where: { tenantId: t, type: 'CHEQUE_BOUNCED' }, data: { smsSentAt: bounced.bouncedAt ?? new Date() } });
  const firstOverdue = overdue[0];
  await db.notification.updateMany({
    where: {
      tenantId: t,
      userId: s.ownerId,
      OR: [{ type: { in: ['LOW_STOCK', 'SUBCONTRACTOR_OVERPAID', 'SETTLEMENT_SUBMITTED'] } }, ...(firstOverdue ? [{ type: 'INVOICE_OVERDUE' as const, refId: firstOverdue.id }] : [])],
    },
    data: { readAt: new Date('2026-10-05T04:00:00Z') },
  });
  return { created: await db.notification.count({ where: { tenantId: t } }) };
}
