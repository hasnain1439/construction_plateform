/**
 * Opening balances — what the company already owed, held or had before it started using the
 * app. One entry per item (supplier, cash holder, material, worker); once saved it is LOCKED
 * (409 OPENING_LOCKED) and audited. The money goes into the existing ledgers, so balances,
 * ageing, stock valuation and reports include it automatically:
 *
 *   SUPPLIER_UDHAAR → SupplierLedgerEntry OPENING (supplier udhaar / ageing / cash-flow)
 *   CASH_IN_HAND    → CashEntry OPENING (POSTED) in the holder's cash account
 *   STORE_STOCK     → StockMovement OPENING_IN at the Central Store at the given rate
 *   WORKER_PESHGI   → Advance (OFFICE_CASH) on the worker's project, cut from their wages
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import { uuidv7 } from '../../core/utils/uuid.js';
import { accountOf, lockAccount, postEntry } from '../cashbook/cash.js';
import { actor, audit, D, lockLocations, occurredAtFor, postIn, systemLocations, valueOf, type Actor } from '../inventory/stock.js';
import { createAdvanceTx } from '../labor/advances.service.js';
import { advanceBody } from '../labor/labor.schema.js';
import { postLedger } from '../procurement/supplierLedger.service.js';
import type { OpeningBalance } from '../../generated/prisma/client.js';
import type { OpeningInput, OpeningKind } from './onboarding.schema.js';

const REF = 'OPENING_BALANCE';

const entityOf = (input: OpeningInput): string =>
  input.kind === 'SUPPLIER_UDHAAR' ? input.supplierId : input.kind === 'CASH_IN_HAND' ? input.holderUserId : input.kind === 'STORE_STOCK' ? input.materialId : input.workerId;

async function names(tx: Tx, rows: OpeningBalance[]) {
  const ids = (k: OpeningKind) => rows.filter((r) => r.kind === k).map((r) => r.entityId);
  const out = new Map<string, { name: string; unit?: string }>();
  for (const s of await tx.supplier.findMany({ where: { id: { in: ids('SUPPLIER_UDHAAR') } }, select: { id: true, name: true } })) out.set(s.id, { name: s.name });
  for (const u of await tx.user.findMany({ where: { id: { in: ids('CASH_IN_HAND') } }, select: { id: true, name: true } })) out.set(u.id, { name: u.name });
  for (const m of await tx.material.findMany({ where: { id: { in: ids('STORE_STOCK') } }, select: { id: true, name: true, unit: true } })) out.set(m.id, { name: m.name, unit: m.unit });
  for (const w of await tx.worker.findMany({ where: { id: { in: ids('WORKER_PESHGI') } }, select: { id: true, name: true } })) out.set(w.id, { name: w.name });
  const projectIds = rows.map((r) => r.projectId).filter((x): x is string => Boolean(x));
  const projects = new Map((await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true, name: true } })).map((p) => [p.id, p]));
  const userIds = rows.map((r) => r.createdById).filter((x): x is string => Boolean(x));
  const users = new Map((await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u]));
  return { out, projects, users };
}

async function toDtos(tx: Tx, rows: OpeningBalance[]) {
  const { out, projects, users } = await names(tx, rows);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    entity: { id: r.entityId, name: out.get(r.entityId)?.name ?? '—', ...(out.get(r.entityId)?.unit ? { unit: out.get(r.entityId)!.unit } : {}) },
    project: r.projectId ? (projects.get(r.projectId) ?? null) : null,
    amountPaisa: r.amountPaisa.toString(),
    quantity: r.quantity === null ? null : Number(r.quantity.toFixed(3)),
    ratePaisa: r.ratePaisa?.toString() ?? null,
    date: formatDateOnly(r.date),
    note: r.note,
    refType: r.refType,
    refId: r.refId,
    locked: true,
    createdBy: r.createdById ? (users.get(r.createdById) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listOpenings(query: { kind?: OpeningKind | undefined }) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const rows = await tx.openingBalance.findMany({ where: { tenantId: a.tenantId, ...(query.kind ? { kind: query.kind } : {}) }, orderBy: [{ createdAt: 'desc' }] });
    return toDtos(tx, rows);
  });
}

async function post(tx: Tx, a: Actor, id: string, input: OpeningInput, at: Date) {
  const note = input.note ?? null;
  switch (input.kind) {
    case 'SUPPLIER_UDHAAR': {
      const supplier = await tx.supplier.findFirst({ where: { tenantId: a.tenantId, id: input.supplierId }, select: { id: true, name: true } });
      if (!supplier) throw new NotFound('SUPPLIER_NOT_FOUND', 'Supplier not found');
      await postLedger(tx, a, { supplierId: supplier.id, type: 'OPENING', amountPaisa: input.amountPaisa, refType: REF, refId: id, occurredAt: at, note: note ?? 'Opening balance (before the app)' });
      return { name: supplier.name, amountPaisa: input.amountPaisa, refType: REF, refId: id };
    }
    case 'CASH_IN_HAND': {
      const holder = await tx.user.findFirst({ where: { tenantId: a.tenantId, id: input.holderUserId } });
      if (!holder || holder.status !== 'ACTIVE' || holder.role === 'THEKEDAR' || holder.isSystem) throw new BadRequest('INVALID_HOLDER', 'Choose an active munshi or project manager');
      const account = await accountOf(tx, a.tenantId, holder.id, true);
      await lockAccount(tx, account.id);
      const entry = await postEntry(tx, a.tenantId, {
        accountId: account.id,
        type: 'OPENING',
        amountPaisa: input.amountPaisa,
        description: note ?? 'Opening cash in hand (before the app)',
        status: 'POSTED',
        refType: REF,
        refId: id,
        occurredAt: at,
        createdById: a.userId,
      });
      return { name: holder.name, amountPaisa: input.amountPaisa, refType: 'CASH_ENTRY', refId: entry.id };
    }
    case 'STORE_STOCK': {
      const material = await tx.material.findFirst({ where: { tenantId: a.tenantId, id: input.materialId }, select: { id: true, name: true } });
      if (!material) throw new NotFound('MATERIAL_NOT_FOUND', 'Material not found');
      const { store } = await systemLocations(tx, a.tenantId);
      await lockLocations(tx, [store.id]);
      const qty = D(input.quantity);
      await postIn(tx, a.tenantId, { locationId: store.id, materialId: material.id, ownerSupplied: false }, qty, input.ratePaisa, {
        type: 'OPENING_IN',
        refType: REF,
        refId: id,
        occurredAt: at,
        createdById: a.userId,
        note: note ?? 'Opening stock (before the app)',
      });
      return { name: material.name, amountPaisa: valueOf(qty, input.ratePaisa), refType: REF, refId: id };
    }
    case 'WORKER_PESHGI': {
      const worker = await tx.worker.findFirst({ where: { tenantId: a.tenantId, id: input.workerId }, select: { id: true, name: true } });
      if (!worker) throw new NotFound('WORKER_NOT_FOUND', 'Worker not found');
      const advance = await createAdvanceTx(
        tx,
        a,
        input.projectId,
        advanceBody.parse({
        payeeType: 'WORKER',
        workerId: worker.id,
        amountPaisa: input.amountPaisa.toString(),
        date: input.date,
        paidFrom: 'OFFICE_CASH',
        note: note ?? 'Opening peshgi (before the app)',
      }),
      );
      return { name: worker.name, amountPaisa: input.amountPaisa, refType: 'ADVANCE', refId: advance.data.id };
    }
  }
}

export async function createOpening(input: OpeningInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`opening:${a.tenantId}`}))`;
    const entityId = entityOf(input);
    const existing = await tx.openingBalance.findUnique({ where: { tenantId_kind_entityId: { tenantId: a.tenantId, kind: input.kind, entityId } } });
    if (existing) {
      throw new Conflict('OPENING_LOCKED', 'The opening balance of this item is already saved and locked', { openingBalanceId: existing.id, createdAt: existing.createdAt.toISOString() });
    }
    const at = occurredAtFor(input.date);
    const id = uuidv7();
    const posted = await post(tx, a, id, input, at);
    const row = await tx.openingBalance.create({
      data: {
        id,
        tenantId: a.tenantId,
        kind: input.kind,
        entityId,
        projectId: input.kind === 'WORKER_PESHGI' ? input.projectId : null,
        amountPaisa: posted.amountPaisa,
        quantity: input.kind === 'STORE_STOCK' ? D(input.quantity) : null,
        ratePaisa: input.kind === 'STORE_STOCK' ? input.ratePaisa : null,
        date: dateOnly(input.date),
        note: input.note ?? null,
        refType: posted.refType,
        refId: posted.refId,
        createdById: a.userId,
      },
    });
    await audit(tx, a, 'opening_balance.create', 'OpeningBalance', row.id, {
      kind: input.kind,
      entityId,
      name: posted.name,
      amountPaisa: posted.amountPaisa.toString(),
      date: input.date,
      ...(input.kind === 'STORE_STOCK' ? { quantity: input.quantity, ratePaisa: input.ratePaisa.toString() } : {}),
      ...(input.kind === 'WORKER_PESHGI' ? { projectId: input.projectId } : {}),
    });
    return (await toDtos(tx, [row]))[0]!;
  });
}
