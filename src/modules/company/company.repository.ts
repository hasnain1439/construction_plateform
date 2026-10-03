import type { HolidayType, Prisma, Region } from '../../generated/prisma/client.js';

type Db = Prisma.TransactionClient;

export function findCompany(tx: Db, tenantId: string) {
  return tx.tenant.findUnique({
    where: { id: tenantId },
    include: { settings: true, logo: { select: { storageKey: true } } },
  });
}

export type CompanyRow = NonNullable<Awaited<ReturnType<typeof findCompany>>>;

export function updateTenant(tx: Db, tenantId: string, data: Prisma.TenantUncheckedUpdateInput) {
  return tx.tenant.update({ where: { id: tenantId }, data });
}

export function findSettings(tx: Db, tenantId: string) {
  return tx.tenantSettings.findUnique({ where: { tenantId } });
}

/** Settings row is created at signup; upsert keeps older tenants working. */
export function upsertSettings(tx: Db, tenantId: string, data: Prisma.TenantSettingsUncheckedUpdateInput) {
  return tx.tenantSettings.upsert({
    where: { tenantId },
    create: { ...(data as Omit<Prisma.TenantSettingsUncheckedCreateInput, 'tenantId'>), tenantId },
    update: data,
  });
}

export function findAttachment(tx: Db, id: string) {
  return tx.attachment.findUnique({ where: { id }, select: { id: true, kind: true } });
}

/** Nationwide platform holidays plus those for the company's region, overlapping [from, to]. */
export function listPlatformHolidays(tx: Db, region: Region, from: Date, to: Date) {
  return tx.platformHoliday.findMany({
    where: {
      startDate: { lte: to },
      AND: [
        { OR: [{ region: null }, { region }] },
        { OR: [{ endDate: null, startDate: { gte: from } }, { endDate: { gte: from } }] },
      ],
    },
    orderBy: { startDate: 'asc' },
  });
}

/** Company holidays overlapping [from, to]. */
export function listCompanyHolidays(tx: Db, from: Date, to: Date) {
  return tx.companyHoliday.findMany({
    where: {
      startDate: { lte: to },
      OR: [{ endDate: null, startDate: { gte: from } }, { endDate: { gte: from } }],
    },
    orderBy: { startDate: 'asc' },
  });
}

export function createHoliday(
  tx: Db,
  data: { tenantId: string; name: string; startDate: Date; endDate: Date | null; type: HolidayType },
) {
  return tx.companyHoliday.create({ data });
}

export function findCompanyHoliday(tx: Db, id: string) {
  return tx.companyHoliday.findUnique({ where: { id } });
}

export function deleteCompanyHoliday(tx: Db, id: string) {
  return tx.companyHoliday.delete({ where: { id } });
}
