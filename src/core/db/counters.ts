import type { Tx } from './withTenant.js';

/**
 * Gap-free document numbers per company: PUR-2026-0001, GP-0001, PRN-0001, PO-0001, SC-0001.
 *
 * `format` holds `{YYYY}` (year) and a run of `#`s (zero-padded counter), e.g. "PUR-{YYYY}-####".
 * The counter key is the format with the year filled in and the `#`s dropped, so a yearly
 * series restarts every year. The upsert locks the counter row until the transaction ends:
 * parallel documents wait instead of taking the same number, and a rolled-back document
 * gives its number back.
 */
export async function nextNumber(tx: Tx, tenantId: string, format: string, now: Date = new Date()): Promise<string> {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric' }).format(now);
  const filled = format.replace('{YYYY}', year);
  const digits = /#+/.exec(filled);
  if (!digits) throw new Error(`nextNumber: format "${format}" has no # placeholder`);
  const key = filled.replace(/-?#+/, '');
  const [row] = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "TenantCounter" ("tenantId", "key", "value", "updatedAt")
    VALUES (${tenantId}::uuid, ${key}, 1, now())
    ON CONFLICT ("tenantId", "key") DO UPDATE SET "value" = "TenantCounter"."value" + 1, "updatedAt" = now()
    RETURNING "value"`;
  return filled.replace(digits[0], String(row!.value).padStart(digits[0].length, '0'));
}

/** Moves a series forward so the next number is `next` (seed / data import). Never moves it back. */
export async function setNextNumber(tx: Tx, tenantId: string, key: string, next: number): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "TenantCounter" ("tenantId", "key", "value", "updatedAt")
    VALUES (${tenantId}::uuid, ${key}, ${next - 1}, now())
    ON CONFLICT ("tenantId", "key") DO UPDATE SET "value" = GREATEST("TenantCounter"."value", ${next - 1}), "updatedAt" = now()`;
}

export const NUMBER_FORMATS = {
  purchase: 'PUR-{YYYY}-####',
  dispatch: 'GP-####',
  purchaseReturn: 'PRN-####',
  purchaseOrder: 'PO-####',
  stockCount: 'SC-####',
} as const;
