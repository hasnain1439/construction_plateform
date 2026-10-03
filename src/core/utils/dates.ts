import { z } from 'zod';

/** Calendar date "YYYY-MM-DD" (validated as a real date). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, 'Not a real calendar date')
  .meta({ example: '2026-12-25' });

/** "2026-12-25" → Date at UTC midnight (how Postgres DATE columns round-trip). */
export function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Date → "YYYY-MM-DD" (UTC). */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's calendar date in a time zone, e.g. todayIn('Asia/Karachi') → "2026-10-03". */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "15 Oct 2026" in Pakistan time — for SMS and messages. */
export function formatDisplayDate(date: Date, timeZone = 'Asia/Karachi'): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(date);
}
