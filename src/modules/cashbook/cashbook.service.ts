/**
 * B6 — site cash book. THEKEDAR sends floats (the holder acknowledges them); munshis / PMs
 * spend (kharcha, peshgi, wages); kharcha above the company limit waits for approval but has
 * already left the cash. Top-up requests, cash counts and handovers complete the picture.
 *
 * Visibility: THEKEDAR every account; PM their own and those of munshis on their projects;
 * MUNSHI only their own. Anything else → 404.
 */
import { logger } from '../../config/logger.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors/AppError.js';
import type { CashAccount, CashEntry, Prisma } from '../../generated/prisma/client.js';
import { smsProvider } from '../auth/sms.provider.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { assertAttachment, occurredAtFor } from '../inventory/stock.js';
import * as alerts from '../notifications/alerts.js';
import { createPurchaseTx } from '../procurement/purchases.service.js';
import { actor, audit, laborSettings, projectFor, today, weekOf, type Actor, type Created } from '../labor/labor.shared.js';
import { accountOf, CATEGORY_BUCKET, lockAccount, postEntry, rupees, spend, totalsOf } from './cash.js';
import type {
  ApproveTopupInput,
  CashbookQuery,
  CountInput,
  CountsQuery,
  EntriesQuery,
  ExpenseInput,
  ExpensesQuery,
  FloatInput,
  HandoverInput,
  TopupInput,
  TopupsQuery,
} from './cashbook.schema.js';

const accountNotFound = () => new NotFound('CASH_ACCOUNT_NOT_FOUND', 'Cash account not found');

function visibleAccounts(a: Actor): Prisma.CashAccountWhereInput {
  if (a.role === 'THEKEDAR') return { tenantId: a.tenantId };
  if (a.role === 'MUNSHI') return { tenantId: a.tenantId, holderUserId: a.userId };
  return {
    tenantId: a.tenantId,
    OR: [{ holderUserId: a.userId }, { holder: { role: 'MUNSHI', projectAccess: { some: { project: { userAccess: { some: { userId: a.userId } } } } } } }],
  };
}

async function findAccount(tx: Tx, a: Actor, id: string) {
  const acc = await tx.cashAccount.findFirst({ where: { ...visibleAccounts(a), id }, include: { holder: { select: { id: true, name: true, role: true, phone: true } } } });
  if (!acc) throw accountNotFound();
  return acc;
}

async function accountDtos(tx: Tx, a: Actor, accounts: Array<CashAccount & { holder: { id: string; name: string; role: string; phone: string } }>) {
  const totals = await totalsOf(
    tx,
    a.tenantId,
    accounts.map((x) => x.id),
  );
  const lastCounts = await tx.cashCount.groupBy({ by: ['accountId'], where: { tenantId: a.tenantId, accountId: { in: accounts.map((x) => x.id) } }, _max: { countedAt: true } });
  const lastEntries = await tx.cashEntry.groupBy({ by: ['accountId'], where: { tenantId: a.tenantId, accountId: { in: accounts.map((x) => x.id) } }, _max: { occurredAt: true } });
  return accounts.map((x) => {
    const t = totals.get(x.id)!;
    return {
      id: x.id,
      name: x.name,
      holder: { id: x.holder.id, name: x.holder.name, role: x.holder.role },
      isActive: x.isActive,
      balancePaisa: t.balancePaisa.toString(),
      pendingAckPaisa: t.pendingAckPaisa.toString(),
      pendingApprovalPaisa: t.pendingApprovalPaisa.toString(),
      recoverablePaisa: t.recoverablePaisa.toString(),
      lastCountAt: lastCounts.find((c) => c.accountId === x.id)?._max.countedAt?.toISOString() ?? null,
      lastEntryAt: lastEntries.find((c) => c.accountId === x.id)?._max.occurredAt?.toISOString() ?? null,
    };
  });
}

