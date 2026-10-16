/**
 * Step 13 seed: the schedule of Malik & Sons' "DHA Phase 6 · 10 Marla", generated from its
 * APPROVED estimate (Rev 1, prisma/seedEstimate.ts) on the company calendar, with the frozen
 * baseline, and the site's story so far (Rafaqat's updates through the real services):
 *   foundation & plinth DONE · ground floor walls + slab DONE (slab cast late, 20 Aug)
 *   first-floor walls CURING (finished 4 days ago) · first-floor slab IN_PROGRESS (20 %)
 *   one APPROVED RAIN stoppage (9–8 days ago → the plan is pushed, version 2)
 *   one PENDING SMOG_BAN stoppage (2 days ago)
 * Usage entries of the project (when the stock demo is loaded) are linked to the milestone
 * that was running that day, so "Milestones & Quotas" shows planned vs used.
 * Idempotent: skipped when the project already has a schedule.
 */
import { withTenant, type Tx } from '../src/core/db/withTenant.js';
import { dateOnly, todayIn } from '../src/core/utils/dates.js';
import { uuidv7 } from '../src/core/utils/uuid.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { storage } from '../src/modules/attachments/storage.provider.js';
import { updateProgressTx } from '../src/modules/schedule/progress.service.js';
import { generateInTx } from '../src/modules/schedule/schedule.service.js';
import { approveStoppageTx, createStoppageTx } from '../src/modules/schedule/stoppages.service.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const daysAgo = (n: number) => new Date(Date.parse(`${todayIn('Asia/Karachi')}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const at = (date: string, hourPkt = 17) => new Date(`${date}T${String(hourPkt - 5).padStart(2, '0')}:00:00.000Z`);

export interface ScheduleSeedInput {
  tenantId: string;
  ownerId: string;
  rafaqatId: string;
  dhaProjectId: string;
}

async function photo(tx: Tx, tenantId: string, userId: string) {
  const id = uuidv7();
  let key = `${tenantId}/2026/10/${id}.png`;
  try {
    key = await storage().put(key, PNG, 'image/png');
  } catch {
    // keep the key; only the preview is missing
  }
  await tx.attachment.create({ data: { id, tenantId, kind: 'SITE_PHOTO', storageKey: key, fileName: 'site.png', mimeType: 'image/png', sizeBytes: PNG.length, uploadedById: userId } });
  return id;
}

