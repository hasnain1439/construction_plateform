/**
 * "Try with demo data": one sample project, clearly tagged DEMO (isDemo + "DEMO ·" names), with
 * a client, a supplier, four workers on site, a week of hazri, a site purchase on udhaar
 * (received), a small site cash book with kharcha and a DRAFT invoice — all written through the
 * real services, so every screen and report shows realistic numbers.
 *
 * Bounded: one demo per company (409 DEMO_EXISTS); the demo project never counts against the
 * plan's active-project limit (planLimits filters isDemo). The demo purchase gives its number
 * back (it is renamed DEMO-PUR-1) and the invoice stays a draft, so no real document number is
 * used up. DELETE /demo removes all of it in one transaction via purge_demo_data().
 */
import { writeAudit } from '../../core/audit/audit.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Conflict, NotFound } from '../../core/errors/AppError.js';
import { logger } from '../../config/logger.js';
import { todayIn } from '../../core/utils/dates.js';
import { uuidv7 } from '../../core/utils/uuid.js';
import { storage, storageForKey } from '../attachments/storage.provider.js';
import { createInvoiceTx } from '../billing/invoices.service.js';
import { actor as billingActor } from '../billing/billing.shared.js';
import { createInvoiceBody } from '../billing/billing.schema.js';
import { CATEGORY_BUCKET, postEntry } from '../cashbook/cash.js';
import { actor, siteLocation, type Actor } from '../inventory/stock.js';
import { assignWorkerTx } from '../labor/assignments.service.js';
import { markAttendanceTx } from '../labor/attendance.service.js';
import { addDays } from '../labor/labor.shared.js';
import { assignWorkerBody, attendanceBody } from '../labor/labor.schema.js';
import { createPurchaseTx, receivePurchaseTx } from '../procurement/purchases.service.js';
import { createPurchaseBody, receivePurchaseBody } from '../procurement/procurement.schema.js';
import type { ExpenseCategory } from '../../generated/prisma/enums.js';

const rs = (rupees: number) => BigInt(Math.round(rupees * 100));
/** Pakistan-time hour of a date → UTC instant. */
const at = (date: string, hourPkt = 11) => new Date(`${date}T${String(hourPkt - 5).padStart(2, '0')}:00:00.000Z`);
/** 1×1 PNG used as the demo challan photo. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const lockDemo = (tx: Tx, tenantId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`demo:${tenantId}`}))`;

async function freeValue(taken: (v: string) => Promise<boolean>, make: (n: number) => string): Promise<string> {
  for (let n = 1; n < 1000; n++) if (!(await taken(make(n)))) return make(n);
  throw new Conflict('DEMO_EXISTS', 'Could not find a free demo name');
}

/** Gives a just-taken document number back to its series (only when it is still the last one). */
async function giveNumberBack(tx: Tx, tenantId: string, number: string) {
  const m = /^(.*)-(\d+)$/.exec(number);
  if (!m) return;
  await tx.$executeRaw`UPDATE "TenantCounter" SET "value" = "value" - 1, "updatedAt" = now() WHERE "tenantId" = ${tenantId}::uuid AND "key" = ${m[1]} AND "value" = ${Number(m[2])}`;
}

async function pickWorkerTypes(tx: Tx) {
  const types = await tx.laborRate.findMany({ where: { kind: 'DAILY', isActive: true }, orderBy: { ratePaisa: 'desc' } });
  const byKey = (k: string) => types.find((t) => t.key === k);
  const skilled = byKey('MISTRI') ?? types[0];
  const helper = byKey('MAZDOOR') ?? types[types.length - 1];
  return {
    skilled: skilled ? { type: skilled.key, rate: skilled.ratePaisa } : { type: 'OTHER', rate: rs(2800) },
    helper: helper ? { type: helper.key, rate: helper.ratePaisa } : { type: 'OTHER', rate: rs(1600) },
  };
}

