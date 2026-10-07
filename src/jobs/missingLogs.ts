/**
 * Missing daily-log check (every 15 minutes, advisory-locked like the other jobs). After a
 * company's `missingLogAlertTime` (Asia/Karachi), every ACTIVE project with an assigned munshi
 * that has neither a daily log nor any hazri today gets ONE notification for the day, to its
 * PM(s) and the owner. If a munshi's phone reports entries waiting to upload, the message says
 * so instead ("entries waiting to sync") — the work may be done, just not synced yet.
 */
import { prismaAdmin } from '../core/db/prisma.js';
import { dateOnly, todayIn } from '../core/utils/dates.js';
import { pktDayStart } from '../modules/inventory/inventory.service.js';
import { notify } from '../modules/notifications/notifications.service.js';

const PKT = 'Asia/Karachi';
export const pktTime = (now: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: PKT, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);

export async function runMissingLogCheck(now = new Date()): Promise<{ checked: number; sent: string[] }> {
  const day = todayIn(PKT, now);
  const time = pktTime(now);
  const settings = await prismaAdmin.tenantSettings.findMany({ where: { tenant: { status: 'ACTIVE' } }, select: { tenantId: true, missingLogAlertTime: true } });
  const sent: string[] = [];
  let checked = 0;
  for (const s of settings) {
    if (time < s.missingLogAlertTime) continue;
    const projects = await prismaAdmin.project.findMany({
      where: { tenantId: s.tenantId, status: 'ACTIVE', userAccess: { some: { user: { role: 'MUNSHI', status: 'ACTIVE' } } } },
      select: { id: true, name: true, userAccess: { where: { user: { role: 'MUNSHI', status: 'ACTIVE' } }, select: { userId: true } } },
    });
    for (const p of projects) {
      checked += 1;
      const already = await prismaAdmin.notification.count({ where: { tenantId: s.tenantId, type: 'MISSING_DAILY_LOG', refId: p.id, createdAt: { gte: pktDayStart(day) } } });
      if (already) continue;
      const logged =
        (await prismaAdmin.dailyLog.count({ where: { tenantId: s.tenantId, projectId: p.id, logDate: dateOnly(day) } })) +
        (await prismaAdmin.attendance.count({ where: { tenantId: s.tenantId, projectId: p.id, date: dateOnly(day) } }));
      if (logged) continue;
      const pending = await prismaAdmin.device.aggregate({
        where: { tenantId: s.tenantId, userId: { in: p.userAccess.map((u) => u.userId) }, revokedAt: null },
        _sum: { pendingUploads: true },
      });
      const waiting = pending._sum.pendingUploads ?? 0;
      const ids = await prismaAdmin.$transaction((tx) =>
        notify(tx, {
          tenantId: s.tenantId,
          recipients: ['THEKEDAR', { projectRoles: ['PM'], projectId: p.id }],
          type: 'MISSING_DAILY_LOG',
          severity: 'WARNING',
          title: waiting ? `${p.name}: ${waiting} ${waiting === 1 ? 'entry' : 'entries'} waiting to sync` : `${p.name}: aaj ka log nahi aaya`,
          body: waiting
            ? `The munshi’s phone has ${waiting} unsent ${waiting === 1 ? 'entry' : 'entries'} — no log or hazri has reached the office today yet.`
            : 'No daily log and no hazri for today yet. Call the munshi.',
          projectId: p.id,
          ref: { type: 'PROJECT', id: p.id },
          actionUrl: `/projects/${p.id}/site/daily-logs`,
          actorId: null,
          at: now,
          dedupeMs: 3_600_000,
        }),
      );
      if (ids.length) sent.push(p.id);
    }
  }
  return { checked, sent };
}
