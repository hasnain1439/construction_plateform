/** Static project vocabulary: supply categories + presets, floor levels, room types. */
import type { ContractType, FloorLevel, RoomType, SuppliedBy } from '../../generated/prisma/enums.js';

export const SUPPLY_CATEGORIES = [
  { key: 'CEMENT', label: 'Cement' },
  { key: 'BRICKS', label: 'Bricks / blocks' },
  { key: 'STEEL', label: 'Steel' },
  { key: 'SAND_BAJRI', label: 'Sand & bajri' },
  { key: 'PIPES', label: 'Plumbing pipes & fittings' },
  { key: 'WATERPROOFING', label: 'Waterproofing' },
  { key: 'ELECTRICAL', label: 'Electrical wiring & fittings' },
  { key: 'TILES_FLOORING', label: 'Tiles, marble & flooring' },
  { key: 'SANITARY', label: 'Sanitary ware' },
  { key: 'WOODWORK', label: 'Doors, windows & woodwork' },
  { key: 'PAINT', label: 'Paint & polish' },
] as const;

export type SupplyCategoryKey = (typeof SUPPLY_CATEGORIES)[number]['key'];
export const SUPPLY_CATEGORY_KEYS = SUPPLY_CATEGORIES.map((c) => c.key) as [SupplyCategoryKey, ...SupplyCategoryKey[]];

const GREY_BY_CONTRACTOR: SupplyCategoryKey[] = ['CEMENT', 'BRICKS', 'STEEL', 'SAND_BAJRI', 'PIPES'];

/** Who supplies each category by default for a contract type. */
export function presetFor(contractType: ContractType): Array<{ categoryKey: SupplyCategoryKey; suppliedBy: SuppliedBy }> {
  return SUPPLY_CATEGORY_KEYS.map((categoryKey) => ({
    categoryKey,
    suppliedBy:
      contractType === 'FULL'
        ? 'CONTRACTOR'
        : contractType === 'LABOR_ONLY'
          ? 'OWNER'
          : GREY_BY_CONTRACTOR.includes(categoryKey)
            ? 'CONTRACTOR'
            : 'OWNER',
  }));
}

export const SUPPLY_PRESETS = (['FULL', 'GREY_OWNER_FINISHING', 'LABOR_ONLY'] as const).map((contractType) => ({
  contractType,
  label: { FULL: 'Full contract (material + labour)', GREY_OWNER_FINISHING: 'Grey structure by contractor, finishing by owner', LABOR_ONLY: 'Labour only' }[
    contractType
  ],
  rules: presetFor(contractType).map((r) => ({ ...r, label: SUPPLY_CATEGORIES.find((c) => c.key === r.categoryKey)!.label })),
}));

export const FLOOR_LEVELS: FloorLevel[] = ['BASEMENT', 'GROUND', 'FIRST', 'SECOND', 'THIRD', 'MUMTY'];
export const FLOOR_NAMES: Record<FloorLevel, string> = {
  BASEMENT: 'Basement',
  GROUND: 'Ground floor',
  FIRST: 'First floor',
  SECOND: 'Second floor',
  THIRD: 'Third floor',
  MUMTY: 'Mumty',
};

export const ROOM_TYPE_NAMES: Record<RoomType, string> = {
  MASTER_BEDROOM: 'Master Bedroom',
  BEDROOM: 'Bedroom',
  ATTACHED_BATH: 'Attached Bath',
  POWDER_ROOM: 'Powder Room',
  KITCHEN: 'Kitchen',
  TV_LOUNGE: 'TV Lounge',
  DRAWING_ROOM: 'Drawing Room',
  DINING: 'Dining',
  STORE: 'Store',
  TERRACE: 'Terrace',
  STAIR: 'Stair',
  GARAGE: 'Garage',
  OTHER: 'Room',
};

/** Rooms that are wet (waterproofing, tiles to ceiling) unless overridden. */
export const WET_ROOM_TYPES: RoomType[] = ['ATTACHED_BATH', 'POWDER_ROOM', 'KITCHEN'];
export const isWetType = (type: RoomType) => WET_ROOM_TYPES.includes(type);