async function build(tx: Tx, a: Actor) {
  const tenantId = a.tenantId;
  const today = todayIn('Asia/Karachi');
  const start = addDays(today, -20);

  // ─── Client + project ──────────────────────────────────────────────────
  const phone = await freeValue(async (p) => Boolean(await tx.client.findFirst({ where: { tenantId, phone: p } })), (n) => `+9230000${String(n).padStart(5, '0')}`);
  const client = await tx.client.create({
    data: { tenantId, name: 'DEMO · Mr. Kamran (sample client)', phone, address: 'Sample address — demo data', notes: 'Demo data — removed with "Remove demo data"', isDemo: true, createdById: a.userId },
  });
  const code = await freeValue(async (c) => Boolean(await tx.project.findFirst({ where: { tenantId, code: c } })), (n) => `DEMO-${String(n).padStart(3, '0')}`);
  const project = await tx.project.create({
    data: {
      tenantId,
      code,
      name: 'DEMO · Sample house (10 Marla)',
      clientId: client.id,
      siteAddress: 'Sample site — demo data',
      city: 'Lahore',
      startDate: new Date(`${start}T00:00:00.000Z`),
      status: 'ACTIVE',
      contractType: 'FULL',
      billingModel: 'STAGE_SCHEDULE',
      contractValuePaisa: rs(15_000_000),
      wizardCompletedSteps: [1, 2, 3, 4],
      activatedAt: at(start, 9),
      isDemo: true,
      createdById: a.userId,
    },
  });
  await siteLocation(tx, tenantId, project);

  // ─── Workers on site + hazri ───────────────────────────────────────────
  const { skilled, helper } = await pickWorkerTypes(tx);
  const people: Array<[string, { type: string; rate: bigint }]> = [
    ['DEMO · Ustad Akram (mistri)', skilled],
    ['DEMO · Nadeem (mistri)', skilled],
    ['DEMO · Shahid (mazdoor)', helper],
    ['DEMO · Jameel (mazdoor)', helper],
  ];
  const workerIds: string[] = [];
  for (const [name, t] of people) {
    const w = await tx.worker.create({ data: { tenantId, name, type: t.type, dailyRatePaisa: t.rate, notes: 'Demo data', isDemo: true, createdById: a.userId } });
    workerIds.push(w.id);
    await assignWorkerTx(tx, a, project.id, assignWorkerBody.parse({ workerId: w.id, startDate: start }));
  }
  const statuses = ['FULL', 'FULL', 'FULL', 'HALF', 'FULL', 'ABSENT'] as const;
  let hazri = 0;
  for (let d = 6; d >= 1; d--) {
    const date = addDays(today, -d);
    const entries = workerIds.map((workerId, i) => ({ workerId, status: statuses[(d + i) % statuses.length]! }));
    await markAttendanceTx(tx, a, project.id, attendanceBody.parse({ date, entries }), { at: at(date, 18) });
    hazri += entries.length;
  }

  // ─── Supplier + site purchase on udhaar (received at site) ─────────────
  const supplierName = await freeValue(async (n) => Boolean(await tx.supplier.findFirst({ where: { tenantId, name: n } })), (n) => (n === 1 ? 'DEMO · Al-Noor Cement Traders' : `DEMO · Al-Noor Cement Traders ${n}`));
  const supplier = await tx.supplier.create({ data: { tenantId, name: supplierName, category: 'Cement', city: 'Lahore', notes: 'Demo data', isDemo: true } });
  const cement = await tx.material.findFirst({ where: { tenantId, isHidden: false, group: { code: 'CEMENT' } }, orderBy: { name: 'asc' } });
  const bricks = await tx.material.findFirst({ where: { tenantId, isHidden: false, group: { code: 'BRICKS' } }, orderBy: { name: 'asc' } });
  const items = [
    ...(cement ? [{ materialId: cement.id, challanQty: 100, ratePaisa: rs(1450).toString() }] : []),
    ...(bricks ? [{ materialId: bricks.id, challanQty: 5000, ratePaisa: rs(18).toString() }] : []),
  ];
  let purchases = 0;
  if (items.length) {
    const purchaseDate = addDays(today, -5);
    const attId = uuidv7();
    const now = new Date();
    const key = await storage().put(`${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${attId}.png`, PNG, 'image/png');
    await tx.attachment.create({ data: { id: attId, tenantId, kind: 'CHALLAN', storageKey: key, fileName: 'demo-challan.png', mimeType: 'image/png', sizeBytes: PNG.length, uploadedById: a.userId } });
    const created = await createPurchaseTx(
      tx,
      a,
      createPurchaseBody.parse({
        supplierId: supplier.id,
        deliverTo: 'SITE',
        projectId: project.id,
        challanNo: 'DEMO-CH-101',
        purchaseDate,
        paymentMode: 'UDHAAR',
        challanAttachmentId: attId,
        note: 'Demo purchase',
        items,
      }),
      { at: at(purchaseDate, 10) },
    );
    const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: (created as { id: string }).id } });
    await giveNumberBack(tx, tenantId, purchase.number);
    await tx.purchase.update({ where: { id: purchase.id }, data: { number: 'DEMO-PUR-1' } });
    if (purchase.status === 'PENDING_RECEIPT') {
      await receivePurchaseTx(tx, a, purchase.id, receivePurchaseBody.parse({ items: items.map((i) => ({ materialId: i.materialId, countedQty: i.challanQty })) }), { at: at(purchaseDate, 15) });
    }
    purchases = 1;
  }

  // ─── Site cash: a demo cash book (inactive, so it is never paid from by mistake) ──
  const account = await tx.cashAccount.create({ data: { tenantId, holderUserId: a.userId, name: 'DEMO · Site cash', isActive: false, isDemo: true } });
  const floatDate = addDays(today, -6);
  await postEntry(tx, tenantId, {
    accountId: account.id,
    projectId: project.id,
    type: 'FLOAT_IN',
    amountPaisa: rs(30000),
    description: 'Demo float for site kharcha',
    status: 'POSTED',
    method: 'CASH',
    occurredAt: at(floatDate, 9),
    createdAt: at(floatDate, 9),
    createdById: a.userId,
  });
  const kharcha: Array<[number, ExpenseCategory, number, string]> = [
    [5, 'TEA_WATER', 1200, 'Chai & water for the labour'],
    [4, 'FUEL', 4500, 'Diesel for the mixer'],
    [3, 'UNLOADING', 3000, 'Unloading cement and bricks'],
    [2, 'TRANSPORT', 2500, 'Rickshaw — shuttering props'],
  ];
  for (const [daysAgo, category, rupees, description] of kharcha) {
    const date = addDays(today, -daysAgo);
    await postEntry(tx, tenantId, {
      accountId: account.id,
      projectId: project.id,
      type: 'EXPENSE',
      amountPaisa: -rs(rupees),
      category,
      costBucket: CATEGORY_BUCKET[category],
      description: `${description} (demo)`,
      status: 'APPROVED',
      occurredAt: at(date, 13),
      createdAt: at(date, 13),
      createdById: a.userId,
    });
  }

  // ─── A draft invoice (not issued: no invoice number is used) ───────────
  const invoice = await createInvoiceTx(
    tx,
    billingActor(),
    project.id,
    createInvoiceBody.parse({
      type: 'OTHER',
      lines: [
        { description: 'Mobilisation advance — 10% of contract (demo)', amountPaisa: rs(1_500_000).toString() },
        { description: 'Excavation & foundation work (demo)', amountPaisa: rs(850_000).toString() },
      ],
      notes: 'Demo invoice — a draft; issue it to see the invoice flow.',
    }),
  );

  await writeAudit(tx, { tenantId, actorType: 'USER', actorId: a.userId, action: 'demo.create', entityType: 'Project', entityId: project.id, details: { code } });
  return {
    project: { id: project.id, code, name: project.name, isDemo: true },
    counts: { workers: workerIds.length, hazri, purchases, kharcha: kharcha.length, invoices: invoice ? 1 : 0 },
  };
}