function entryDto(e: CashEntry & { project?: { id: string; code: string; name: string } | null }, running?: bigint) {
  return {
    id: e.id,
    accountId: e.accountId,
    project: e.project ?? (e.projectId ? { id: e.projectId } : null),
    type: e.type,
    amountPaisa: e.amountPaisa.toString(),
    ...(running !== undefined ? { runningBalancePaisa: running.toString() } : {}),
    category: e.category,
    costBucket: e.costBucket,
    description: e.description,
    attachmentId: e.attachmentId,
    status: e.status,
    method: e.method,
    reference: e.reference,
    approvedById: e.approvedById,
    approvedAt: e.approvedAt?.toISOString() ?? null,
    reviewNote: e.reviewNote,
    recoverableFromHolder: e.recoverableFromHolder,
    refType: e.refType,
    refId: e.refId,
    clientId: e.clientId,
    occurredAt: e.occurredAt.toISOString(),
    createdById: e.createdById,
    createdAt: e.createdAt.toISOString(),
  };
}

const projectRef = { project: { select: { id: true, code: true, name: true } } } as const;

async function notify(phone: string, body: string) {
  await smsProvider()
    .send({ to: phone, body })
    .catch((err: unknown) => logger.warn({ err }, 'cash sms failed'));
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export async function listAccounts(query: { includeInactive?: boolean }) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const accounts = await tx.cashAccount.findMany({
      where: { ...visibleAccounts(a), ...(query.includeInactive ? {} : { isActive: true }) },
      include: { holder: { select: { id: true, name: true, role: true, phone: true } } },
      orderBy: { name: 'asc' },
    });
    const rows = await accountDtos(tx, a, accounts);
    const sum = (k: 'balancePaisa' | 'pendingAckPaisa' | 'pendingApprovalPaisa' | 'recoverablePaisa') => rows.reduce((s, r) => s + BigInt(r[k]), 0n).toString();
    return {
      items: rows,
      totals: { balancePaisa: sum('balancePaisa'), pendingAckPaisa: sum('pendingAckPaisa'), pendingApprovalPaisa: sum('pendingApprovalPaisa'), recoverablePaisa: sum('recoverablePaisa') },
    };
  });
}

export async function getAccount(id: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => (await accountDtos(tx, a, [await findAccount(tx, a, id)]))[0]!);
}

/** Entries newest first (posting order), each with the balance after it (pending floats don't count). */
export async function listEntries(id: string, query: EntriesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const acc = await findAccount(tx, a, id);
    const all = await tx.cashEntry.findMany({ where: { tenantId: a.tenantId, accountId: acc.id }, include: projectRef, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    let running = 0n;
    const withBalance = all.map((e) => {
      if (e.status !== 'PENDING_ACK') running += e.amountPaisa;
      return entryDto(e, running);
    });
    const from = query.from ? pktDayStart(query.from).getTime() : -Infinity;
    const to = query.to ? pktDayEnd(query.to).getTime() : Infinity;
    const filtered = withBalance
      .filter((e) => (!query.type || e.type === query.type) && Date.parse(e.occurredAt) >= from && Date.parse(e.occurredAt) < to)
      .reverse();
    const start = (query.page - 1) * query.limit;
    return { data: filtered.slice(start, start + query.limit), meta: { ...pageMeta(query, filtered.length), balancePaisa: running.toString() } };
  });
}

// ─── Floats ─────────────────────────────────────────────────────────────────

