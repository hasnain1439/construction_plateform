/**
 * Company-level labour reads for the office: one worker / sub-contractor across projects,
 * and the dashboard overview (hazri today, peshgi and kharcha this week, cash with site
 * staff, what waits for approval). PM: only their projects.
 */
import { withTenant } from '../../core/db/withTenant.js';
import { NotFound } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import { totalsOf } from '../cashbook/cash.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { projectScope } from '../projects/access.js';
import { advanceState } from './advances.service.js';
import { toAssignmentDto } from './assignments.service.js';
import { actor, addDays, assertOffice, laborSettings, today, weekOf } from './labor.shared.js';
import { accountDto, subAccounts } from './subcontractLedger.js';

const projectRef = { select: { id: true, code: true, name: true, status: true } } as const;

export async function workerSummary(workerId: string) {
  const a = actor();
  assertOffice(a);
  return withTenant(a.tenantId, async (tx) => {
    const worker = await tx.worker.findFirst({ where: { tenantId: a.tenantId, id: workerId }, select: { id: true, name: true, type: true, phone: true, dailyRatePaisa: true, isActive: true } });
    if (!worker) throw new NotFound('WORKER_NOT_FOUND', 'Worker not found');
    const scope = { project: projectScope(a) };
    const assignments = await tx.projectWorker.findMany({ where: { tenantId: a.tenantId, workerId, ...scope }, include: { project: projectRef }, orderBy: { startDate: 'desc' } });
    const advances = await tx.advance.findMany({
      where: { tenantId: a.tenantId, workerId, ...scope },
      include: { project: projectRef, allocations: { select: { amountPaisa: true, line: { select: { settlement: { select: { status: true } } } } } } },
      orderBy: { date: 'desc' },
    });
    const lines = await tx.wageSettlementLine.findMany({
      where: { tenantId: a.tenantId, workerId, settlement: scope },
      include: { settlement: { select: { id: true, weekStart: true, status: true, project: projectRef } } },
      orderBy: { settlement: { weekStart: 'desc' } },
      take: 12,
    });
    const s = await laborSettings(tx, a.tenantId);
    const week = weekOf(today(), s.weekStart);
    const thisWeek = await tx.attendance.findMany({ where: { tenantId: a.tenantId, workerId, date: { gte: dateOnly(week.weekStart), lte: dateOnly(week.weekEnd) }, ...scope } });
    const outstanding = advances.reduce((sum, adv) => sum + advanceState(adv).outstanding, 0n);
    return {
      worker: { ...worker, dailyRatePaisa: worker.dailyRatePaisa.toString() },
      projects: assignments.map((pw) => ({
        projectWorkerId: pw.id,
        project: pw.project,
        dailyRatePaisa: pw.dailyRatePaisa.toString(),
        startDate: formatDateOnly(pw.startDate),
        endDate: pw.endDate ? formatDateOnly(pw.endDate) : null,
        isActive: pw.isActive,
      })),
      thisWeek: { weekStart: week.weekStart, daysWorked: thisWeek.reduce((n, m) => n + (m.status === 'FULL' ? 1 : m.status === 'HALF' ? 0.5 : 0), 0) },
      outstandingAdvancePaisa: outstanding.toString(),
      advances: advances.slice(0, 20).map((adv) => ({ id: adv.id, project: adv.project, date: formatDateOnly(adv.date), amountPaisa: adv.amountPaisa.toString(), paidFrom: adv.paidFrom, note: adv.note })),
      settlements: lines.map((l) => ({
        settlementId: l.settlement.id,
        project: l.settlement.project,
        weekStart: formatDateOnly(l.settlement.weekStart),
        status: l.settlement.status,
        daysWorked: Number(l.daysWorked),
        grossPaisa: l.grossPaisa.toString(),
        advanceAdjustedPaisa: l.advanceAdjustedPaisa.toString(),
        netPaisa: l.netPaisa.toString(),
        paymentStatus: l.paymentStatus,
      })),
    };
  });
}