export async function createDemo() {
  const a = actor();
  return withTenant(
    a.tenantId,
    async (tx) => {
      await lockDemo(tx, a.tenantId);
      const existing = await tx.project.findFirst({ where: { tenantId: a.tenantId, isDemo: true }, select: { id: true, code: true } });
      if (existing) throw new Conflict('DEMO_EXISTS', 'Demo data is already in your company — remove it first', { projectId: existing.id, code: existing.code });
      return build(tx, a);
    },
    { timeout: 60_000 },
  );
}

/** Real data that would be touched by removing the demo → 409 DEMO_IN_USE (nothing is removed). */
async function realUses(tx: Tx, tenantId: string) {
  const projects = (await tx.project.findMany({ where: { tenantId, isDemo: true }, select: { id: true } })).map((p) => p.id);
  const locations = (await tx.stockLocation.findMany({ where: { tenantId, projectId: { in: projects } }, select: { id: true } })).map((l) => l.id);
  const workers = (await tx.worker.findMany({ where: { tenantId, isDemo: true }, select: { id: true } })).map((w) => w.id);
  const suppliers = (await tx.supplier.findMany({ where: { tenantId, isDemo: true }, select: { id: true } })).map((s) => s.id);
  const clients = (await tx.client.findMany({ where: { tenantId, isDemo: true }, select: { id: true } })).map((c) => c.id);
  const uses: string[] = [];
  if (await tx.dispatch.count({ where: { tenantId, OR: [{ fromLocationId: { in: locations } }, { toLocationId: { in: locations } }] } })) uses.push('DISPATCH');
  if (await tx.cashEntry.count({ where: { tenantId, projectId: { in: projects }, account: { isDemo: false } } })) uses.push('REAL_CASH_ENTRY');
  const notDemo = { projectId: { notIn: projects } };
  if (
    (await tx.projectWorker.count({ where: { tenantId, workerId: { in: workers }, ...notDemo } })) ||
    (await tx.attendance.count({ where: { tenantId, workerId: { in: workers }, ...notDemo } })) ||
    (await tx.advance.count({ where: { tenantId, workerId: { in: workers }, ...notDemo } }))
  ) {
    uses.push('DEMO_WORKER_ON_REAL_PROJECT');
  }
  if (
    (await tx.purchase.count({ where: { tenantId, supplierId: { in: suppliers }, locationId: { notIn: locations } } })) ||
    (await tx.purchaseOrder.count({ where: { tenantId, supplierId: { in: suppliers }, locationId: { notIn: locations } } })) ||
    (await tx.purchaseReturn.count({ where: { tenantId, supplierId: { in: suppliers }, locationId: { notIn: locations } } }))
  ) {
    uses.push('DEMO_SUPPLIER_ON_REAL_STOCK');
  }
  if (await tx.project.count({ where: { tenantId, isDemo: false, clientId: { in: clients } } })) uses.push('DEMO_CLIENT_ON_REAL_PROJECT');
  return { projects, uses };
}

