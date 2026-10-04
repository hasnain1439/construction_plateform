/**
 * Response shapes. Financial fields (contractValuePaisa, ratePerSqftPaisa, stage
 * amounts) are **omitted** — not null — unless the caller has billing.view. MUNSHI gets
 * the basic fields only.
 */
import { formatDateOnly } from '../../core/utils/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Caller } from './access.js';
import { plotCalc, roomCalc, totalsCalc, laborOnlyTotal, type RoomInput } from './calc.js';
import { SUPPLY_CATEGORIES } from './presets.js';
import type { FloorWithRooms, ProjectFull, ProjectListRow, RoomWithOpenings } from './projects.repository.js';

type Dec = Prisma.Decimal | null;
export const num = (d: Dec) => (d === null ? null : Number(d));
const day = (d: Date | null) => (d ? formatDateOnly(d) : null);
const money = (c: Caller, key: string, v: bigint | null) => (c.seesFinancials ? { [key]: v === null ? null : v.toString() } : {});

type Access = ProjectListRow['userAccess'];
function team(access: Access) {
  const active = access.filter((a) => a.user.status === 'ACTIVE');
  const pm = active.find((a) => a.user.role === 'PM')?.user;
  return {
    pm: pm ? { id: pm.id, name: pm.name } : null,
    munshis: active.filter((a) => a.user.role === 'MUNSHI').map((a) => ({ id: a.user.id, name: a.user.name })),
  };
}

export function toListDto(p: ProjectListRow, c: Caller) {
  const t = team(p.userAccess);
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    client: p.client,
    siteAddress: p.siteAddress,
    city: p.city,
    status: p.status,
    contractType: p.contractType,
    startDate: day(p.startDate),
    endDate: day(p.endDate),
    pm: t.pm,
    munshi: t.munshis[0] ?? null,
    coveredAreaSqft: num(p.coveredAreaSqft),
    ...money(c, 'contractValuePaisa', p.contractValuePaisa),
  };
}

const roomInput = (r: RoomWithOpenings): RoomInput => ({
  lengthFt: r.lengthFt,
  widthFt: r.widthFt,
  heightFt: r.heightFt,
  isWet: r.isWet,
  openings: r.openings,
});

export function toRoomDto(r: RoomWithOpenings) {
  return {
    id: r.id,
    floorId: r.floorId,
    type: r.type,
    name: r.name,
    lengthFt: Number(r.lengthFt),
    widthFt: Number(r.widthFt),
    heightFt: Number(r.heightFt),
    isWet: r.isWet,
    isWetOverridden: r.isWetOverridden,
    sortOrder: r.sortOrder,
    openings: r.openings.map((o) => ({ id: o.id, type: o.type, widthFt: Number(o.widthFt), heightFt: Number(o.heightFt), quantity: o.quantity })),
    calculations: roomCalc(roomInput(r)),
  };
}

export function floorTotals(f: FloorWithRooms) {
  return totalsCalc(f.rooms.map(roomInput));
}

export function toFloorDto(f: FloorWithRooms, withRooms: boolean) {
  return {
    id: f.id,
    level: f.level,
    name: f.name,
    ceilingHeightFt: Number(f.ceilingHeightFt),
    sortOrder: f.sortOrder,
    ...(withRooms ? { rooms: f.rooms.map(toRoomDto) } : {}),
    calculations: floorTotals(f),
  };
}

export function projectCalculations(p: ProjectFull) {
  return {
    ...plotCalc({ plotUnit: p.plotUnit, plotSize: p.plotSize, marlaStandard: p.marlaStandard, frontFt: p.frontFt, depthFt: p.depthFt }),
    ...totalsCalc(p.floors.flatMap((f) => f.rooms.map(roomInput))),
  };
}

/** Contract total the billing stages split: contract value, or rate × covered area for labour-only. */
export function contractTotalPaisa(p: Pick<ProjectFull, 'contractType' | 'contractValuePaisa' | 'ratePerSqftPaisa' | 'coveredAreaSqft'>): bigint | null {
  if (p.contractType === 'LABOR_ONLY') return p.ratePerSqftPaisa !== null && p.coveredAreaSqft !== null ? laborOnlyTotal(p.ratePerSqftPaisa, p.coveredAreaSqft) : null;
  return p.contractValuePaisa;
}

export function toDetailDto(p: ProjectFull, c: Caller) {
  const basic = {
    id: p.id,
    code: p.code,
    name: p.name,
    status: p.status,
    client: p.client ? (c.role === 'MUNSHI' ? { id: p.client.id, name: p.client.name } : p.client) : null,
    siteAddress: p.siteAddress,
    city: p.city,
    startDate: day(p.startDate),
    endDate: day(p.endDate),
    team: team(p.userAccess),
  };
  if (c.role === 'MUNSHI') return basic;

  return {
    ...basic,
    contract: {
      contractType: p.contractType,
      billingModel: p.billingModel,
      ...money(c, 'contractValuePaisa', p.contractValuePaisa),
      ...money(c, 'ratePerSqftPaisa', p.ratePerSqftPaisa),
      ...money(c, 'contractTotalPaisa', contractTotalPaisa(p)),
      retentionPercent: Number(p.retentionPercent),
      defectPeriodMonths: p.defectPeriodMonths,
    },
    plot: { plotUnit: p.plotUnit, plotSize: num(p.plotSize), marlaStandard: Number(p.marlaStandard), frontFt: num(p.frontFt), depthFt: num(p.depthFt), cornerPlot: p.cornerPlot },
    structure: { structureType: p.structureType, hasBasement: p.hasBasement, basementHeightFt: num(p.basementHeightFt) },
    coverage: {
      coveredAreaSqft: num(p.coveredAreaSqft),
      semiCoveredSqft: Number(p.semiCoveredSqft),
      openAreaSqft: Number(p.openAreaSqft),
      boundaryWall: p.boundaryWall,
      boundaryLengthFt: num(p.boundaryLengthFt),
      boundaryHeightFt: num(p.boundaryHeightFt),
      boundaryThickness: p.boundaryThickness,
      boundaryPlasterSides: p.boundaryPlasterSides,
    },
    supplyRules: SUPPLY_CATEGORIES.flatMap((cat) => {
      const r = p.supplyRules.find((x) => x.categoryKey === cat.key);
      return r ? [{ categoryKey: r.categoryKey, label: cat.label, suppliedBy: r.suppliedBy, qualityCategory: r.qualityCategory, locked: r.lockedAt !== null }] : [];
    }),
    billingStages: p.billingStages.map((s) => ({
      id: s.id,
      sortOrder: s.sortOrder,
      label: s.label,
      percent: Number(s.percent),
      isRetention: s.isRetention,
      ...money(c, 'amountPaisa', s.amountPaisa),
      status: s.status,
    })),
    floors: p.floors.map((f) => toFloorDto(f, false)),
    calculations: projectCalculations(p),
    wizardCompletedSteps: [...p.wizardCompletedSteps].sort((a, b) => a - b),
    createdFromQuoteId: p.createdFromQuoteId,
    activatedAt: p.activatedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