export async function sendFloatTx(tx: Tx, a: Actor, input: FloatInput, opts: { at?: Date; acknowledged?: boolean } = {}) {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', 'Only the owner sends cash floats');
  const holder = await tx.user.findFirst({ where: { tenantId: a.tenantId, id: input.holderUserId } });
  if (!holder || holder.status !== 'ACTIVE' || holder.role === 'THEKEDAR') throw new BadRequest('INVALID_HOLDER', 'Choose an active munshi or project manager');
  if (input.projectId) await projectFor(tx, a, input.projectId);
  const account = await accountOf(tx, a.tenantId, holder.id, true);
  const at = opts.at ?? (input.date ? occurredAtFor(input.date) : new Date());
  const entry = await postEntry(tx, a.tenantId, {
    accountId: account.id,
    projectId: input.projectId ?? null,
    type: 'FLOAT_IN',
    amountPaisa: input.amountPaisa,
    description: input.note ?? `Float via ${input.method.toLowerCase()}`,
    status: opts.acknowledged ? 'POSTED' : 'PENDING_ACK',
    method: input.method,
    reference: input.reference ?? null,
    occurredAt: at,
    createdAt: opts.at,
    createdById: a.userId,
  });
  if (opts.acknowledged) await tx.cashEntry.update({ where: { id: entry.id }, data: { approvedById: holder.id, approvedAt: at } });
  await audit(tx, a, 'cash.float_sent', 'CashEntry', entry.id, { holder: holder.name, amountPaisa: input.amountPaisa.toString(), method: input.method, reference: input.reference ?? null });
  if (!opts.acknowledged) {
    await alerts.floatSent(tx, { tenantId: a.tenantId, holderUserId: holder.id, entryId: entry.id, amountPaisa: input.amountPaisa, projectId: input.projectId ?? null, method: input.method, at });
  }
  if (!opts.at) {
    await notify(holder.phone, `${rupees(input.amountPaisa)} bheje gaye (${input.method}${input.reference ? ` ${input.reference}` : ''}). App mein "Mil gaye" dabayen.`);
  }
  return entryDto(await tx.cashEntry.findUniqueOrThrow({ where: { id: entry.id }, include: projectRef }));
}

export async function sendFloat(input: FloatInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => sendFloatTx(tx, a, input));
}

export async function acknowledgeTx(tx: Tx, a: Actor, entryId: string, opts: { at?: Date } = {}) {
  const e = await tx.cashEntry.findFirst({ where: { tenantId: a.tenantId, id: entryId, type: 'FLOAT_IN' }, include: { account: true } });
  if (!e || e.account.holderUserId !== a.userId) throw new NotFound('FLOAT_NOT_FOUND', 'Float not found');
  if (e.status !== 'PENDING_ACK') throw new Conflict('ALREADY_ACKNOWLEDGED', 'This float is already acknowledged');
  await tx.cashEntry.update({ where: { id: e.id }, data: { status: 'POSTED', approvedById: a.userId, approvedAt: opts.at ?? new Date() } });
  await audit(tx, a, 'cash.float_acknowledged', 'CashEntry', e.id, { amountPaisa: e.amountPaisa.toString() });
  return entryDto(await tx.cashEntry.findUniqueOrThrow({ where: { id: e.id }, include: projectRef }));
}

export async function acknowledge(entryId: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => acknowledgeTx(tx, a, entryId));
}

// ─── Kharcha ────────────────────────────────────────────────────────────────