export async function subcontractorSummary(subcontractorId: string) {
  const a = actor();
  assertOffice(a);
  return withTenant(a.tenantId, async (tx) => {
    const sub = await tx.subcontractor.findFirst({ where: { tenantId: a.tenantId, id: subcontractorId }, select: { id: true, name: true, trade: true, phone: true, isActive: true } });
    if (!sub) throw new NotFound('SUBCONTRACTOR_NOT_FOUND', 'Sub-contractor not found');
    const rows = await tx.subcontractAssignment.findMany({
      where: { tenantId: a.tenantId, subcontractorId, project: projectScope(a) },
      include: { subcontractor: { select: { id: true, name: true, trade: true, phone: true } }, project: projectRef },
      orderBy: { startDate: 'desc' },
    });
    const accounts = await subAccounts(tx, a.tenantId, rows);
    const items = rows.map((r) => ({ ...toAssignmentDto(r, a), project: r.project, account: accountDto(accounts.get(r.id)!) }));
    const sum = (k: 'valuePaisa' | 'paidPaisa' | 'retentionHeldPaisa' | 'balanceDuePaisa') => [...accounts.values()].reduce((s, x) => s + x[k], 0n).toString();
    return { subcontractor: sub, assignments: items, totals: { valuePaisa: sum('valuePaisa'), paidPaisa: sum('paidPaisa'), retentionHeldPaisa: sum('retentionHeldPaisa'), balanceDuePaisa: sum('balanceDuePaisa') } };
  });
}

/** Dashboard: today's hazri and this week's money across the caller's projects. */
export async function laborOverview() {
  const a = actor();
  assertOffice(a);
  return withTenant(a.tenantId, async (tx) => {
    const projects = await tx.project.findMany({ where: { tenantId: a.tenantId, status: { in: ['ACTIVE', 'CLOSEOUT'] }, ...projectScope(a) }, select: { id: true } });
    const ids = projects.map((p) => p.id);
    const date = today();
    const s = await laborSettings(tx, a.tenantId);
    const week = weekOf(date, s.weekStart);
    const assigned = await tx.projectWorker.count({ where: { tenantId: a.tenantId, projectId: { in: ids }, isActive: true } });
    const marks = await tx.attendance.groupBy({ by: ['status'], where: { tenantId: a.tenantId, projectId: { in: ids }, date: dateOnly(date) }, _count: true });
    const count = (st: string) => marks.find((m) => m.status === st)?._count ?? 0;
    const peshgi = await tx.advance.aggregate({ where: { tenantId: a.tenantId, projectId: { in: ids }, date: { gte: dateOnly(week.weekStart), lte: dateOnly(week.weekEnd) } }, _sum: { amountPaisa: true } });
    const kharcha = await tx.cashEntry.aggregate({
      where: { tenantId: a.tenantId, projectId: { in: ids }, type: 'EXPENSE', occurredAt: { gte: pktDayStart(week.weekStart), lt: pktDayEnd(week.weekEnd) } },
      _sum: { amountPaisa: true },
    });
    const accountWhere = a.role === 'THEKEDAR' ? { tenantId: a.tenantId, isActive: true } : { tenantId: a.tenantId, isActive: true, OR: [{ holderUserId: a.userId }, { holder: { projectAccess: { some: { projectId: { in: ids } } } } }] };
    const accounts = await tx.cashAccount.findMany({ where: accountWhere, select: { id: true } });
    const totals = [...(await totalsOf(tx, a.tenantId, accounts.map((x) => x.id))).values()];
    const pending = {
      settlements: await tx.wageSettlement.count({ where: { tenantId: a.tenantId, projectId: { in: ids }, status: 'SUBMITTED' } }),
      kharcha: await tx.cashEntry.count({ where: { tenantId: a.tenantId, type: 'EXPENSE', status: 'PENDING_APPROVAL', OR: [{ projectId: { in: ids } }, ...(a.role === 'THEKEDAR' ? [{ projectId: null }] : [])] } }),
      topups: a.role === 'THEKEDAR' ? await tx.topupRequest.count({ where: { tenantId: a.tenantId, status: 'PENDING' } }) : 0,
      measurements: await tx.workMeasurement.count({ where: { tenantId: a.tenantId, projectId: { in: ids }, status: 'RECORDED' } }),
    };
    return {
      date,
      week: { weekStart: week.weekStart, weekEnd: week.weekEnd },
      hazriToday: { assigned, full: count('FULL'), half: count('HALF'), absent: count('ABSENT'), unmarked: Math.max(0, assigned - count('FULL') - count('HALF') - count('ABSENT')) },
      peshgiThisWeekPaisa: (peshgi._sum.amountPaisa ?? 0n).toString(),
      kharchaThisWeekPaisa: (-(kharcha._sum.amountPaisa ?? 0n)).toString(),
      cashWithSiteStaffPaisa: totals.reduce((sum, t) => sum + t.balancePaisa, 0n).toString(),
      pending,
      lastWeekStart: addDays(week.weekStart, -7),
    };
  });
}