export async function seedMalikSchedule(db: PrismaClient, t: ScheduleSeedInput): Promise<{ skipped: boolean }> {
  if (await db.schedule.count({ where: { projectId: t.dhaProjectId } })) return { skipped: true };
  if (!(await db.estimate.count({ where: { projectId: t.dhaProjectId, status: 'APPROVED' } }))) return { skipped: true };
  let scheduleId = '';
  const made = new Date('2026-03-10T10:00:00+05:00');
  const owner = { tenantId: t.tenantId, userId: t.ownerId, role: 'THEKEDAR' as const };
  const munshi = { tenantId: t.tenantId, userId: t.rafaqatId, role: 'MUNSHI' as const };
  await withTenant(
    t.tenantId,
    async (tx) => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: t.dhaProjectId } });
      scheduleId = await generateInTx(tx, owner, project, { startDate: '2026-03-16', teams: 2, note: 'Plan shared with the owner at the estimate meeting' }, { audit: false });
      await tx.schedule.update({ where: { id: scheduleId }, data: { generatedAt: made } });

      const ms = new Map((await tx.milestone.findMany({ where: { scheduleId } })).map((m) => [m.key, m]));
      const step = async (key: string, input: Parameters<typeof updateProgressTx>[3]) => {
        const m = ms.get(key);
        if (!m) return;
        await updateProgressTx(tx, munshi, m.id, input, { at: at(input.date!) });
      };
      // Foundation & plinth
      await step('FOUNDATION_PLINTH.EXCAVATION', { status: 'IN_PROGRESS', date: '2026-03-16', note: 'Khudai shuru — layout checked with the owner' });
      await step('FOUNDATION_PLINTH.EXCAVATION', { progressPercent: 100, date: '2026-03-21' });
      await step('FOUNDATION_PLINTH.FOUNDATION', { status: 'IN_PROGRESS', date: '2026-03-23' });
      await step('FOUNDATION_PLINTH.FOUNDATION', { progressPercent: 100, date: '2026-04-18', note: 'DPC done, curing' });
      await step('FOUNDATION_PLINTH.FOUNDATION', { status: 'DONE', date: '2026-04-25' });
      await step('FOUNDATION_PLINTH.PLINTH_FILL', { status: 'IN_PROGRESS', date: '2026-04-27' });
      await step('FOUNDATION_PLINTH.PLINTH_FILL', { progressPercent: 100, date: '2026-05-04' });
      // Ground floor
      await step('GF_STRUCTURE.WALLS', { status: 'IN_PROGRESS', date: '2026-05-06' });
      await step('GF_STRUCTURE.WALLS', { progressPercent: 55, date: '2026-05-25', note: 'Bricks short for 3 days' });
      await step('GF_STRUCTURE.WALLS', { progressPercent: 100, date: '2026-06-10' });
      await step('GF_STRUCTURE.WALLS', { status: 'DONE', date: '2026-06-17' });
      await step('GF_STRUCTURE.SLAB', { status: 'IN_PROGRESS', date: '2026-06-20', note: 'Shuttering started' });
      await step('GF_STRUCTURE.SLAB', { progressPercent: 60, date: '2026-07-28', note: 'Steel late from the dealer' });
      await step('GF_STRUCTURE.SLAB', { progressPercent: 100, date: '2026-08-20', note: 'Lenter cast — curing 14 days' });
      await step('GF_STRUCTURE.SLAB', { status: 'DONE', date: '2026-09-03' });
      // First floor: walls curing, slab started
      await step('F1_STRUCTURE.WALLS', { status: 'IN_PROGRESS', date: '2026-09-08' });
      await step('F1_STRUCTURE.WALLS', { progressPercent: 70, date: daysAgo(15) });
      await step('F1_STRUCTURE.WALLS', { progressPercent: 100, date: daysAgo(4), note: 'Columns cast, curing' });
      await step('F1_STRUCTURE.SLAB', { status: 'IN_PROGRESS', date: daysAgo(2), note: 'Shuttering plates arrived' });
      await step('F1_STRUCTURE.SLAB', { progressPercent: 20, date: daysAgo(1) });

      // Stoppage days: rain (approved → plan pushed) and a smog ban (pending)
      const rain = await createStoppageTx(tx, munshi, project.id, { dates: [daysAgo(9), daysAgo(8)], reason: 'RAIN', note: 'Heavy rain, water standing on the slab area', photoAttachmentIds: [await photo(tx, t.tenantId, t.rafaqatId)] });
      await approveStoppageTx(tx, owner, rain.stoppage.id, { note: 'Rain confirmed' }, { at: at(daysAgo(8), 18) });
      await createStoppageTx(tx, munshi, project.id, { dates: [daysAgo(2)], reason: 'SMOG_BAN', note: 'Construction ban announced by the district', photoAttachmentIds: [await photo(tx, t.tenantId, t.rafaqatId)] });

      // Usage entries → the milestone running that day
      const rows = await tx.milestone.findMany({ where: { scheduleId }, select: { id: true, actualStart: true, actualEnd: true, status: true } });
      const usages = await tx.materialUsage.findMany({ where: { tenantId: t.tenantId, projectId: project.id, milestoneId: null }, select: { id: true, usageDate: true } });
      for (const u of usages) {
        const m = rows
          .filter((r) => r.actualStart && r.actualStart <= u.usageDate && (r.actualEnd ?? dateOnly('9999-12-31')) >= u.usageDate)
          .sort((a, b) => (b.actualStart!.getTime() - a.actualStart!.getTime()))[0];
        if (m) await tx.materialUsage.update({ where: { id: u.id }, data: { milestoneId: m.id } });
      }
    },
    { timeout: 120_000 },
  );
  // Made in March (the admin client may correct the frozen rows' timestamps; the app cannot).
  await db.scheduleBaseline.updateMany({ where: { scheduleId }, data: { createdAt: made } });
  await db.schedulePlanVersion.updateMany({ where: { scheduleId, version: 1 }, data: { createdAt: made } });
  return { skipped: false };
}