export async function createExpenseTx(tx: Tx, a: Actor, input: ExpenseInput, opts: { at?: Date } = {}): Promise<Created<ReturnType<typeof entryDto>>> {
  if (input.clientId) {
    const dup = await tx.cashEntry.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: input.clientId } }, include: projectRef });
    if (dup) return { created: false, data: entryDto(dup) };
  }
  const project = await projectFor(tx, a, input.projectId, true);
  const date = input.date ?? today();
  if (date > today()) throw new BadRequest('FUTURE_DATE', "Kharcha can't be dated in the future");
  if (input.attachmentId) await assertAttachment(tx, a.tenantId, input.attachmentId, ['RECEIPT', 'CHALLAN', 'DOCUMENT', 'SITE_PHOTO'], 'INVALID_ATTACHMENT', 'Receipt');
  const account = await accountOf(tx, a.tenantId, a.userId);
  if (!account) throw new BadRequest('NO_CASH_ACCOUNT', 'You hold no site cash yet — the office sends a float first');
  const { kharchaApprovalLimitPaisa } = await laborSettings(tx, a.tenantId);
  const needsApproval = input.amountPaisa > kharchaApprovalLimitPaisa;
  const at = opts.at ?? occurredAtFor(date);

  let purchaseId: string | null = null;
  if (input.items && input.supplierId) {
    const purchase = await createPurchaseTx(
      tx,
      a,
      {
        supplierId: input.supplierId,
        deliverTo: 'SITE',
        projectId: project.id,
        challanNo: input.challanNo ?? `KHARCHA ${date}`,
        purchaseDate: date,
        paymentMode: 'UDHAAR',
        challanAttachmentId: input.attachmentId!,
        note: `Bought with site cash: ${input.description}`,
        items: input.items.map((i) => ({ materialId: i.materialId, challanQty: i.qty })),
      },
      { kharcha: true, ...(opts.at ? { at: opts.at } : {}) },
    );
    purchaseId = purchase.id;
  }
  const entry = await spend(tx, a.tenantId, {
    accountId: account.id,
    projectId: project.id,
    type: 'EXPENSE',
    amountPaisa: input.amountPaisa,
    category: input.category,
    costBucket: CATEGORY_BUCKET[input.category],
    description: input.description,
    attachmentId: input.attachmentId ?? null,
    status: needsApproval ? 'PENDING_APPROVAL' : 'APPROVED',
    refType: purchaseId ? 'PURCHASE' : null,
    refId: purchaseId,
    clientId: input.clientId ?? null,
    deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
    occurredAt: at,
    createdAt: opts.at,
    createdById: a.userId,
  });
  await audit(tx, a, 'cash.expense', 'CashEntry', entry.id, {
    category: input.category,
    amountPaisa: input.amountPaisa.toString(),
    needsApproval,
    ...(purchaseId ? { purchaseId } : {}),
  });
  if (needsApproval) {
    const holder = await tx.user.findUniqueOrThrow({ where: { id: a.userId }, select: { name: true } });
    await alerts.expensePending(tx, { tenantId: a.tenantId, projectId: project.id, entryId: entry.id, holder: holder.name, amountPaisa: input.amountPaisa, description: input.description, at });
  }
  return { created: true, data: entryDto(await tx.cashEntry.findUniqueOrThrow({ where: { id: entry.id }, include: projectRef })) };
}

export async function createExpense(input: ExpenseInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createExpenseTx(tx, a, input));
}

export async function listExpenses(query: ExpensesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    if (query.projectId) await projectFor(tx, a, query.projectId);
    const where: Prisma.CashEntryWhereInput = {
      tenantId: a.tenantId,
      type: 'EXPENSE',
      account: visibleAccounts(a),
      ...(a.role === 'PM' ? { OR: [{ project: { userAccess: { some: { userId: a.userId } } } }, { account: { holderUserId: a.userId } }] } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
    };
    const rows = await tx.cashEntry.findMany({
      where,
      include: { ...projectRef, account: { select: { id: true, holder: { select: { id: true, name: true } } } } },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      ...skipTake(query),
    });
    const total = await tx.cashEntry.count({ where });
    const sum = await tx.cashEntry.aggregate({ where, _sum: { amountPaisa: true } });
    return {
      data: rows.map((r) => ({ ...entryDto(r), amountPaisa: (-r.amountPaisa).toString(), holder: r.account.holder })),
      meta: { ...pageMeta(query, total), totalPaisa: (-(sum._sum.amountPaisa ?? 0n)).toString() },
    };
  });
}

