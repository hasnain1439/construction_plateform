/**
 * B3 — peshgi. A worker's advance is cut from their weekly wages (oldest first); a
 * sub-contractor's goes straight into their running account. Site-cash advances also leave
 * the munshi's cash book.
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { pageMeta } from '../../core/http/pagination.js';
import { BadRequest, Forbidden } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import type { Advance, Prisma } from '../../generated/prisma/client.js';
import { cashMethodOf, payingAccount, spend } from '../cashbook/cash.js';
import { occurredAtFor } from '../inventory/stock.js';
import { assignedWorkers, findAssignment } from './assignments.service.js';
import type { AdvanceInput, AdvancesQuery } from './labor.schema.js';
import { actor, audit, projectFor, today, type Actor, type Created } from './labor.shared.js';
import { postSubLedger } from './subcontractLedger.js';

const include = {
  worker: { select: { id: true, name: true, type: true } },
  assignment: { select: { id: true, scope: true, subcontractor: { select: { id: true, name: true } } } },
  allocations: { select: { amountPaisa: true, line: { select: { id: true, settlement: { select: { id: true, status: true, weekStart: true } } } } } },
} as const;
type Row = Prisma.AdvanceGetPayload<{ include: typeof include }>;

export type AdvanceStatus = 'OUTSTANDING' | 'PARTLY_ADJUSTED' | 'ADJUSTED';

/** Adjusted = cut in an approved settlement; a sub-contractor advance is adjusted in their account at once. */
export function advanceState(r: { payeeType: string; amountPaisa: bigint; allocations: Array<{ amountPaisa: bigint; line: { settlement: { status: string } } }> }) {
  const adjusted =
    r.payeeType === 'SUBCONTRACTOR'
      ? r.amountPaisa
      : r.allocations.filter((x) => x.line.settlement.status === 'APPROVED').reduce((s, x) => s + x.amountPaisa, 0n);
  const status: AdvanceStatus = adjusted <= 0n ? 'OUTSTANDING' : adjusted >= r.amountPaisa ? 'ADJUSTED' : 'PARTLY_ADJUSTED';
  return { adjusted, outstanding: r.amountPaisa - adjusted, status };
}

