/**
 * Ageing buckets shared by receivables (age = days since the invoice was issued) and supplier
 * udhaar (age = days since the unpaid purchase, FIFO).
 */
export const AGEING_BUCKETS = ['0-15', '16-30', '31-60', '60+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const bucketOf = (days: number): AgeingBucket => (days <= 15 ? '0-15' : days <= 30 ? '16-30' : days <= 60 ? '31-60' : '60+');

export function ageing(items: Array<{ days: number; amountPaisa: bigint }>): Record<AgeingBucket, bigint> {
  const out = { '0-15': 0n, '16-30': 0n, '31-60': 0n, '60+': 0n } as Record<AgeingBucket, bigint>;
  for (const i of items) out[bucketOf(i.days)] += i.amountPaisa;
  return out;
}

export function addAgeing(a: Record<AgeingBucket, bigint>, b: Record<AgeingBucket, bigint>): Record<AgeingBucket, bigint> {
  return Object.fromEntries(AGEING_BUCKETS.map((k) => [k, a[k] + b[k]])) as Record<AgeingBucket, bigint>;
}

export const ageingDto = (r: Record<AgeingBucket, bigint>) => AGEING_BUCKETS.map((bucket) => ({ bucket, amountPaisa: r[bucket].toString() }));