async function findExpenseForReview(tx: Tx, a: Actor, id: string) {
  if (a.role === 'MUNSHI') throw new Forbidden('FORBIDDEN', 'Only the owner or a project manager can approve kharcha');
  const e = await tx.cashEntry.findFirst({ where: { tenantId: a.tenantId, id, type: 'EXPENSE' }, include: { account: true } });
  if (!e) throw new NotFound('EXPENSE_NOT_FOUND', 'Kharcha not found');
  if (e.projectId) {
    await projectFor(tx, a, e.projectId).catch(() => {
      throw new NotFound('EXPENSE_NOT_FOUND', 'Kharcha not found');
    });
  }
  if (e.status !== 'PENDING_APPROVAL') throw new Conflict('EXPENSE_NOT_PENDING', `This kharcha is already ${e.status.toLowerCase().replace('_', ' ')}`, { status: e.status });
  if (a.role === 'PM' && e.account.holderUserId === a.userId) throw new Forbidden('OWN_EXPENSE', 'Your own kharcha is approved by the owner');
  return e;
}

export async function approveExpenseTx(tx: Tx, a: Actor, id: string, note?: string, opts: { at?: Date } = {}) {
  const e = await findExpenseForReview(tx, a, id);
  await tx.cashEntry.update({ where: { id: e.id }, data: { status: 'APPROVED', approvedById: a.userId, approvedAt: opts.at ?? new Date(), reviewNote: note ?? null } });
  await audit(tx, a, 'cash.expense_approved', 'CashEntry', e.id, { amountPaisa: (-e.amountPaisa).toString() });
  return entryDto(await tx.cashEntry.findUniqueOrThrow({ where: { id: e.id }, include: projectRef }));
}

export async function approveExpense(id: string, note?: string) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => approveExpenseTx(tx, a, id, note));
}

/** Refused kharcha stays out of the cash (it was spent) and is owed back by the holder. */
export async function rejectExpense(id: string, note: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const e = await findExpenseForReview(tx, a, id);
    await tx.cashEntry.update({ where: { id: e.id }, data: { status: 'REJECTED', approvedById: a.userId, approvedAt: new Date(), reviewNote: note, recoverableFromHolder: true } });
    await audit(tx, a, 'cash.expense_rejected', 'CashEntry', e.id, { amountPaisa: (-e.amountPaisa).toString(), note });
    return entryDto(await tx.cashEntry.findUniqueOrThrow({ where: { id: e.id }, include: projectRef }));
  });
}

// ─── Top-ups ────────────────────────────────────────────────────────────────

const topupInclude = { account: { select: { id: true, name: true, holder: { select: { id: true, name: true, phone: true } } } } } as const;
type TopupRow = Prisma.TopupRequestGetPayload<{ include: typeof topupInclude }>;
const topupDto = (t: TopupRow, balance?: bigint) => ({
  id: t.id,
  account: { id: t.account.id, name: t.account.name },
  holder: { id: t.account.holder.id, name: t.account.holder.name },
  amountPaisa: t.amountPaisa.toString(),
  note: t.note,
  status: t.status,
  ...(balance !== undefined ? { balancePaisa: balance.toString() } : {}),
  decidedById: t.decidedById,
  decidedAt: t.decidedAt?.toISOString() ?? null,
  decisionNote: t.decisionNote,
  floatEntryId: t.floatEntryId,
  createdAt: t.createdAt.toISOString(),
});

export async function requestTopupTx(tx: Tx, a: Actor, input: TopupInput, opts: { at?: Date } = {}): Promise<Created<ReturnType<typeof topupDto>>> {
  if (input.clientId) {
    const dup = await tx.topupRequest.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: input.clientId } }, include: topupInclude });
    if (dup) return { created: false, data: topupDto(dup) };
  }
  if (a.role === 'THEKEDAR') throw new Forbidden('FORBIDDEN', 'The owner sends floats directly');
  const account = await accountOf(tx, a.tenantId, a.userId, true);
  const open = await tx.topupRequest.findFirst({ where: { tenantId: a.tenantId, accountId: account.id, status: 'PENDING' } });
  if (open) throw new Conflict('TOPUP_PENDING', 'You already have a top-up request waiting', { topupId: open.id });
  const t = await tx.topupRequest.create({
    data: {
      tenantId: a.tenantId,
      accountId: account.id,
      amountPaisa: input.amountPaisa,
      note: input.note ?? null,
      clientId: input.clientId ?? null,
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
    include: topupInclude,
  });
  await audit(tx, a, 'cash.topup_requested', 'TopupRequest', t.id, { amountPaisa: input.amountPaisa.toString() });
  const holder = await tx.user.findUniqueOrThrow({ where: { id: a.userId }, select: { name: true } });
  await alerts.topupRequested(tx, { tenantId: a.tenantId, topupId: t.id, holder: holder.name, amountPaisa: input.amountPaisa, ...(opts.at ? { at: opts.at } : {}) });
  return { created: true, data: topupDto(t) };
}

