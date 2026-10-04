import { describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db/prisma.js';
import { withTenant } from '../src/core/db/withTenant.js';
import { SEED, useFreshDatabase } from './helpers.js';

const seeded = useFreshDatabase();

describe('row-level security (app_user)', () => {
  it('with Malik context, an unfiltered User query returns only Malik users', async () => {
    const { malik } = seeded();
    const users = await withTenant(malik.id, (tx) => tx.user.findMany());
    expect(users).toHaveLength(4); // Khalid, Bilal, Rafaqat, Asif
    expect(users.every((u) => u.tenantId === malik.id)).toBe(true);
    expect(users.map((u) => u.phone)).not.toContain(SEED.ahmed.owner.phone);

    const tenants = await withTenant(malik.id, (tx) => tx.tenant.findMany());
    expect(tenants.map((t) => t.id)).toEqual([malik.id]);
  });

  it("cannot read another tenant's row by id", async () => {
    const { malik, ahmed } = seeded();
    const found = await withTenant(malik.id, (tx) => tx.tenant.findUnique({ where: { id: ahmed.id } }));
    expect(found).toBeNull();
  });

  it("writing a row with Ahmed's tenantId inside Malik context fails", async () => {
    const { malik, ahmed } = seeded();
    await expect(
      withTenant(malik.id, (tx) =>
        tx.user.create({ data: { tenantId: ahmed.id, name: 'Intruder', phone: '+923450009999', role: 'PM' } }),
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      withTenant(malik.id, (tx) => tx.project.create({ data: { tenantId: ahmed.id, name: 'Sneaky project', code: 'SNEAKY-1' } })),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot move a row into another tenant or update another tenant's rows", async () => {
    const { malik, ahmed, users } = seeded();
    await expect(
      withTenant(malik.id, (tx) => tx.user.update({ where: { id: users.bilal.id }, data: { tenantId: ahmed.id } })),
    ).rejects.toThrow();

    const result = await withTenant(malik.id, (tx) => tx.user.updateMany({ where: { tenantId: ahmed.id }, data: { name: 'Hacked' } }));
    expect(result.count).toBe(0);
  });

  it('without a tenant context, tenant tables return nothing (fail closed)', async () => {
    expect(await prisma.user.findMany()).toEqual([]);
    expect(await prisma.tenant.count()).toBe(0);
  });

  it('app_user has no access to platform-admin or OTP tables', async () => {
    await expect(prisma.platformAdmin.findMany()).rejects.toThrow(/permission denied/i);
    await expect(prisma.otpCode.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('tenant context does not leak between transactions on pooled connections', async () => {
    const { malik } = seeded();
    await withTenant(malik.id, (tx) => tx.user.count());
    const counts = await Promise.all(Array.from({ length: 5 }, () => prisma.user.count()));
    expect(counts).toEqual([0, 0, 0, 0, 0]);
  });
});
