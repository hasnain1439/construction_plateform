/** Project codes like MSB-2026-015: company initials + year + per-company counter. */
import type { Tx } from '../../core/db/withTenant.js';

const STOP_WORDS = new Set(['and', 'of', 'the', 'co', 'pvt', 'ltd']);

/** "malik-and-sons-builders" → "MSB"; one-word slugs use their first three letters. */
export function codePrefix(slug: string): string {
  const words = slug
    .split('-')
    .filter((w) => w && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  if (!words.length) return 'PRJ';
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/**
 * Next free code for the year: highest existing `<prefix>-<year>-NNN` + 1. Holds a
 * per-company advisory lock for the rest of the transaction so parallel creates can't
 * pick the same number.
 */
export async function nextProjectCode(tx: Tx, tenantId: string, slug: string, year: number): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project-code:${tenantId}`}))`;
  const base = `${codePrefix(slug)}-${year}-`;
  const rows = await tx.project.findMany({ where: { tenantId, code: { startsWith: base } }, select: { code: true } });
  const max = rows.reduce((m, r) => {
    const n = Number(r.code.slice(base.length));
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return `${base}${String(max + 1).padStart(3, '0')}`;
}
