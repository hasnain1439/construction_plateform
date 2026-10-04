/** Demo clients and projects. Idempotent. */
import type { FloorLevel, Prisma, PrismaClient, ProjectStatus, RoomType } from '../src/generated/prisma/client.js';
import { LABOR_ONLY_MONTHLY, RESIDENTIAL_STANDARD, type StageDef } from '../src/modules/master-data/catalog.js';
import { contractTotalPaisa } from '../src/modules/projects/projects.dto.js';
import { stageAmounts } from '../src/modules/projects/calc.js';
import { FLOOR_LEVELS, FLOOR_NAMES, isWetType, presetFor } from '../src/modules/projects/presets.js';

export const MALIK_CLIENTS = [
  { name: 'Ahmed Raza', phone: '+923331234567' },
  { name: 'Usman Tariq Sheikh', phone: '+923227654321' },
  { name: 'Dr. Sana Iqbal', phone: '+923005556677' },
  { name: 'Hamid Ali', phone: '+923214445566' },
  { name: 'Imran Qureshi', phone: '+923452223344' },
  { name: 'Farah Naz', phone: '+923318889900' },
] as const;

export async function seedMalikClients(db: PrismaClient, tenantId: string, ownerId: string) {
  const out: Record<string, { id: string }> = {};
  for (const c of MALIK_CLIENTS) {
    out[c.name] = await db.client.upsert({
      where: { tenantId_phone: { tenantId, phone: c.phone } },
      create: { tenantId, ...c, createdById: ownerId },
      update: {},
    });
  }
  return out;
}

/**
 * Finds a project by code, else renames an older seed row (`legacyName`) so foreign keys
 * (access, invitations) keep pointing at it, else creates it.
 */
export async function ensureProjectRow(db: PrismaClient, tenantId: string, code: string, name: string, legacyName?: string) {
  const byCode = await db.project.findUnique({ where: { tenantId_code: { tenantId, code } } });
  if (byCode) return byCode;
  const legacy = legacyName ? await db.project.findFirst({ where: { tenantId, name: legacyName } }) : null;
  if (legacy) return db.project.update({ where: { id: legacy.id }, data: { code, name } });
  return db.project.create({ data: { tenantId, code, name, status: 'ACTIVE' } });
}

type Opening = [type: 'DOOR' | 'WINDOW' | 'VENTILATOR', w: number, h: number, qty?: number];
type RoomDef = [type: RoomType, name: string, l: number, w: number, openings?: Opening[]];

export interface ProjectDef {
  status: ProjectStatus;
  clientId: string;
  siteAddress: string;
  city: string;
  startDate: string;
  endDate: string;
  contractType: 'FULL' | 'GREY_OWNER_FINISHING' | 'LABOR_ONLY';
  billingModel: 'STAGE_SCHEDULE' | 'RUNNING_BILLS';
  contractValuePaisa?: bigint;
  ratePerSqftPaisa?: bigint;
  stages: StageDef[];
  /** Wizard tabs done (default 1–5) */
  steps?: number[];
  plot?: { unit: 'MARLA' | 'KANAL'; size: number; front: number; depth: number; basementHeight?: number };
  floors?: Array<[FloorLevel, number]>;
  coverage?: { covered: number; semi?: number; open?: number; boundary?: { length: number; height: number; thickness: 'IN_4_5' | 'IN_9'; sides: 1 | 2 } };
  rooms?: Partial<Record<FloorLevel, RoomDef[]>>;
  team: string[];
  /** Seed users whose access to this project is set exactly to `team` (stale rows from older seeds removed). */
  managedUserIds?: string[];
  createdById: string;
}