export async function requestTopup(input: TopupInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => requestTopupTx(tx, a, input));
}

export async function listTopups(query: TopupsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.TopupRequestWhereInput = { tenantId: a.tenantId, account: visibleAccounts(a), ...(query.status ? { status: query.status } : {}) };
    const rows = await tx.topupRequest.findMany({ where, include: topupInclude, orderBy: { createdAt: 'desc' }, ...skipTake(query) });
    const total = await tx.topupRequest.count({ where });
    const balances = await totalsOf(tx, a.tenantId, [...new Set(rows.map((r) => r.accountId))]);
    return { data: rows.map((r) => topupDto(r, balances.get(r.accountId)?.balancePaisa)), meta: pageMeta(query, total) };
  });
}

async function findPendingTopup(tx: Tx, a: Actor, id: string) {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', 'Only the owner decides top-ups');
  const t = await tx.topupRequest.findFirst({ where: { tenantId: a.tenantId, id }, include: topupInclude });
  if (!t) throw new NotFound('TOPUP_NOT_FOUND', 'Top-up request not found');
  if (t.status !== 'PENDING') throw new Conflict('TOPUP_DECIDED', `This request is already ${t.status.toLowerCase()}`, { status: t.status });
  return t;
}

export async function approveTopup(id: string, input: ApproveTopupInput) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const t = await findPendingTopup(tx, a, id);
    const float = await sendFloatTx(tx, a, {
      holderUserId: t.account.holder.id,
      amountPaisa: input.amountPaisa ?? t.amountPaisa,
      method: input.method,
      ...(input.reference ? { reference: input.reference } : {}),
      note: `Top-up${t.note ? ` — ${t.note}` : ''}`,
    });
    await tx.topupRequest.update({ where: { id: t.id }, data: { status: 'APPROVED', decidedById: a.userId, decidedAt: new Date(), floatEntryId: float.id } });
    await audit(tx, a, 'cash.topup_approved', 'TopupRequest', t.id, { amountPaisa: float.amountPaisa });
    return topupDto(await tx.topupRequest.findUniqueOrThrow({ where: { id: t.id }, include: topupInclude }));
  });
}

export async function rejectTopup(id: string, note: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const t = await findPendingTopup(tx, a, id);
    await tx.topupRequest.update({ where: { id: t.id }, data: { status: 'REJECTED', decidedById: a.userId, decidedAt: new Date(), decisionNote: note } });
    await audit(tx, a, 'cash.topup_rejected', 'TopupRequest', t.id, { note });
    await notify(t.account.holder.phone, `Top-up ${rupees(t.amountPaisa)} manzoor nahi hua: ${note}`);
    return topupDto(await tx.topupRequest.findUniqueOrThrow({ where: { id: t.id }, include: topupInclude }));
  });
}

// ─── Counts and handovers ───────────────────────────────────────────────────

const countDto = (c: Prisma.CashCountGetPayload<object>) => ({
  id: c.id,
  accountId: c.accountId,
  systemPaisa: c.systemPaisa.toString(),
  countedPaisa: c.countedPaisa.toString(),
  differencePaisa: c.differencePaisa.toString(),
  note: c.note,
  adjustmentEntryId: c.adjustmentEntryId,
  countedById: c.countedById,
  countedAt: c.countedAt.toISOString(),
});

