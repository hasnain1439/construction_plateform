/** B2 — hazri: one row per worker per day; a submitted / approved week is locked. */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly } from '../../core/utils/dates.js';
import { Prisma } from '../../core/db/prisma.js';
import { assignedWorkers } from './assignments.service.js';
import type { AttendanceInput, AttendanceQuery } from './labor.schema.js';
import { actor, addDays, audit, laborSettings, num, projectFor, today, weekdayOf, weekOf, type Actor } from './labor.shared.js';

/** Munshis may fill in at most this many days back; the office any open week. */
export const MUNSHI_BACKDATE_DAYS = 7;
const MAX_RANGE_DAYS = 62;
const LOCKING: Array<'SUBMITTED' | 'APPROVED'> = ['SUBMITTED', 'APPROVED'];

/** 409 WEEK_LOCKED when the week of any of `dates` has a submitted / approved settlement. */
export async function assertWeeksOpen(tx: Tx, tenantId: string, projectId: string, dates: string[]) {
  const s = await laborSettings(tx, tenantId);
  const starts = [...new Set(dates.map((d) => weekOf(d, s.weekStart).weekStart))];
  const locked = await tx.wageSettlement.findFirst({
    where: { tenantId, projectId, weekStart: { in: starts.map(dateOnly) }, status: { in: LOCKING } },
    select: { id: true, weekStart: true, status: true },
  });
  if (locked) {
    throw new Conflict('WEEK_LOCKED', `The week of ${formatDateOnly(locked.weekStart)} is ${locked.status.toLowerCase()} — ask the office to return it to change hazri`, {
      settlementId: locked.id,
      weekStart: formatDateOnly(locked.weekStart),
      status: locked.status,
    });
  }
}

export async function markAttendanceTx(tx: Tx, a: Actor, projectId: string, input: AttendanceInput, opts: { at?: Date } = {}) {
  const project = await projectFor(tx, a, projectId, true);
  const now = today();
  if (input.date > now) throw new BadRequest('FUTURE_DATE', "Hazri can't be marked for a future day");
  if (a.role === 'MUNSHI' && input.date < addDays(now, -MUNSHI_BACKDATE_DAYS)) {
    throw new BadRequest('DATE_TOO_OLD', `A munshi can fill hazri for the last ${MUNSHI_BACKDATE_DAYS} days only — ask the office`, { maxDaysBack: MUNSHI_BACKDATE_DAYS });
  }
  await assertWeeksOpen(tx, a.tenantId, project.id, [input.date]);
  await assignedWorkers(
    tx,
    a.tenantId,
    project.id,
    input.entries.map((e) => e.workerId),
    input.date,
  );

  const date = dateOnly(input.date);
  const device = input.deviceCreatedAt ? new Date(input.deviceCreatedAt) : null;
  let created = 0;
  let updated = 0;
  for (const e of input.entries) {
    const overtimeHours = new Prisma.Decimal(e.status === 'ABSENT' ? 0 : (e.overtimeHours ?? 0));
    const key = { projectId_workerId_date: { projectId: project.id, workerId: e.workerId, date } };
    const before = await tx.attendance.findUnique({ where: key });
    await tx.attendance.upsert({
      where: key,
      create: {
        tenantId: a.tenantId,
        projectId: project.id,
        workerId: e.workerId,
        date,
        status: e.status,
        overtimeHours,
        note: e.note ?? null,
        markedById: a.userId,
        clientId: input.clientId ?? null,
        deviceCreatedAt: device,
        ...(opts.at ? { createdAt: opts.at } : {}),
      },
      update: { status: e.status, overtimeHours, note: e.note ?? null, markedById: a.userId, deviceCreatedAt: device },
    });
    if (before) updated++;
    else created++;
  }
  await audit(tx, a, 'attendance.mark', 'Project', project.id, { date: input.date, created, updated, workers: input.entries.length });
  return { date: input.date, created, updated, day: await dayOf(tx, a, project.id, input.date) };
}

export async function markAttendance(projectId: string, input: AttendanceInput) {
  const a = actor();
  return withTenant(a.tenantId, (tx) => markAttendanceTx(tx, a, projectId, input));
}

/** Everyone on the project that day with their mark (null = not marked yet). */
async function dayOf(tx: Tx, a: Actor, projectId: string, date: string) {
  const day = dateOnly(date);
  const workers = await tx.projectWorker.findMany({
    where: { tenantId: a.tenantId, projectId, OR: [{ isActive: true }, { endDate: { gte: day } }] },
    include: { worker: { select: { id: true, name: true, type: true } } },
    orderBy: { worker: { name: 'asc' } },
  });
  const marks = await tx.attendance.findMany({ where: { tenantId: a.tenantId, projectId, date: day } });
  const byWorker = new Map(marks.map((m) => [m.workerId, m]));
  const extra = marks.filter((m) => !workers.some((w) => w.workerId === m.workerId));
  const extraWorkers = extra.length ? await tx.worker.findMany({ where: { tenantId: a.tenantId, id: { in: extra.map((m) => m.workerId) } }, select: { id: true, name: true, type: true } }) : [];
  const rows = [...workers.map((w) => w.worker), ...extraWorkers].map((w) => {
    const m = byWorker.get(w.id);
    return { worker: w, status: m?.status ?? null, overtimeHours: m ? num(m.overtimeHours)! : 0, note: m?.note ?? null };
  });
  const count = (s: string | null) => rows.filter((r) => r.status === s).length;
  return {
    date,
    weekday: weekdayOf(date),
    assigned: rows.length,
    marked: rows.length - count(null),
    full: count('FULL'),
    half: count('HALF'),
    absent: count('ABSENT'),
    unmarked: count(null),
    overtimeHours: rows.reduce((s, r) => s + r.overtimeHours, 0),
    workers: rows,
  };
}