export async function deleteDemo() {
  const a = actor();
  const result = await withTenant(
    a.tenantId,
    async (tx) => {
      await lockDemo(tx, a.tenantId);
      const demo = await tx.project.findFirst({ where: { tenantId: a.tenantId, isDemo: true }, select: { id: true, code: true } });
      if (!demo) throw new NotFound('DEMO_NOT_FOUND', 'There is no demo data in your company');
      const { uses } = await realUses(tx, a.tenantId);
      if (uses.length) {
        throw new Conflict('DEMO_IN_USE', 'Some of your real data uses the demo records — undo that first (see details.uses)', { uses });
      }
      const [row] = await tx.$queryRaw<Array<{ keys: string[] }>>`SELECT purge_demo_data() AS keys`;
      await writeAudit(tx, { tenantId: a.tenantId, actorType: 'USER', actorId: a.userId, action: 'demo.delete', entityType: 'Project', entityId: demo.id, details: { code: demo.code } });
      return { removed: true, projectId: demo.id, code: demo.code, files: row?.keys ?? [] };
    },
    { timeout: 60_000 },
  );
  // Files after the commit: a failed delete leaves an orphan file, never a broken row.
  for (const key of result.files) {
    await storageForKey(key)
      .delete(key)
      .catch((err: unknown) => logger.warn({ err, key }, 'demo: could not delete a demo file'));
  }
  return { removed: true, projectId: result.projectId, code: result.code };
}
