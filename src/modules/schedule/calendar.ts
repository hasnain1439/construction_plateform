/**
 * Working-day calendar of a company (and one project) — pure, no database, no clock.
 *
 * Capacity of a calendar day (share of a normal day's output):
 *   0    weekly off day (TenantSettings.workingDays), NON_WORKING holiday (platform: nationwide or
 *        the company region; company), APPROVED stoppage day of the project
 *   0.5  PARTIAL holiday
 *   × ramadanDayFactor on Ramadan days (company setting, default 0.75)
 * A day with capacity > 0 is a working day. Dates are "YYYY-MM-DD" strings (UTC arithmetic).
 */

export const WEEK_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];
export const DEFAULT_WORKING_DAYS: WeekDay[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/**
 * Approximate Ramadan dates in Pakistan (moon sighting decides — companies can set the real dates
 * in `TenantSettings.ramadanPeriods`).
 */
export const BUILT_IN_RAMADAN: ReadonlyArray<{ start: string; end: string }> = [
  { start: '2025-03-02', end: '2025-03-30' },
  { start: '2026-02-19', end: '2026-03-20' },
  { start: '2027-02-09', end: '2027-03-09' },
  { start: '2028-01-29', end: '2028-02-26' },
  { start: '2029-01-17', end: '2029-02-14' },
  { start: '2030-01-06', end: '2030-02-04' },
];

export interface CalendarHoliday {
  start: string;
  /** null = single day */
  end: string | null;
  name: string;
  type: 'NON_WORKING' | 'PARTIAL';
  source: 'PLATFORM' | 'COMPANY';
}

export interface CalendarInput {
  workingDays: readonly string[];
  holidays: readonly CalendarHoliday[];
  ramadanPeriods: ReadonlyArray<{ start: string; end: string }>;
  ramadanDayFactor: number;
  /** Approved stoppage days of the project (no work). */
  stoppageDates?: readonly string[];
}

const DAY_MS = 86_400_000;
export const toMs = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
export const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY_MS);
export const diffDays = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / DAY_MS);
export const maxDate = (...ds: Array<string | null | undefined>) => ds.filter((d): d is string => Boolean(d)).reduce((a, b) => (b > a ? b : a));
export const weekdayOf = (d: string): WeekDay => WEEK_DAYS[new Date(toMs(d)).getUTCDay()]!;

/** Every day of [start, end] (end inclusive; null = start only). */
export function daysOf(start: string, end: string | null): string[] {
  const out: string[] = [];
  const last = end && end > start ? end : start;
  for (let d = start; d <= last && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Guard against runaway loops (10 years). */
const MAX_DAYS = 3660;

export class WorkCalendar {
  private readonly working: Set<string>;
  private readonly off = new Set<string>();
  private readonly partial = new Set<string>();
  private readonly ramadan = new Set<string>();
  private readonly stopped: Set<string>;
  readonly ramadanDayFactor: number;
  readonly holidayNames = new Map<string, { name: string; type: 'NON_WORKING' | 'PARTIAL'; source: 'PLATFORM' | 'COMPANY' }>();

  constructor(readonly input: CalendarInput) {
    this.working = new Set(input.workingDays.length ? input.workingDays : DEFAULT_WORKING_DAYS);
    for (const h of input.holidays) {
      for (const d of daysOf(h.start, h.end)) {
        if (h.type === 'NON_WORKING') this.off.add(d);
        else this.partial.add(d);
        const prev = this.holidayNames.get(d);
        if (!prev || h.type === 'NON_WORKING') this.holidayNames.set(d, { name: h.name, type: h.type, source: h.source });
      }
    }
    for (const r of input.ramadanPeriods) for (const d of daysOf(r.start, r.end)) this.ramadan.add(d);
    this.ramadanDayFactor = Math.min(1, Math.max(0.1, input.ramadanDayFactor || 1));
    this.stopped = new Set(input.stoppageDates ?? []);
  }

  /** The same company calendar with another set of project stoppage days. */
  withStoppages(dates: readonly string[]): WorkCalendar {
    return new WorkCalendar({ ...this.input, stoppageDates: dates });
  }

  isRamadan(d: string) {
    return this.ramadan.has(d);
  }

  /** Share of a normal day's output on `d` (0 = no work). */
  capacity(d: string, opts: { ignoreStoppages?: boolean } = {}): number {
    if (!this.working.has(weekdayOf(d))) return 0;
    if (this.off.has(d)) return 0;
    if (!opts.ignoreStoppages && this.stopped.has(d)) return 0;
    let c = this.partial.has(d) ? 0.5 : 1;
    if (this.ramadan.has(d)) c *= this.ramadanDayFactor;
    return c;
  }

  isWorking(d: string, opts: { ignoreStoppages?: boolean } = {}) {
    return this.capacity(d, opts) > 0;
  }

  /** First working day on or after `d`. */
  nextWorking(d: string): string {
    let x = d;
    for (let i = 0; i < MAX_DAYS; i++, x = addDays(x, 1)) if (this.isWorking(x)) return x;
    return d;
  }

  /**
   * Works `effort` full days from `start` (a working day): the end day is the day the summed
   * capacity reaches the effort. effort ≤ 0 → ends on the start day. durationDays = working days used.
   */
  walk(start: string, effort: number): { end: string; durationDays: number } {
    const first = this.nextWorking(start);
    if (!(effort > 0)) return { end: first, durationDays: this.isWorking(first) ? 1 : 0 };
    let acc = 0;
    let count = 0;
    let d = first;
    for (let i = 0; i < MAX_DAYS; i++, d = addDays(d, 1)) {
      const c = this.capacity(d);
      if (c <= 0) continue;
      acc += c;
      count += 1;
      if (acc >= effort - 1e-9) return { end: d, durationDays: count };
    }
    return { end: d, durationDays: count };
  }

  /** Working days in (from, to] (company calendar, stoppages ignored unless asked). */
  workingDaysBetween(from: string, to: string, opts: { ignoreStoppages?: boolean } = { ignoreStoppages: true }): number {
    if (to <= from) return 0;
    let n = 0;
    for (let d = addDays(from, 1), i = 0; d <= to && i < MAX_DAYS; d = addDays(d, 1), i++) if (this.isWorking(d, opts)) n += 1;
    return n;
  }

  /** Working days in [from, to] inclusive (stoppages ignored). */
  workingDaysIn(from: string, to: string): number {
    return this.workingDaysBetween(addDays(from, -1), to);
  }

  /** `n` working days after `d` (company calendar, stoppages ignored); n ≤ 0 → d. */
  addWorkingDays(d: string, n: number): string {
    let x = d;
    let left = n;
    for (let i = 0; left > 0 && i < MAX_DAYS; i++) {
      x = addDays(x, 1);
      if (this.isWorking(x, { ignoreStoppages: true })) left -= 1;
    }
    return x;
  }
}

/** Ramadan periods of a company: its own (TenantSettings.ramadanPeriods) or the built-in ones. */
export function ramadanPeriodsOf(stored: unknown): Array<{ start: string; end: string }> {
  if (Array.isArray(stored)) {
    return stored
      .filter((p): p is { start: string; end: string } => Boolean(p) && typeof (p as { start?: unknown }).start === 'string' && typeof (p as { end?: unknown }).end === 'string')
      .map((p) => ({ start: p.start, end: p.end }));
  }
  return BUILT_IN_RAMADAN.map((p) => ({ ...p }));
}