export async function todayAttendance(projectId: string) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await projectFor(tx, a, projectId);
    const date = today();
    const s = await laborSettings(tx, a.tenantId);
    const week = weekOf(date, s.weekStart);
    const settlement = await tx.wageSettlement.findUnique({ where: { projectId_weekStart: { projectId: project.id, weekStart: dateOnly(week.weekStart) } }, select: { status: true } });
    return { ...(await dayOf(tx, a, project.id, date)), workingDay: s.workingDays.includes(weekdayOf(date)), locked: settlement ? LOCKING.includes(settlement.status as 'APPROVED') : false };
  });
}

/** Grid for a date range (default: the current settlement week): rows = workers, columns = days. */
export async function attendanceGrid(projectId: string, query: AttendanceQuery) {
  const a = actor();
  return withTenant(a.tenantId, async (tx) => {
    const project = await projectFor(tx, a, projectId);
    const s = await laborSettings(tx, a.tenantId);
    const current = weekOf(query.from ?? today(), s.weekStart);
    const from = query.from ?? current.weekStart;
    const to = query.to ?? (query.from ? addDays(from, 6) : current.weekEnd);
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      dates.push(d);
      if (dates.length > MAX_RANGE_DAYS) throw new BadRequest('RANGE_TOO_LONG', `Show at most ${MAX_RANGE_DAYS} days at a time`);
    }

    const marks = await tx.attendance.findMany({
      where: { tenantId: a.tenantId, projectId: project.id, date: { gte: dateOnly(from), lte: dateOnly(to) } },
      orderBy: { date: 'asc' },
    });
    const assigned = await tx.projectWorker.findMany({
      where: { tenantId: a.tenantId, projectId: project.id, OR: [{ isActive: true }, { endDate: { gte: dateOnly(from) } }, { workerId: { in: marks.map((m) => m.workerId) } }] },
      include: { worker: { select: { id: true, name: true, type: true } } },
      orderBy: { worker: { name: 'asc' } },
    });

    const workers = assigned.map((pw) => {
      const mine = marks.filter((m) => m.workerId === pw.workerId);
      const days: Record<string, { status: string; overtimeHours: number; note: string | null }> = {};
      for (const m of mine) days[formatDateOnly(m.date)] = { status: m.status, overtimeHours: num(m.overtimeHours)!, note: m.note };
      const full = mine.filter((m) => m.status === 'FULL').length;
      const half = mine.filter((m) => m.status === 'HALF').length;
      return {
        projectWorkerId: pw.id,
        worker: pw.worker,
        dailyRatePaisa: pw.dailyRatePaisa.toString(),
        isActive: pw.isActive,
        days,
        totals: {
          full,
          half,
          absent: mine.filter((m) => m.status === 'ABSENT').length,
          daysWorked: full + half * 0.5,
          overtimeHours: mine.reduce((sum, m) => sum + Number(m.overtimeHours), 0),
        },
      };
    });

    const dayTotals = dates.map((d) => {
      const day = marks.filter((m) => formatDateOnly(m.date) === d);
      return {
        date: d,
        weekday: weekdayOf(d),
        workingDay: s.workingDays.includes(weekdayOf(d)),
        full: day.filter((m) => m.status === 'FULL').length,
        half: day.filter((m) => m.status === 'HALF').length,
        absent: day.filter((m) => m.status === 'ABSENT').length,
        unmarked: Math.max(0, workers.filter((w) => w.isActive).length - day.length),
      };
    });

    const settlements = await tx.wageSettlement.findMany({
      where: { tenantId: a.tenantId, projectId: project.id, weekStart: { gte: dateOnly(weekOf(from, s.weekStart).weekStart), lte: dateOnly(to) } },
      select: { id: true, weekStart: true, status: true },
    });
    return {
      from,
      to,
      dates,
      weekStart: s.weekStart,
      workers,
      dayTotals,
      totals: {
        daysWorked: workers.reduce((sum, w) => sum + w.totals.daysWorked, 0),
        overtimeHours: workers.reduce((sum, w) => sum + w.totals.overtimeHours, 0),
      },
      weeks: settlements.map((x) => ({ settlementId: x.id, weekStart: formatDateOnly(x.weekStart), status: x.status, locked: LOCKING.includes(x.status as 'APPROVED') })),
    };
  });
}
