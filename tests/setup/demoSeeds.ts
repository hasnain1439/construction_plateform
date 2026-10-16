/**
 * Demo data that several test files load on top of the base test seed. Each one is snapshotted
 * (tests/setup/seedSnapshot.ts) — built once by globalSetup, then restored in ~50 ms — through
 * `withSeedSnapshot(name, seeded)` in tests/helpers.ts. Add an entry here to make one snapshotted;
 * `extends` starts from another demo snapshot instead of the base seed.
 */
import { seedMalikBilling } from '../../prisma/seedBilling.js';
import { seedMalikEquipment } from '../../prisma/seedEquipment.js';
import { seedMalikInventory } from '../../prisma/seedInventory.js';
import { seedMalikLabor } from '../../prisma/seedLabor.js';
import type { seed } from '../../prisma/seed.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';

type Seeded = Awaited<ReturnType<typeof seed>>;

interface DemoSeedDef {
  extends?: string;
  build: (s: Seeded) => Promise<void>;
}

export const DEMO_SEEDS = {
  /** Malik & Sons stock + labour & cash (no billing). */
  malik_stock_labor: {
    build: async (s: Seeded) => {
      const base = { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, projects: s.projects };
      await seedMalikInventory(prismaAdmin, base);
      await seedMalikLabor(prismaAdmin, { ...base, asifId: s.users.asif.id });
    },
  },
  /** The whole Malik & Sons demo: stock, labour & cash, billing. */
  malik_demo: {
    extends: 'malik_stock_labor',
    build: async (s: Seeded) => {
      await seedMalikBilling(prismaAdmin, { tenantId: s.malik.id, ownerId: s.users.khalid.id, projects: s.projects });
    },
  },
  /** Step 16: Malik & Sons equipment & shuttering on the base seed (no stock / labour). */
  malik_equipment: {
    build: async (s: Seeded) => {
      await seedMalikEquipment(prismaAdmin, { tenantId: s.malik.id, ownerId: s.users.khalid.id, bilalId: s.users.bilal.id, rafaqatId: s.users.rafaqatMalik.id, projects: s.projects });
    },
  },
} satisfies Record<string, DemoSeedDef>;

export type DemoSeed = keyof typeof DEMO_SEEDS;

/** The demo seed a snapshot starts from (undefined = the base seed). */
export const parentOf = (name: DemoSeed): DemoSeed | undefined => (DEMO_SEEDS[name] as DemoSeedDef).extends as DemoSeed | undefined;
