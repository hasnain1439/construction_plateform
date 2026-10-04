import type { Tx } from '../../core/db/withTenant.js';
import type { Prisma } from '../../generated/prisma/client.js';

const userRef = { select: { id: true, name: true, role: true, status: true } } as const;

export const roomInclude = { openings: { orderBy: [{ type: 'asc' }, { createdAt: 'asc' }] } } satisfies Prisma.RoomInclude;
export const floorInclude = { rooms: { include: roomInclude, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } satisfies Prisma.FloorInclude;

export const projectFullInclude = {
  client: { select: { id: true, name: true, phone: true } },
  userAccess: { include: { user: userRef }, orderBy: { createdAt: 'asc' } },
  supplyRules: { include: { qualityCategory: { select: { id: true, name: true, code: true } } } },
  billingStages: { orderBy: { sortOrder: 'asc' } },
  floors: { include: floorInclude, orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ProjectInclude;

export type ProjectFull = Prisma.ProjectGetPayload<{ include: typeof projectFullInclude }>;
export type FloorWithRooms = Prisma.FloorGetPayload<{ include: typeof floorInclude }>;
export type RoomWithOpenings = Prisma.RoomGetPayload<{ include: typeof roomInclude }>;

export const projectListInclude = {
  client: { select: { id: true, name: true } },
  userAccess: { include: { user: userRef }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ProjectInclude;

export type ProjectListRow = Prisma.ProjectGetPayload<{ include: typeof projectListInclude }>;

export function loadFull(tx: Tx, id: string) {
  return tx.project.findUniqueOrThrow({ where: { id }, include: projectFullInclude });
}

export function loadFloors(tx: Tx, projectId: string) {
  return tx.floor.findMany({ where: { projectId }, include: floorInclude, orderBy: { sortOrder: 'asc' } });
}

/** Active users of the company with the given role, among `ids`. */
export function activeUsersWithRole(tx: Tx, ids: string[], role: 'PM' | 'MUNSHI') {
  if (!ids.length) return Promise.resolve([]);
  return tx.user.findMany({ where: { id: { in: ids }, role, status: 'ACTIVE' }, select: { id: true } });
}
