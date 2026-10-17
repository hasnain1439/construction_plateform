/**
 * Step 12 · Daily quote expiry (01:00 Asia/Karachi). A SENT / NEGOTIATION quote whose validUntil is
 * before today becomes EXPIRED (DRAFT quotes were never offered, so they don't expire). Safe to
 * repeat: an expired quote no longer matches. Cross-tenant, so it runs as prismaAdmin like the
 * other jobs; each change is audited as SYSTEM.
 */
import { writeAudit } from '../core/audit/audit.js';
import { prismaAdmin } from '../core/db/prisma.js';
import { dateOnly, todayIn } from '../core/utils/dates.js';

export async function runQuoteExpiry(now = new Date()): Promise<{ expired: string[]; checked: number }> {
  const day = todayIn('Asia/Karachi', now);
  const due = await prismaAdmin.quote.findMany({
    where: { status: { in: ['SENT', 'NEGOTIATION'] }, validUntil: { lt: dateOnly(day) } },
    select: { id: true, tenantId: true, number: true, status: true, validUntil: true },
  });
  const expired: string[] = [];
  for (const q of due) {
    const changed = await prismaAdmin.$transaction(async (tx) => {
      const res = await tx.quote.updateMany({ where: { id: q.id, status: { in: ['SENT', 'NEGOTIATION'] } }, data: { status: 'EXPIRED', expiredAt: now } });
      if (!res.count) return false;
      await writeAudit(tx, {
        tenantId: q.tenantId,
        actorType: 'SYSTEM',
        action: 'quote.expire',
        entityType: 'Quote',
        entityId: q.id,
        details: { number: q.number, from: q.status, validUntil: q.validUntil.toISOString().slice(0, 10) },
      });
      return true;
    });
    if (changed) expired.push(q.id);
  }
  return { expired, checked: due.length };
}
