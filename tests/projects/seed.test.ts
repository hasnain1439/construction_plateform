import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);

describe('seeded projects', () => {
  it('Malik has the 5 projects with codes and statuses; Ahmed has Wapda Town', async () => {
    const list = await api().get('/api/v1/projects?limit=10').set(await owner());
    const byCode = Object.fromEntries(list.body.data.map((p: { code: string; status: string; name: string }) => [p.code, `${p.name} · ${p.status}`]));
    expect(byCode).toEqual({
      'MSB-2026-012': 'DHA Phase 6 · 10 Marla · ACTIVE',
      'MSB-2026-008': 'Johar Town · 5 Marla · ACTIVE',
      'MSB-2026-014': 'Bahria Town · 1 Kanal · ACTIVE',
      'MSB-2025-031': 'Valencia · 7 Marla · HANDED_OVER',
      'MSB-2026-016': 'Model Town · 1 Kanal · DRAFT',
    });
    const wapda = await prismaAdmin.project.findUniqueOrThrow({ where: { id: seeded().projects.ahmedProject.id } });
    expect(wapda).toMatchObject({ code: 'AC-2026-001', name: 'Wapda Town · 5 Marla', status: 'ACTIVE' });
  });

  it('DHA Phase 6 has the full wizard: contract, plot, floors, 17 rooms and a clean review', async () => {
    const auth = await owner();
    const id = seeded().projects.dha.id;
    const p = (await api().get(`/api/v1/projects/${id}`).set(auth)).body.data;
    expect(p).toMatchObject({
      client: { name: 'Ahmed Raza' },
      startDate: '2026-03-15',
      endDate: '2027-02-15',
      team: { pm: { name: 'Bilal Ahmed' }, munshis: [{ name: 'Rafaqat Ali' }] },
      contract: { contractType: 'GREY_OWNER_FINISHING', contractValuePaisa: '1850000000', retentionPercent: 5, defectPeriodMonths: 6 },
      plot: { plotUnit: 'MARLA', plotSize: 10, marlaStandard: 225, frontFt: 35, depthFt: 65 },
      coverage: { coveredAreaSqft: 3950, semiCoveredSqft: 180, openAreaSqft: 420, boundaryLengthFt: 200, boundaryHeightFt: 7, boundaryThickness: 'IN_9', boundaryPlasterSides: 2 },
      calculations: { plotAreaSqft: 2250, frontageAreaSqft: 2275, rooms: 17, totalFloorAreaSqft: 2269, wetRooms: 6 },
      wizardCompletedSteps: [1, 2, 3, 4, 5],
    });
    expect(p.floors.map((f: { level: string; ceilingHeightFt: number; calculations: { rooms: number } }) => `${f.level}:${f.ceilingHeightFt}:${f.calculations.rooms}`)).toEqual([
      'GROUND:11:7',
      'FIRST:10:8',
      'MUMTY:9:2',
    ]);
    expect(p.billingStages).toHaveLength(8);
    expect(p.billingStages[0]).toMatchObject({ percent: 15, amountPaisa: '277500000' });

    const floors = (await api().get(`/api/v1/projects/${id}/floors`).set(auth)).body.data.floors;
    const drawing = floors[0].rooms.find((r: { name: string }) => r.name === 'Drawing Room');
    // 16 × 14 × 11: door 4×7 + 2 windows 5×4 = 68 sq ft of openings
    expect(drawing.calculations).toEqual({ floorAreaSqft: 224, grossWallAreaSqft: 660, openingsAreaSqft: 68, netWallAreaSqft: 592 });

    const review = (await api().get(`/api/v1/projects/${id}/review`).set(auth)).body.data;
    expect(review.errors).toEqual([]);
  });
});