/** Fills a project's wizard data. Child rows are only created when missing, so re-runs change nothing. */
export async function fillProject(db: PrismaClient, tenantId: string, projectId: string, d: ProjectDef) {
  const base: Prisma.ProjectUncheckedUpdateInput = {
    status: d.status,
    clientId: d.clientId,
    siteAddress: d.siteAddress,
    city: d.city,
    startDate: new Date(`${d.startDate}T00:00:00.000Z`),
    endDate: new Date(`${d.endDate}T00:00:00.000Z`),
    contractType: d.contractType,
    billingModel: d.billingModel,
    contractValuePaisa: d.contractValuePaisa ?? null,
    ratePerSqftPaisa: d.ratePerSqftPaisa ?? null,
    retentionPercent: 5,
    defectPeriodMonths: 6,
    marlaStandard: 225,
    wizardCompletedSteps: d.steps ?? [1, 2, 3, 4, 5],
    createdById: d.createdById,
    activatedAt: d.status === 'DRAFT' ? null : new Date(`${d.startDate}T09:00:00.000Z`),
    ...(d.plot
      ? {
          plotUnit: d.plot.unit,
          plotSize: d.plot.size,
          frontFt: d.plot.front,
          depthFt: d.plot.depth,
          structureType: 'FRAMED',
          hasBasement: d.plot.basementHeight !== undefined,
          basementHeightFt: d.plot.basementHeight ?? null,
        }
      : {}),
    ...(d.coverage
      ? {
          coveredAreaSqft: d.coverage.covered,
          semiCoveredSqft: d.coverage.semi ?? 0,
          openAreaSqft: d.coverage.open ?? 0,
          boundaryWall: Boolean(d.coverage.boundary),
          boundaryLengthFt: d.coverage.boundary?.length ?? null,
          boundaryHeightFt: d.coverage.boundary?.height ?? null,
          boundaryThickness: d.coverage.boundary?.thickness ?? null,
          boundaryPlasterSides: d.coverage.boundary?.sides ?? null,
        }
      : {}),
  };
  await db.project.update({ where: { id: projectId }, data: base });

  await db.userProjectAccess.createMany({ data: d.team.map((userId) => ({ tenantId, userId, projectId })), skipDuplicates: true });
  const stale = (d.managedUserIds ?? []).filter((id) => !d.team.includes(id));
  if (stale.length) await db.userProjectAccess.deleteMany({ where: { projectId, userId: { in: stale } } });

  if ((await db.projectSupplyRule.count({ where: { projectId } })) === 0) {
    const std = await db.qualityCategory.findFirst({ where: { tenantId, isDefault: true } });
    await db.projectSupplyRule.createMany({
      data: presetFor(d.contractType).map((r) => ({ tenantId, projectId, ...r, qualityCategoryId: r.suppliedBy === 'CONTRACTOR' ? (std?.id ?? null) : null })),
    });
  }

  if ((await db.projectBillingStage.count({ where: { projectId } })) === 0) {
    const total = contractTotalPaisa({
      contractType: d.contractType,
      contractValuePaisa: d.contractValuePaisa ?? null,
      ratePerSqftPaisa: d.ratePerSqftPaisa ?? null,
      coveredAreaSqft: d.coverage ? (d.coverage.covered as unknown as Prisma.Decimal) : null,
    });
    const amounts = total === null ? d.stages.map(() => 0n) : stageAmounts(total, d.stages.map((s) => s.percent));
    await db.projectBillingStage.createMany({
      data: d.stages.map((s, i) => ({
        tenantId,
        projectId,
        sortOrder: i + 1,
        label: s.label,
        percent: s.percent,
        isRetention: Boolean(s.isRetention),
        amountPaisa: amounts[i]!,
        status: d.status === 'HANDED_OVER' && !s.isRetention ? 'PAID' : i === 0 && d.status === 'ACTIVE' ? 'PAID' : 'UPCOMING',
      })),
    });
  }

  for (const [level, height] of d.floors ?? []) {
    const floor = await db.floor.upsert({
      where: { projectId_level: { projectId, level } },
      create: { tenantId, projectId, level, name: FLOOR_NAMES[level], ceilingHeightFt: height, sortOrder: FLOOR_LEVELS.indexOf(level) + 1 },
      update: {},
    });
    const rooms = d.rooms?.[level] ?? [];
    if (!rooms.length || (await db.room.count({ where: { floorId: floor.id } })) > 0) continue;
    for (const [i, [type, name, l, w, openings = []]] of rooms.entries()) {
      const room = await db.room.create({
        data: { tenantId, projectId, floorId: floor.id, type, name, lengthFt: l, widthFt: w, heightFt: height, isWet: isWetType(type), sortOrder: i + 1 },
      });
      if (openings.length) {
        await db.opening.createMany({ data: openings.map(([t, ow, oh, qty = 1]) => ({ tenantId, roomId: room.id, type: t, widthFt: ow, heightFt: oh, quantity: qty })) });
      }
    }
  }
}

