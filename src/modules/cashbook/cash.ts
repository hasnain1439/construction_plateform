/**
 * The cash engine. Every rupee a munshi / PM holds is one CashEntry row (signed: + into their
 * cash, − out of it). Balance = Σ entries except floats still waiting to be acknowledged.
 * Rows are never deleted; fixes are new entries (COUNT_ADJUSTMENT, REFUND_IN).
 */
import type { Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import type { CashAccount, CashEntryStatus, CashEntryType, CostBucket, ExpenseCategory, FloatMethod } from '../../generated/prisma/client.js';
import type { Actor } from '../inventory/stock.js';

export const CATEGORY_BUCKET: Record<ExpenseCategory, CostBucket> = {
  TEA_WATER: 'OVERHEAD',
  TRANSPORT: 'OVERHEAD',
  UNLOADING: 'LABOR',
  FUEL: 'EQUIPMENT',
  SMALL_TOOLS: 'EQUIPMENT',
  URGENT_MATERIAL: 'MATERIAL',
  OWNER_PURCHASE: 'RECOVERABLE_FROM_OWNER',
  REPAIRS: 'EQUIPMENT',
  OTHER: 'OVERHEAD',
};

/** Holder's active account; `create` opens one (named after the holder) when there is none. */
export async function accountOf(tx: Tx, tenantId: string, holderUserId: string, create: true): Promise<CashAccount>;
export async function accountOf(tx: Tx, tenantId: string, holderUserId: string, create?: false): Promise<CashAccount | null>;
export async function accountOf(tx: Tx, tenantId: string, holderUserId: string, create = false): Promise<CashAccount | null> {
  const found = await tx.cashAccount.findFirst({ where: { tenantId, holderUserId, isActive: true } });
  if (found || !create) return found;
  const holder = await tx.user.findFirst({ where: { tenantId, id: holderUserId }, select: { name: true } });
  if (!holder) throw new NotFound('USER_NOT_FOUND', 'User not found');
  return tx.cashAccount.create({ data: { tenantId, holderUserId, name: `${holder.name} — site cash` } });
}

/** Serialises writes to one account (balance checks can't race). */
export async function lockAccount(tx: Tx, accountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash:${accountId}`}))`;
}

export interface AccountTotals {
  balancePaisa: bigint;
  pendingAckPaisa: bigint;
  pendingApprovalPaisa: bigint;
  recoverablePaisa: bigint;
}

export async function totalsOf(tx: Tx, tenantId: string, accountIds: string[]): Promise<Map<string, AccountTotals>> {
  const out = new Map<string, AccountTotals>(accountIds.map((id) => [id, { balancePaisa: 0n, pendingAckPaisa: 0n, pendingApprovalPaisa: 0n, recoverablePaisa: 0n }]));
  if (!accountIds.length) return out;
  const groups = await tx.cashEntry.groupBy({
    by: ['accountId', 'status', 'recoverableFromHolder'],
    where: { tenantId, accountId: { in: accountIds } },
    _sum: { amountPaisa: true },
  });
  for (const g of groups) {
    const t = out.get(g.accountId)!;
    const sum = g._sum.amountPaisa ?? 0n;
    if (g.status === 'PENDING_ACK') {
      t.pendingAckPaisa += sum;
      continue;
    }
    t.balancePaisa += sum;
    if (g.status === 'PENDING_APPROVAL') t.pendingApprovalPaisa -= sum;
    if (g.status === 'REJECTED' && g.recoverableFromHolder) t.recoverablePaisa -= sum;
  }
  return out;
}

export async function balanceOf(tx: Tx, tenantId: string, accountId: string): Promise<bigint> {
  return (await totalsOf(tx, tenantId, [accountId])).get(accountId)!.balancePaisa;
}

export const rupees = (paisa: bigint) => `Rs ${(Number(paisa) / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;

export async function assertCash(tx: Tx, tenantId: string, accountId: string, amountPaisa: bigint) {
  const balance = await balanceOf(tx, tenantId, accountId);
  if (balance < amountPaisa) {
    throw new BadRequest('INSUFFICIENT_CASH', `Only ${rupees(balance)} is in hand — ask the office for a top-up`, {
      balancePaisa: balance.toString(),
      requiredPaisa: amountPaisa.toString(),
    });
  }
}

/**
 * The site-cash account to pay from. MUNSHI: only their own. THEKEDAR / PM: a given account
 * (any holder) or their own. Outside the caller's reach → 404.
 */
export async function payingAccount(tx: Tx, a: Actor, cashAccountId?: string): Promise<CashAccount> {
  if (cashAccountId) {
    const acc = await tx.cashAccount.findFirst({ where: { tenantId: a.tenantId, id: cashAccountId, isActive: true } });
    if (!acc || (a.role === 'MUNSHI' && acc.holderUserId !== a.userId)) throw new NotFound('CASH_ACCOUNT_NOT_FOUND', 'Cash account not found');
    return acc;
  }
  const own = await accountOf(tx, a.tenantId, a.userId);
  if (!own) throw new BadRequest('NO_CASH_ACCOUNT', 'You hold no site cash yet — the office sends a float first');
  return own;
}

export interface EntryInput {
  accountId: string;
  projectId?: string | null;
  type: CashEntryType;
  amountPaisa: bigint;
  description: string;
  status: CashEntryStatus;
  category?: ExpenseCategory | null;
  costBucket?: CostBucket | null;
  attachmentId?: string | null;
  method?: FloatMethod | null;
  reference?: string | null;
  refType?: string | null;
  refId?: string | null;
  clientId?: string | null;
  deviceCreatedAt?: Date | null;
  occurredAt: Date;
  /** Posting time (default now); the cash book's running balance follows posting order. */
  createdAt?: Date | undefined;
  createdById: string | null;
}

export function postEntry(tx: Tx, tenantId: string, e: EntryInput) {
  return tx.cashEntry.create({
    data: {
      tenantId,
      accountId: e.accountId,
      projectId: e.projectId ?? null,
      type: e.type,
      amountPaisa: e.amountPaisa,
      description: e.description,
      status: e.status,
      category: e.category ?? null,
      costBucket: e.costBucket ?? null,
      attachmentId: e.attachmentId ?? null,
      method: e.method ?? null,
      reference: e.reference ?? null,
      refType: e.refType ?? null,
      refId: e.refId ?? null,
      clientId: e.clientId ?? null,
      deviceCreatedAt: e.deviceCreatedAt ?? null,
      occurredAt: e.occurredAt,
      ...(e.createdAt ? { createdAt: e.createdAt } : {}),
      createdById: e.createdById,
    },
  });
}

/** Money out of a holder's cash (balance-checked, account locked). Returns the entry. */
export async function spend(tx: Tx, tenantId: string, e: Omit<EntryInput, 'amountPaisa'> & { amountPaisa: bigint }) {
  await lockAccount(tx, e.accountId);
  await assertCash(tx, tenantId, e.accountId, e.amountPaisa);
  return postEntry(tx, tenantId, { ...e, amountPaisa: -e.amountPaisa });
}

/**
 * Team hook: a user can't be deactivated while they still hold site cash (or a float is
 * waiting for them) — hand it over first.
 */
export async function assertNoOpenCashBalance(tx: Tx, tenantId: string, userId: string) {
  const accounts = await tx.cashAccount.findMany({ where: { tenantId, holderUserId: userId, isActive: true }, select: { id: true } });
  const totals = await totalsOf(
    tx,
    tenantId,
    accounts.map((x) => x.id),
  );
  for (const [accountId, t] of totals) {
    if (t.balancePaisa !== 0n || t.pendingAckPaisa !== 0n) {
      throw new Conflict('CASH_BALANCE_OPEN', `This user still holds ${rupees(t.balancePaisa)} of site cash — record a handover first`, {
        accountId,
        balancePaisa: t.balancePaisa.toString(),
        pendingAckPaisa: t.pendingAckPaisa.toString(),
      });
    }
  }
}

export const cashMethodOf = (paidFrom: string): FloatMethod | null =>
  paidFrom === 'BANK' ? 'BANK' : paidFrom === 'JAZZCASH' ? 'JAZZCASH' : paidFrom === 'EASYPAISA' ? 'EASYPAISA' : null;