/** Cash counted in hand; a difference becomes a COUNT_ADJUSTMENT entry (note required). */
export async function createCountTx(tx: Tx, a: Actor, input: CountInput, opts: { at?: Date } = {}) {
  const account = input.accountId ? await findAccount(tx, a, input.accountId) : await accountOf(tx, a.tenantId, a.userId);
  if (!account) throw new BadRequest('NO_CASH_ACCOUNT', 'You hold no site cash');
  await lockAccount(tx, account.id);
  const system = (await totalsOf(tx, a.tenantId, [account.id])).get(account.id)!.balancePaisa;
  const diff = input.countedPaisa - system;
  if (diff !== 0n && !input.note) throw new BadRequest('NOTE_REQUIRED', `The count is ${rupees(diff < 0n ? -diff : diff)} ${diff < 0n ? 'short' : 'over'} — write why`);
  const at = opts.at ?? new Date();
  const adjustment =
    diff !== 0n
      ? await postEntry(tx, a.tenantId, {
          accountId: account.id,
          type: 'COUNT_ADJUSTMENT',
          amountPaisa: diff,
          description: `Cash count ${diff < 0n ? 'short' : 'over'}: ${input.note}`,
          status: 'POSTED',
          costBucket: 'OVERHEAD',
          clientId: input.clientId ?? null,
          occurredAt: at,
          createdAt: opts.at,
          createdById: a.userId,
        })
      : null;
  const count = await tx.cashCount.create({
    data: {
      tenantId: a.tenantId,
      accountId: account.id,
      systemPaisa: system,
      countedPaisa: input.countedPaisa,
      differencePaisa: diff,
      note: input.note ?? null,
      adjustmentEntryId: adjustment?.id ?? null,
      countedById: a.userId,
      countedAt: at,
    },
  });
  await audit(tx, a, 'cash.count', 'CashCount', count.id, { accountId: account.id, systemPaisa: system.toString(), countedPaisa: input.countedPaisa.toString() });
  return countDto(count);
}

export async function createCount(input: CountInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createCountTx(tx, a, input));
}

export async function listCounts(query: CountsQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const where: Prisma.CashCountWhereInput = { tenantId: a.tenantId, account: visibleAccounts(a), ...(query.accountId ? { accountId: query.accountId } : {}) };
    const rows = await tx.cashCount.findMany({ where, orderBy: { countedAt: 'desc' }, ...skipTake(query) });
    return { data: rows.map(countDto), meta: pageMeta(query, await tx.cashCount.count({ where })) };
  });
}

/** Cash passed from one holder to another (e.g. a munshi leaving the site). */
export async function handoverTx(tx: Tx, a: Actor, input: HandoverInput, opts: { at?: Date } = {}) {
  let from: CashAccount | null;
  if (input.fromAccountId) {
    from = await findAccount(tx, a, input.fromAccountId);
    if (a.role !== 'THEKEDAR' && from.holderUserId !== a.userId) throw new Forbidden('FORBIDDEN', 'You can hand over only your own cash');
  } else from = await accountOf(tx, a.tenantId, a.userId);
  if (!from) throw new BadRequest('NO_CASH_ACCOUNT', 'You hold no site cash');
  const to = await tx.user.findFirst({ where: { tenantId: a.tenantId, id: input.toUserId, status: 'ACTIVE' } });
  if (!to || to.id === from.holderUserId) throw new BadRequest('INVALID_RECEIVER', 'Choose another active team member');
  const holder = await tx.user.findUniqueOrThrow({ where: { id: from.holderUserId }, select: { name: true } });
  const toAccount = await accountOf(tx, a.tenantId, to.id, true);
  const at = opts.at ?? new Date();
  const out = await spend(tx, a.tenantId, {
    accountId: from.id,
    type: 'HANDOVER_OUT',
    amountPaisa: input.amountPaisa,
    description: `Handed over to ${to.name}${input.note ? ` — ${input.note}` : ''}`,
    status: 'POSTED',
    occurredAt: at,
    createdAt: opts.at,
    createdById: a.userId,
  });
  const into = await postEntry(tx, a.tenantId, {
    accountId: toAccount.id,
    type: 'HANDOVER_IN',
    amountPaisa: input.amountPaisa,
    description: `Received from ${holder.name}${input.note ? ` — ${input.note}` : ''}`,
    status: 'POSTED',
    refType: 'CASH_ENTRY',
    refId: out.id,
    occurredAt: at,
    createdAt: opts.at,
    createdById: a.userId,
  });
  await tx.cashEntry.update({ where: { id: out.id }, data: { refType: 'CASH_ENTRY', refId: into.id } });
  await audit(tx, a, 'cash.handover', 'CashAccount', from.id, { to: to.name, amountPaisa: input.amountPaisa.toString() });
  return { out: entryDto(out), in: entryDto(into) };
}