const D = (w: number): Opening => ['DOOR', w, 7];
const W = (w: number, h: number, qty = 1): Opening => ['WINDOW', w, h, qty];

export const DHA_ROOMS: ProjectDef['rooms'] = {
  GROUND: [
    ['DRAWING_ROOM', 'Drawing Room', 16, 14, [D(4), W(5, 4, 2)]],
    ['TV_LOUNGE', 'TV Lounge', 18, 16, [D(4), W(5, 4, 2)]],
    ['KITCHEN', 'Kitchen', 12, 10, [D(3), W(4, 3)]],
    ['MASTER_BEDROOM', 'Master Bedroom', 16, 14, [D(3.5), W(5, 4)]],
    ['ATTACHED_BATH', 'Attached Bath', 8, 6, [D(2.5), ['VENTILATOR', 2, 1.5]]],
    ['POWDER_ROOM', 'Powder Room', 5, 5, [D(2.5)]],
    ['STAIR', 'Stair', 12, 8],
  ],
  FIRST: [
    ['MASTER_BEDROOM', 'Master Bedroom', 16, 14],
    ['ATTACHED_BATH', 'Attached Bath', 8, 6],
    ['BEDROOM', 'Bedroom 2', 14, 12],
    ['ATTACHED_BATH', 'Bath 2', 8, 6],
    ['BEDROOM', 'Bedroom 3', 14, 12],
    ['ATTACHED_BATH', 'Bath 3', 8, 6],
    ['TV_LOUNGE', 'Family Lounge', 16, 14],
    ['TERRACE', 'Terrace', 14, 10],
  ],
  MUMTY: [
    ['STORE', 'Store Room', 10, 8],
    ['STAIR', 'Stair', 12, 8],
  ],
};

export const STAGES = { residential: RESIDENTIAL_STANDARD.stages, laborOnly: LABOR_ONLY_MONTHLY.stages };

