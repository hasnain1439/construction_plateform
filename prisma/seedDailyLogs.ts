/**
 * Malik & Sons daily logs (Phase 1 · Step 10): Rafaqat's site diary for DHA Phase 6 over the
 * last 5 days, with a placeholder photo each day, one entry that reached the server late (its
 * phone was offline for ~2.5 days), and the two munshi phones (Rafaqat synced, Asif with 12
 * entries waiting). Skipped when the company already has daily logs.
 */
import { crc32, deflateSync } from 'node:zlib';
import { dateOnly, todayIn } from '../src/core/utils/dates.js';
import { uuidv7 } from '../src/core/utils/uuid.js';
import type { PrismaClient, SiteCondition } from '../src/generated/prisma/client.js';
import { storage } from '../src/modules/attachments/storage.provider.js';
import { addDays } from '../src/modules/labor/labor.shared.js';

export interface DailyLogsSeedInput {
  tenantId: string;
  rafaqatId: string;
  asifId: string;
  projects: { dha: { id: string } };
}

/** A small solid-colour PNG (a stand-in for a site photo). */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PKT = 'Asia/Karachi';
const at = (day: string, hour: number, minute = 0) => new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:00`);

export async function seedMalikDailyLogs(db: PrismaClient, s: DailyLogsSeedInput, now = new Date()): Promise<{ skipped: boolean }> {
  if (await db.dailyLog.count({ where: { tenantId: s.tenantId } })) return { skipped: true };
  const today = todayIn(PKT, now);
  const day = (n: number) => addDays(today, -n);

  const photo = async (color: [number, number, number], name: string) => {
    const id = uuidv7();
    const png = solidPng(320, 240, color);
    let key = `${s.tenantId}/${today.slice(0, 4)}/${today.slice(5, 7)}/${id}.png`;
    try {
      key = await storage().put(key, png, 'image/png');
    } catch {
      // keep the key; only the preview is missing
    }
    await db.attachment.create({ data: { id, tenantId: s.tenantId, kind: 'SITE_PHOTO', storageKey: key, fileName: name, mimeType: 'image/png', sizeBytes: png.length, uploadedById: s.rafaqatId } });
    return id;
  };

  const logs: Array<{ n: number; conditions: SiteCondition[]; workDone: string; note: string | null; color: [number, number, number]; deviceAt?: Date; createdAt: Date }> = [
    { n: 4, conditions: ['NORMAL'], workDone: 'Steel fixing for first-floor columns; shuttering props checked', note: null, color: [148, 163, 184], createdAt: at(day(4), 18, 5) },
    { n: 3, conditions: ['CURING'], workDone: '1F column curing day 7, water given twice', note: 'Phone had no signal on site — entered offline', color: [37, 99, 235], deviceAt: at(day(3), 18, 10), createdAt: at(day(0), 8, 30) },
    { n: 2, conditions: ['POWER_CUT', 'CURING'], workDone: 'Ground-floor partition brickwork; 1F column curing day 8', note: 'Power cut 2–5 PM, mixer stopped — brickwork by hand', color: [245, 158, 11], createdAt: at(day(2), 18, 20) },
    { n: 1, conditions: ['CURING', 'MATERIAL_SHORT'], workDone: '1F column curing day 9; plaster started on boundary wall', note: 'Sand ran short in the evening — told Bilal sahib', color: [5, 150, 105], createdAt: at(day(1), 18, 0) },
    { n: 0, conditions: ['CURING', 'POWER_CUT'], workDone: '1F column curing day 10, water given twice', note: 'Power cut 2–5 PM', color: [139, 92, 246], createdAt: at(day(0), 17, 45) },
  ];
  for (const l of logs) {
    if (l.createdAt > now) l.createdAt = now;
    await db.dailyLog.create({
      data: {
        tenantId: s.tenantId,
        projectId: s.projects.dha.id,
        logDate: dateOnly(day(l.n)),
        conditions: l.conditions,
        workDone: l.workDone,
        note: l.note,
        photoAttachmentIds: [await photo(l.color, `site-${day(l.n)}.png`)],
        createdById: s.rafaqatId,
        clientId: uuidv7(),
        deviceCreatedAt: l.deviceAt ?? l.createdAt,
        createdAt: l.createdAt,
      },
    });
  }

  const device = (userId: string, clientDeviceId: string, model: string, pendingUploads: number, lastSyncAt: Date) =>
    db.device.upsert({
      where: { userId_clientDeviceId: { userId, clientDeviceId } },
      create: { tenantId: s.tenantId, userId, clientDeviceId, platform: 'ANDROID', model, appVersion: '1.0.0', pendingUploads, lastSyncAt, lastActiveAt: lastSyncAt },
      update: { model, pendingUploads, lastSyncAt },
    });
  await device(s.rafaqatId, 'seed-rafaqat-infinix-hot30', 'Infinix Hot 30', 0, new Date(now.getTime() - 10 * 60_000));
  await device(s.asifId, 'seed-asif-tecno-spark10', 'Tecno Spark 10', 12, new Date(now.getTime() - 2 * 86_400_000));
  return { skipped: false };
}
