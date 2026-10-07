/**
 * Daily (03:00 PKT): drops SyncChange rows older than 30 days and raises the watermark, so a
 * device whose cursor is below it gets `resetRequired` and does a full resync.
 */
import { prismaAdmin } from '../core/db/prisma.js';

export const SYNC_RETENTION_DAYS = 30;

export async function runSyncRetention(now = new Date(), days = SYNC_RETENTION_DAYS): Promise<{ deleted: number; prunedThroughSeq: string }> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const last = await prismaAdmin.syncChange.aggregate({ where: { changedAt: { lt: cutoff } }, _max: { seq: true } });
  const through = last._max.seq;
  if (!through) {
    const mark = await prismaAdmin.syncWatermark.findUnique({ where: { id: 1 } });
    return { deleted: 0, prunedThroughSeq: (mark?.prunedThroughSeq ?? 0n).toString() };
  }
  const { count } = await prismaAdmin.syncChange.deleteMany({ where: { seq: { lte: through } } });
  await prismaAdmin.syncWatermark.upsert({ where: { id: 1 }, create: { id: 1, prunedThroughSeq: through }, update: { prunedThroughSeq: through } });
  return { deleted: count, prunedThroughSeq: through.toString() };
}