export async function seedMalikProjects(
  db: PrismaClient,
  t: { tenantId: string; ownerId: string; bilalId: string; rafaqatId: string; asifId: string; clients: Record<string, { id: string }> },
) {
  const { tenantId } = t;
  const cl = (name: string) => t.clients[name]!.id;
  const rs = (rupees: number) => BigInt(rupees) * 100n;
  const managedUserIds = [t.bilalId, t.rafaqatId, t.asifId];

  const dha = await ensureProjectRow(db, tenantId, 'MSB-2026-012', 'DHA Phase 6 · 10 Marla', 'DHA Phase 6 — 1 Kanal Villa');
  await fillProject(db, tenantId, dha.id, {
    status: 'ACTIVE',
    clientId: cl('Ahmed Raza'),
    siteAddress: 'House 214, Sector C, DHA Phase 6',
    city: 'Lahore',
    startDate: '2026-03-15',
    endDate: '2027-02-15',
    contractType: 'GREY_OWNER_FINISHING',
    billingModel: 'STAGE_SCHEDULE',
    contractValuePaisa: rs(1_85_00_000),
    stages: STAGES.residential,
    plot: { unit: 'MARLA', size: 10, front: 35, depth: 65 },
    floors: [
      ['GROUND', 11],
      ['FIRST', 10],
      ['MUMTY', 9],
    ],
    coverage: { covered: 3950, semi: 180, open: 420, boundary: { length: 200, height: 7, thickness: 'IN_9', sides: 2 } },
    rooms: DHA_ROOMS,
    team: [t.bilalId, t.rafaqatId],
    managedUserIds,
    createdById: t.ownerId,
  });

  const johar = await ensureProjectRow(db, tenantId, 'MSB-2026-008', 'Johar Town · 5 Marla');
  await fillProject(db, tenantId, johar.id, {
    status: 'ACTIVE',
    clientId: cl('Usman Tariq Sheikh'),
    siteAddress: 'Plot 88, Block R-2, Johar Town',
    city: 'Lahore',
    startDate: '2026-01-10',
    endDate: '2026-12-20',
    contractType: 'FULL',
    billingModel: 'STAGE_SCHEDULE',
    contractValuePaisa: rs(1_10_00_000),
    stages: STAGES.residential,
    plot: { unit: 'MARLA', size: 5, front: 25, depth: 45 },
    floors: [
      ['GROUND', 11],
      ['FIRST', 10],
    ],
    coverage: { covered: 2100 },
    team: [t.bilalId],
    managedUserIds,
    createdById: t.ownerId,
  });

  const bahria = await ensureProjectRow(db, tenantId, 'MSB-2026-014', 'Bahria Town · 1 Kanal', 'Bahria Town — Commercial Plaza');
  await fillProject(db, tenantId, bahria.id, {
    status: 'ACTIVE',
    clientId: cl('Dr. Sana Iqbal'),
    siteAddress: 'House 51, Overseas A, Bahria Town',
    city: 'Lahore',
    startDate: '2026-05-01',
    endDate: '2027-10-31',
    contractType: 'FULL',
    billingModel: 'STAGE_SCHEDULE',
    contractValuePaisa: rs(3_40_00_000),
    stages: STAGES.residential,
    plot: { unit: 'KANAL', size: 1, front: 50, depth: 90, basementHeight: 10 },
    floors: [
      ['BASEMENT', 10],
      ['GROUND', 11],
      ['FIRST', 10],
    ],
    coverage: { covered: 7800, boundary: { length: 280, height: 8, thickness: 'IN_9', sides: 2 } },
    team: [t.asifId],
    managedUserIds,
    createdById: t.ownerId,
  });

  const valencia = await ensureProjectRow(db, tenantId, 'MSB-2025-031', 'Valencia · 7 Marla');
  await fillProject(db, tenantId, valencia.id, {
    status: 'HANDED_OVER',
    clientId: cl('Hamid Ali'),
    siteAddress: 'House 7, Block E, Valencia Town',
    city: 'Lahore',
    startDate: '2025-02-01',
    endDate: '2025-11-30',
    contractType: 'LABOR_ONLY',
    billingModel: 'RUNNING_BILLS',
    ratePerSqftPaisa: rs(450),
    stages: STAGES.laborOnly,
    plot: { unit: 'MARLA', size: 7, front: 30, depth: 52.5 },
    floors: [
      ['GROUND', 11],
      ['FIRST', 10],
    ],
    coverage: { covered: 2800 },
    team: [t.bilalId],
    managedUserIds,
    createdById: t.ownerId,
  });

  const modelTown = await ensureProjectRow(db, tenantId, 'MSB-2026-016', 'Model Town · 1 Kanal');
  await fillProject(db, tenantId, modelTown.id, {
    status: 'DRAFT',
    clientId: cl('Imran Qureshi'),
    siteAddress: 'House 23-C, Model Town',
    city: 'Lahore',
    startDate: '2026-12-01',
    endDate: '2027-12-31',
    contractType: 'FULL',
    billingModel: 'STAGE_SCHEDULE',
    contractValuePaisa: rs(4_20_00_000),
    stages: STAGES.residential,
    steps: [1, 2],
    team: [],
    managedUserIds,
    createdById: t.ownerId,
  });

  return { dha, johar, bahria, valencia, modelTown };
}

export async function seedAhmedProject(db: PrismaClient, tenantId: string, ownerId: string, munshiId: string) {
  const client = await db.client.upsert({
    where: { tenantId_phone: { tenantId, phone: '+923004440099' } },
    create: { tenantId, name: 'Tariq Mehmood', phone: '+923004440099', createdById: ownerId },
    update: {},
  });
  const project = await ensureProjectRow(db, tenantId, 'AC-2026-001', 'Wapda Town · 5 Marla', 'Gulberg — 10 Marla House');
  await fillProject(db, tenantId, project.id, {
    status: 'ACTIVE',
    clientId: client.id,
    siteAddress: 'House 310, Block K-2, Wapda Town',
    city: 'Lahore',
    startDate: '2026-06-01',
    endDate: '2027-03-31',
    contractType: 'FULL',
    billingModel: 'STAGE_SCHEDULE',
    contractValuePaisa: 950_000_000n,
    stages: STAGES.residential,
    plot: { unit: 'MARLA', size: 5, front: 25, depth: 45 },
    floors: [
      ['GROUND', 11],
      ['FIRST', 10],
    ],
    coverage: { covered: 2000 },
    team: [munshiId],
    createdById: ownerId,
  });
  return project;
}
