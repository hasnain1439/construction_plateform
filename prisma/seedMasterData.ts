/** Demo master data for Malik & Sons (rates, suppliers, workers …). Idempotent. */
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { COMMERCIAL, LABOR_ONLY_MONTHLY } from '../src/modules/master-data/catalog.js';

const DAY = 86_400_000;
const rs = (rupees: number) => BigInt(Math.round(rupees * 100));

/** [material name, [A+, A, B] rupees, [A+, A, B] specifications] */
const MALIK_RATES: Array<[string, [number, number, number], [string, string, string]]> = [
  ['Cement OPC', [1550, 1450, 1350], ['DG Khan / Bestway', 'Lucky / Maple Leaf', 'Pioneer / Fecto']],
  ['Clay bricks Class-1', [19, 17, 14], ['Awwal machine-made', 'Awwal kiln', 'Doom (2nd grade)']],
  ['Steel Grade-60 #4', [295000, 285000, 270000], ['Amreli / Mughal', 'Ittefaq', 'Local re-rolled']],
  ['Chenab sand', [85, 70, 60], ['Washed, screened', 'Unwashed', 'Mixed']],
  ['Bajri Margalla crush', [190, 180, 165], ['Margalla ½" clean', 'Margalla ¾"', 'Mixed size']],
  ['Floor tiles', [450, 220, 140], ['Porcelain 24×48', 'Master / Shabbir 24×24', 'Local ceramic 12×12']],
  ['PPR pipe 1"', [420, 320, 250], ['Dadex / German', 'Popular PN-16', 'Local PN-10']],
  ['Wire 7/29', [14500, 11800, 9500], ['Pakistan Cables', 'Fast Cables', 'Local copper']],
];

export async function seedMalikMasterData(db: PrismaClient, tenantId: string, ownerId: string) {
  // Payment templates (Residential standard comes from provisioning)
  for (const t of [LABOR_ONLY_MONTHLY, COMMERCIAL]) {
    const data = { billingModel: t.billingModel, stages: t.stages as unknown as Prisma.InputJsonValue, isDefault: false };
    await db.paymentScheduleTemplate.upsert({ where: { tenantId_name: { tenantId, name: t.name } }, create: { tenantId, name: t.name, ...data }, update: {} });
  }

  if ((await db.materialRate.count({ where: { tenantId } })) === 0) await seedPriceList(db, tenantId, ownerId);
  await seedSuppliers(db, tenantId, ownerId);
  await seedWorkforce(db, tenantId, ownerId);
}

async function seedPriceList(db: PrismaClient, tenantId: string, ownerId: string) {
  const categories = await db.qualityCategory.findMany({ where: { tenantId }, orderBy: { sortOrder: 'asc' } });
  const byCode = Object.fromEntries(categories.map((c) => [c.code, c.id]));
  const tiers = ['A_PLUS', 'A_STD', 'B_ECO'] as const;
  const materials = await db.material.findMany({ where: { tenantId, name: { in: MALIK_RATES.map(([n]) => n) } } });
  const materialId = (name: string) => {
    const m = materials.find((x) => x.name === name);
    if (!m) throw new Error(`seed: material "${name}" missing`);
    return m.id;
  };

  const current = new Date(Date.now() - DAY);
  const rows = MALIK_RATES.flatMap(([name, rupees, specs]) =>
    tiers.map((tier, i) => ({
      tenantId,
      materialId: materialId(name),
      categoryId: byCode[tier]!,
      ratePaisa: rs(rupees[i]!),
      specification: specs[i]!,
      effectiveFrom: current,
      createdById: ownerId,
    })),
  );
  // Older A-standard cement rate, for the history screen
  rows.push({
    tenantId,
    materialId: materialId('Cement OPC'),
    categoryId: byCode['A_STD']!,
    ratePaisa: rs(1400),
    specification: 'Lucky / Maple Leaf',
    effectiveFrom: new Date(Date.now() - 60 * DAY),
    createdById: ownerId,
  });
  await db.materialRate.createMany({ data: rows });
}