function toDto(r: Row) {
  const st = advanceState(r);
  return {
    id: r.id,
    projectId: r.projectId,
    payeeType: r.payeeType,
    worker: r.worker,
    assignment: r.assignment,
    amountPaisa: r.amountPaisa.toString(),
    adjustedPaisa: st.adjusted.toString(),
    outstandingPaisa: st.outstanding.toString(),
    status: st.status,
    settlements: r.allocations.map((x) => ({
      settlementId: x.line.settlement.id,
      weekStart: formatDateOnly(x.line.settlement.weekStart),
      status: x.line.settlement.status,
      amountPaisa: x.amountPaisa.toString(),
    })),
    date: formatDateOnly(r.date),
    paidFrom: r.paidFrom,
    cashAccountId: r.cashAccountId,
    reference: r.reference,
    note: r.note,
    clientId: r.clientId,
    deviceCreatedAt: r.deviceCreatedAt?.toISOString() ?? null,
    createdById: r.createdById,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function createAdvanceTx(tx: Tx, a: Actor, projectId: string, input: AdvanceInput, opts: { at?: Date } = {}): Promise<Created<ReturnType<typeof toDto>>> {
  if (input.clientId) {
    const dup = await tx.advance.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: input.clientId } }, include });
    if (dup) return { created: false, data: toDto(dup) };
  }
  const project = await projectFor(tx, a, projectId, true);
  if (a.role === 'MUNSHI' && input.paidFrom !== 'SITE_CASH') throw new Forbidden('PAID_FROM_NOT_ALLOWED', 'A munshi gives peshgi from site cash only');
  if (input.date > today()) throw new BadRequest('FUTURE_DATE', "Peshgi can't be dated in the future");

  let payee: string;
  let assignmentId: string | null = null;
  if (input.payeeType === 'WORKER') {
    const pw = (await assignedWorkers(tx, a.tenantId, project.id, [input.workerId!], input.date)).get(input.workerId!)!;
    payee = pw.worker.name;
  } else {
    const s = await findAssignment(tx, a, input.assignmentId!);
    if (s.projectId !== project.id) throw new BadRequest('INVALID_ASSIGNMENT', 'This sub-contract is on another project');
    payee = s.subcontractor.name;
    assignmentId = s.id;
  }
  const account = input.paidFrom === 'SITE_CASH' ? await payingAccount(tx, a, input.cashAccountId) : null;
  const at = opts.at ?? occurredAtFor(input.date);

  const adv: Advance = await tx.advance.create({
    data: {
      tenantId: a.tenantId,
      projectId: project.id,
      payeeType: input.payeeType,
      workerId: input.payeeType === 'WORKER' ? input.workerId! : null,
      assignmentId,
      amountPaisa: input.amountPaisa,
      date: dateOnly(input.date),
      paidFrom: input.paidFrom,
      cashAccountId: account?.id ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
      clientId: input.clientId ?? null,
      deviceCreatedAt: input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null,
      createdById: a.userId,
      ...(opts.at ? { createdAt: opts.at } : {}),
    },
  });
  if (account) {
    await spend(tx, a.tenantId, {
      accountId: account.id,
      projectId: project.id,
      type: 'PESHGI',
      amountPaisa: input.amountPaisa,
      description: `Peshgi — ${payee}`,
      status: 'POSTED',
      costBucket: 'LABOR',
      method: cashMethodOf(input.paidFrom),
      reference: input.reference ?? null,
      refType: 'ADVANCE',
      refId: adv.id,
      occurredAt: at,
      createdAt: opts.at,
      createdById: a.userId,
    });
  }
  if (assignmentId) {
    await postSubLedger(tx, a, { assignmentId, type: 'ADVANCE', amountPaisa: -input.amountPaisa, refType: 'ADVANCE', refId: adv.id, occurredAt: at, note: input.note ?? 'Peshgi' });
  }
  await audit(tx, a, 'advance.create', 'Advance', adv.id, { payee, payeeType: input.payeeType, amountPaisa: input.amountPaisa.toString(), paidFrom: input.paidFrom });
  return { created: true, data: toDto(await tx.advance.findUniqueOrThrow({ where: { id: adv.id }, include })) };
}

export async function createAdvance(projectId: string, input: AdvanceInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => createAdvanceTx(tx, a, projectId, input));
}

export async function listAdvances(projectId: string, query: AdvancesQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    await projectFor(tx, a, projectId);
    const where: Prisma.AdvanceWhereInput = {
      tenantId: a.tenantId,
      projectId,
      ...(query.payeeType ? { payeeType: query.payeeType } : {}),
      ...(query.workerId ? { workerId: query.workerId } : {}),
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
      ...(query.from || query.to ? { date: { ...(query.from ? { gte: dateOnly(query.from) } : {}), ...(query.to ? { lte: dateOnly(query.to) } : {}) } } : {}),
    };
    // Status is derived, so filter in memory (a project has hundreds of advances, not millions).
    const rows = (await tx.advance.findMany({ where, include, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] })).map(toDto);
    const filtered = query.status ? rows.filter((r) => r.status === query.status) : rows;
    const sum = (xs: typeof rows, k: 'amountPaisa' | 'outstandingPaisa') => xs.reduce((s, r) => s + BigInt(r[k]), 0n).toString();
    const start = (query.page - 1) * query.limit;
    return {
      data: filtered.slice(start, start + query.limit),
      meta: { ...pageMeta(query, filtered.length), totalPaisa: sum(filtered, 'amountPaisa'), outstandingPaisa: sum(filtered, 'outstandingPaisa') },
    };
  });
}
