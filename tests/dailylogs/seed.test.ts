import { describe, expect, it } from 'vitest';
import { seedMalikDailyLogs, solidPng } from '../../prisma/seedDailyLogs.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { contentMatchesMime } from '../../src/modules/attachments/fileTypes.js';
import { useFreshDatabase } from '../helpers.js';
import { api, owner } from '../labor/fixtures.js';

const seeded = useFreshDatabase();

describe('daily logs seed', () => {
  it('5 days of DHA logs with photos, one synced late, and the two munshi phones', async () => {
    const s = seeded();
    const input = { tenantId: s.malik.id, rafaqatId: s.users.rafaqatMalik.id, asifId: s.users.asif.id, projects: s.projects };
    expect(await seedMalikDailyLogs(prismaAdmin, input)).toEqual({ skipped: false });
    expect(await seedMalikDailyLogs(prismaAdmin, input)).toEqual({ skipped: true });
    const logs = (await api().get(`/api/v1/projects/${s.projects.dha.id}/daily-logs`).set(await owner())).body.data;
    expect(logs).toHaveLength(5);
    expect(logs.filter((l: { lateSync: boolean }) => l.lateSync)).toHaveLength(1);
    expect(logs.every((l: { photos: unknown[]; author: { name: string } }) => l.photos.length === 1 && l.author.name === 'Rafaqat Ali')).toBe(true);
    expect(logs[0].workDone).toBe('1F column curing day 10, water given twice');
    const devices = await prismaAdmin.device.findMany({ where: { clientDeviceId: { startsWith: 'seed-' } }, orderBy: { model: 'asc' } });
    expect(devices.map((d) => [d.model, d.pendingUploads])).toEqual([
      ['Infinix Hot 30', 0],
      ['Tecno Spark 10', 12],
    ]);
    expect(contentMatchesMime(solidPng(4, 4, [1, 2, 3]), 'image/png')).toBe(true);
  });
});