const MALIK_SUPPLIERS = [
  { name: 'Al-Madina Cement Agency', category: 'Cement', phone: '+924235761234', city: 'Lahore', address: 'Badami Bagh, Lahore', ntn: '4123456-7' },
  { name: 'Ittefaq Steel Traders', category: 'Steel', phone: '+923004561234', city: 'Lahore', address: 'Brandreth Road, Lahore' },
  { name: 'Chaudhry Bricks Kiln', category: 'Bricks', phone: '+923216549870', city: 'Kasur', address: 'Raiwind Road' },
  { name: 'Bilal Traders', category: 'Sand & Bajri', phone: '+923334445566', city: 'Lahore', notes: 'Chenab sand + Margalla bajri by trolley' },
  { name: 'Punjab Shuttering Yard', category: 'Shuttering', phone: '+924235123456', city: 'Lahore', notes: 'Steel plates and props on rent' },
];

async function seedSuppliers(db: PrismaClient, tenantId: string, ownerId: string) {
  for (const s of MALIK_SUPPLIERS) {
    await db.supplier.upsert({ where: { tenantId_name: { tenantId, name: s.name } }, create: { tenantId, ...s }, update: {} });
  }
  if ((await db.supplierRate.count({ where: { tenantId } })) > 0) return;
  const almadina = await db.supplier.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'Al-Madina Cement Agency' } } });
  const cement = await db.material.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'Cement OPC' } } });
  await db.supplierRate.create({
    data: { tenantId, supplierId: almadina.id, materialId: cement.id, ratePaisa: rs(1430), effectiveFrom: new Date(Date.now() - DAY), createdById: ownerId },
  });
}

type DailyType = 'MISTRI' | 'MISTRI_TILES' | 'MAZDOOR' | 'STEEL_FIXER_HELPER' | 'CHOWKIDAR';

/** [name, type, phone, active]. Daily rate = the company labour rate for the type (Ustad Akram is paid more). */
const MALIK_WORKERS: Array<[string, DailyType, string | null, boolean]> = [
  ['Ustad Akram', 'MISTRI', '+923001110001', true],
  ['Ustad Nadeem', 'MISTRI', '+923001110002', true],
  ['Shahid', 'MAZDOOR', '+923001110003', true],
  ['Jameel', 'MAZDOOR', null, true],
  ['Riaz', 'MAZDOOR', '+923001110005', true],
  ['Arif', 'STEEL_FIXER_HELPER', '+923001110006', true],
  ['Saleem', 'MAZDOOR', null, true],
  ['Ghulam Rasool', 'CHOWKIDAR', '+923001110008', true],
  ['Ustad Boota', 'MISTRI_TILES', '+923001110009', true],
  ['Zafar', 'MAZDOOR', '+923001110010', true],
  ['Waseem', 'STEEL_FIXER_HELPER', null, true],
  ['Ustad Rasheed', 'MISTRI', '+923001110012', true],
  ['Naveed', 'MAZDOOR', '+923001110013', true],
  ['Pervaiz', 'MAZDOOR', '+923001110014', false],
];

const MALIK_SUBCONTRACTORS = [
  { name: 'Ustad Sharif Shuttering', trade: 'SHUTTERING', phone: '+923004440001' },
  { name: 'Ustad Latif Steel Fixing', trade: 'STEEL_FIXING', phone: '+923004440002' },
  { name: 'Haji Plumbing Works', trade: 'PLUMBING_ROUGH_IN', phone: '+923004440003' },
  { name: 'Ali Electric Works', trade: 'ELECTRICAL_CONDUIT', phone: '+923004440004' },
  { name: 'Rehman Tile Team', trade: 'TILE_LAYING', phone: '+923004440005' },
  { name: 'Bashir Waterproofing', trade: 'WATERPROOFING', phone: '+923004440006' },
];

async function seedWorkforce(db: PrismaClient, tenantId: string, ownerId: string) {
  if ((await db.worker.count({ where: { tenantId } })) === 0) {
    const rates = Object.fromEntries((await db.laborRate.findMany({ where: { tenantId, kind: 'DAILY' } })).map((r) => [r.key, r.ratePaisa]));
    await db.worker.createMany({
      data: MALIK_WORKERS.map(([name, type, phone, isActive]) => ({
        tenantId,
        name,
        type,
        phone,
        isActive,
        dailyRatePaisa: name === 'Ustad Akram' ? rs(3000) : rates[type]!,
        createdById: ownerId,
      })),
    });
  }
  for (const s of MALIK_SUBCONTRACTORS) {
    await db.subcontractor.upsert({ where: { tenantId_name: { tenantId, name: s.name } }, create: { tenantId, ...s }, update: {} });
  }
}
