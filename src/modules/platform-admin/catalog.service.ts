/** Plans, platform holidays and the audit log. */
import { Prisma, prismaAdmin } from '../../core/db/prisma.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { dateOnly, formatDateOnly, todayIn } from '../../core/utils/dates.js';
import type { Plan } from '../../generated/prisma/client.js';
import { auditAdmin } from './platformAdmin.shared.js';
import type {
  AuditQuery,
  CreateHolidayInput,
  CreatePlanInput,
  HolidaysQuery,
  UpdateHolidayInput,
  UpdatePlanInput,
} from './platformAdmin.schema.js';

const DAY = 86_400_000;

// ─── Plans ──────────────────────────────────────────────────────────────────

function toPlanDto(p: Plan, companies?: number) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    pricePaisa: p.priceMonthlyPaisa.toString(),
    maxActiveProjects: p.maxActiveProjects,
    maxOfficeUsers: p.maxOfficeUsers,
    features: p.features,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
    ...(companies === undefined ? {} : { companies }),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listPlans() {
  const plans = await prismaAdmin.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  const counts = await prismaAdmin.subscription.groupBy({ by: ['planId'], _count: { _all: true } });
  return plans.map((p) => toPlanDto(p, counts.find((c) => c.planId === p.id)?._count._all ?? 0));
}

export async function createPlan(input: CreatePlanInput) {
  return prismaAdmin.$transaction(async (tx) => {
    if (await tx.plan.findUnique({ where: { code: input.code }, select: { id: true } })) {
      throw new Conflict('PLAN_CODE_TAKEN', `A plan with code ${input.code} already exists`);
    }
    const plan = await tx.plan.create({
      data: {
        code: input.code,
        name: input.name,
        priceMonthlyPaisa: input.pricePaisa,
        maxActiveProjects: input.maxActiveProjects,
        maxOfficeUsers: input.maxOfficeUsers,
        features: input.features,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      },
    });
    await auditAdmin(tx, { action: 'admin.plan_created', entityType: 'Plan', entityId: plan.id, details: { planCode: plan.code, pricePaisa: plan.priceMonthlyPaisa.toString() } });
    return toPlanDto(plan, 0);
  });
}

/** Code is immutable. A new price applies to future payments only (payments store their amount). */
export async function updatePlan(id: string, input: UpdatePlanInput) {
  return prismaAdmin.$transaction(async (tx) => {
    const plan = await tx.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFound('PLAN_NOT_FOUND', 'Plan not found');

    if (input.isActive === false && plan.isActive && plan.code !== 'TRIAL') {
      const otherPaid = await tx.plan.count({ where: { id: { not: id }, isActive: true, code: { not: 'TRIAL' } } });
      if (otherPaid === 0) throw new Conflict('LAST_ACTIVE_PLAN', 'This is the only active paid plan — companies would have nothing to buy');
    }

    const data: Prisma.PlanUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.pricePaisa !== undefined) data.priceMonthlyPaisa = input.pricePaisa;
    if (input.maxActiveProjects !== undefined) data.maxActiveProjects = input.maxActiveProjects;
    if (input.maxOfficeUsers !== undefined) data.maxOfficeUsers = input.maxOfficeUsers;
    if (input.features !== undefined) data.features = input.features;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    const updated = await tx.plan.update({ where: { id }, data });

    const changes = Object.fromEntries(
      Object.entries(input)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
    );
    await auditAdmin(tx, { action: 'admin.plan_updated', entityType: 'Plan', entityId: id, details: { planCode: plan.code, changes } as Prisma.InputJsonObject });
    const companies = await tx.subscription.count({ where: { planId: id } });
    return toPlanDto(updated, companies);
  });
}

// ─── Platform holidays ──────────────────────────────────────────────────────

type HolidayRow = Prisma.PlatformHolidayGetPayload<object>;

function toHolidayDto(h: HolidayRow) {
  return {
    id: h.id,
    name: h.name,
    startDate: formatDateOnly(h.startDate),
    endDate: formatDateOnly(h.endDate ?? h.startDate),
    type: h.type,
    region: h.region,
  };
}