export async function handover(input: HandoverInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => handoverTx(tx, a, input));
}

// ─── Project cash book ──────────────────────────────────────────────────────

/** Cash spent on / for a project (MUNSHI: only their own entries), with spend by category. */
export async function projectCashbook(projectId: string, query: CashbookQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await projectFor(tx, a, projectId);
    const s = await laborSettings(tx, a.tenantId);
    const week = weekOf(today(), s.weekStart);
    const range = { ...(query.from ? { gte: pktDayStart(query.from) } : {}), ...(query.to ? { lt: pktDayEnd(query.to) } : {}) };
    const where: Prisma.CashEntryWhereInput = {
      tenantId: a.tenantId,
      projectId: project.id,
      status: { not: 'PENDING_ACK' },
      ...(a.role === 'MUNSHI' ? { account: { holderUserId: a.userId } } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.from || query.to ? { occurredAt: range } : {}),
    };
    const rows = await tx.cashEntry.findMany({
      where,
      include: { ...projectRef, account: { select: { id: true, holder: { select: { id: true, name: true } } } } },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      ...skipTake(query),
    });
    const total = await tx.cashEntry.count({ where });
    const out = { ...where, amountPaisa: { lt: 0n } };
    const byCategory = await tx.cashEntry.groupBy({ by: ['category'], where: { ...out, type: 'EXPENSE' }, _sum: { amountPaisa: true } });
    const byType = await tx.cashEntry.groupBy({ by: ['type'], where: out, _sum: { amountPaisa: true } });
    const thisWeek = await tx.cashEntry.aggregate({
      where: { ...where, type: 'EXPENSE', occurredAt: { gte: pktDayStart(week.weekStart), lt: pktDayEnd(week.weekEnd) } },
      _sum: { amountPaisa: true },
    });
    const accounts = await tx.cashAccount.findMany({
      where: { ...visibleAccounts(a), isActive: true, holder: { projectAccess: { some: { projectId: project.id } } } },
      include: { holder: { select: { id: true, name: true, role: true, phone: true } } },
    });
    return {
      entries: rows.map((r) => ({ ...entryDto(r), holder: r.account.holder })),
      meta: pageMeta(query, total),
      summary: {
        spentByCategory: byCategory.map((g) => ({ category: g.category, amountPaisa: (-(g._sum.amountPaisa ?? 0n)).toString() })).sort((x, y) => Number(BigInt(y.amountPaisa) - BigInt(x.amountPaisa))),
        spentByType: byType.map((g) => ({ type: g.type, amountPaisa: (-(g._sum.amountPaisa ?? 0n)).toString() })),
        kharchaThisWeekPaisa: (-(thisWeek._sum.amountPaisa ?? 0n)).toString(),
        week,
      },
      accounts: await accountDtos(tx, a, accounts),
    };
  });
}