const holidayExists = () => new Conflict('HOLIDAY_EXISTS', 'A holiday with this name already starts on that date');
const isUniqueClash = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export async function listHolidays(query: HolidaysQuery) {
  const year = query.year ?? Number(todayIn('Asia/Karachi').slice(0, 4));
  const from = dateOnly(`${year}-01-01`);
  const to = dateOnly(`${year}-12-31`);
  const rows = await prismaAdmin.platformHoliday.findMany({
    where: { startDate: { lte: to }, OR: [{ endDate: null, startDate: { gte: from } }, { endDate: { gte: from } }] },
    orderBy: [{ startDate: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toHolidayDto);
}

export async function createHoliday(input: CreateHolidayInput) {
  try {
    return await prismaAdmin.$transaction(async (tx) => {
      const h = await tx.platformHoliday.create({
        data: {
          name: input.name,
          startDate: dateOnly(input.startDate),
          endDate: input.endDate ? dateOnly(input.endDate) : null,
          type: input.type,
          region: input.region ?? null,
        },
      });
      await auditAdmin(tx, { action: 'admin.holiday_created', entityType: 'PlatformHoliday', entityId: h.id, details: toHolidayDto(h) });
      return toHolidayDto(h);
    });
  } catch (err) {
    if (isUniqueClash(err)) throw holidayExists();
    throw err;
  }
}

export async function updateHoliday(id: string, input: UpdateHolidayInput) {
  try {
    return await prismaAdmin.$transaction(async (tx) => {
      const current = await tx.platformHoliday.findUnique({ where: { id } });
      if (!current) throw new NotFound('HOLIDAY_NOT_FOUND', 'Holiday not found');
      const startDate = input.startDate ? dateOnly(input.startDate) : current.startDate;
      const endDate = input.endDate === undefined ? current.endDate : input.endDate ? dateOnly(input.endDate) : null;
      if (endDate && endDate < startDate) {
        throw new BadRequest('VALIDATION_ERROR', 'Some fields are invalid', { fields: [{ field: 'endDate', message: 'endDate must be on or after startDate' }] });
      }
      const h = await tx.platformHoliday.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          startDate,
          endDate,
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
        },
      });
      await auditAdmin(tx, { action: 'admin.holiday_updated', entityType: 'PlatformHoliday', entityId: id, details: { before: toHolidayDto(current), after: toHolidayDto(h) } });
      return toHolidayDto(h);
    });
  } catch (err) {
    if (isUniqueClash(err)) throw holidayExists();
    throw err;
  }
}

export async function deleteHoliday(id: string) {
  return prismaAdmin.$transaction(async (tx) => {
    const h = await tx.platformHoliday.findUnique({ where: { id } });
    if (!h) throw new NotFound('HOLIDAY_NOT_FOUND', 'Holiday not found');
    await tx.platformHoliday.delete({ where: { id } });
    await auditAdmin(tx, { action: 'admin.holiday_deleted', entityType: 'PlatformHoliday', entityId: id, details: toHolidayDto(h) });
    return { deleted: true as const };
  });
}

// ─── Audit log ──────────────────────────────────────────────────────────────

/** Key names that must never be returned, even if some code wrote them into an audit row. */
const SECRET_KEY = /password|secret|token|hash|pepper|signature|^sig$|^otp$|^code$/i;

/** Defence in depth: audit details never hold secrets, but strip anything that looks like one. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : scrub(v)]),
    );
  }
  return value;
}

export async function listAuditLogs(query: AuditQuery) {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(query.action ? { action: { startsWith: query.action } } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: dateOnly(query.from) } : {}),
            ...(query.to ? { lt: new Date(dateOnly(query.to).getTime() + DAY) } : {}),
          },
        }
      : {}),
  };
  const { skip, take } = skipTake(query);
  const rows = await prismaAdmin.auditLog.findMany({
    where,
    include: { tenant: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip,
    take,
  });
  const total = await prismaAdmin.auditLog.count({ where });
  return {
    data: rows.map((r) => ({
      id: r.id,
      tenant: r.tenantId ? { id: r.tenantId, name: r.tenant?.name ?? null } : null,
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      details: scrub(r.details),
      ip: r.ip,
      userAgent: r.userAgent,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
    meta: pageMeta(query, total),
  };
}
