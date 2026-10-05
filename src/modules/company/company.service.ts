import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors/AppError.js';
import { dateOnly, formatDateOnly, todayIn } from '../../core/utils/dates.js';
import { optionalSignedUrl } from '../attachments/attachments.service.js';
import * as repo from './company.repository.js';
import type {
  CompanyDto,
  CreateHolidayInput,
  HolidayDto,
  HolidaysQuery,
  SettingsDto,
  UpdateCompanyInput,
  UpdateSettingsInput,
} from './company.schema.js';

const DEFAULT_TIMEZONE = 'Asia/Karachi';
const DEFAULT_MARLA = 225;

function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

async function loadCompany(tx: Tx, tenantId: string): Promise<repo.CompanyRow> {
  const company = await repo.findCompany(tx, tenantId);
  if (!company) throw new NotFound('COMPANY_NOT_FOUND', 'Company not found');
  return company;
}

async function toCompanyDto(company: repo.CompanyRow): Promise<CompanyDto> {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    ntn: company.ntn,
    logoAttachmentId: company.logoAttachmentId,
    logoUrl: await optionalSignedUrl(company.logo),
    address: company.address,
    phone: company.phone,
    email: company.email,
    region: company.region,
    marlaStandard: company.settings ? Number(company.settings.marlaStandardSqft) : DEFAULT_MARLA,
    status: company.status,
    createdAt: company.createdAt.toISOString(),
  };
}

// ─── Profile ────────────────────────────────────────────────────────────────

export async function getCompany(): Promise<CompanyDto> {
  const { tenantId } = current();
  return toCompanyDto(await withTenant(tenantId, (tx) => loadCompany(tx, tenantId)));
}

export async function updateCompany(input: UpdateCompanyInput): Promise<CompanyDto> {
  const { tenantId, userId } = current();
  const company = await withTenant(tenantId, async (tx) => {
    if (input.logoAttachmentId) {
      // RLS hides other tenants' files; a non-LOGO file counts as not found too.
      const logo = await repo.findAttachment(tx, input.logoAttachmentId);
      if (!logo || logo.kind !== 'LOGO') throw new NotFound('ATTACHMENT_NOT_FOUND', 'Logo not found. Upload it with kind LOGO first.');
    }

    const { marlaStandard, ...tenantFields } = input;
    const tenantData = Object.fromEntries(Object.entries(tenantFields).filter(([, v]) => v !== undefined));
    if (Object.keys(tenantData).length) await repo.updateTenant(tx, tenantId, tenantData);
    if (marlaStandard !== undefined) await repo.upsertSettings(tx, tenantId, { marlaStandardSqft: marlaStandard });

    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'company.update',
      entityType: 'Tenant',
      entityId: tenantId,
      details: { fields: Object.keys(input).filter((k) => input[k as keyof UpdateCompanyInput] !== undefined) },
    });
    return loadCompany(tx, tenantId);
  });
  return toCompanyDto(company);
}

// ─── Settings ───────────────────────────────────────────────────────────────

type SettingsRow = NonNullable<Awaited<ReturnType<typeof repo.findSettings>>>;

function toSettingsDto(s: SettingsRow): SettingsDto {
  return {
    kharchaApprovalLimitPaisa: s.kharchaApprovalLimitPaisa.toString(),
    overuseAlertPercent: s.overuseAlertPercent,
    missingLogAlertTime: s.missingLogAlertTime,
    quoteValidityDays: s.quoteValidityDays,
    taxEnabled: s.taxEnabled,
    pmCanSeeFinancials: s.pmCanSeeFinancials,
    blindCountEnabled: s.blindCountEnabled,
    defaultLanguage: s.defaultLanguage,
  };
}

export async function getSettings(): Promise<SettingsDto> {
  const { tenantId } = current();
  const settings = await withTenant(tenantId, async (tx) => (await repo.findSettings(tx, tenantId)) ?? repo.upsertSettings(tx, tenantId, {}));
  return toSettingsDto(settings);
}

export async function updateSettings(input: UpdateSettingsInput): Promise<SettingsDto> {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    const before = (await repo.findSettings(tx, tenantId)) ?? (await repo.upsertSettings(tx, tenantId, {}));
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const after = await repo.upsertSettings(tx, tenantId, data);

    const changed = Object.keys(data) as Array<keyof SettingsDto>;
    const beforeDto = toSettingsDto(before);
    const afterDto = toSettingsDto(after);
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'settings.update',
      entityType: 'TenantSettings',
      entityId: tenantId,
      details: {
        before: Object.fromEntries(changed.map((k) => [k, beforeDto[k]])),
        after: Object.fromEntries(changed.map((k) => [k, afterDto[k]])),
      },
    });
    return afterDto;
  });
}

// ─── Holidays ───────────────────────────────────────────────────────────────

function holidayRange(query: HolidaysQuery, timeZone: string): { from: Date; to: Date } {
  if (query.from && query.to) return { from: dateOnly(query.from), to: dateOnly(query.to) };
  const year = query.year ?? Number(todayIn(timeZone).slice(0, 4));
  return { from: dateOnly(`${year}-01-01`), to: dateOnly(`${year}-12-31`) };
}

export async function listHolidays(query: HolidaysQuery): Promise<HolidayDto[]> {
  const { tenantId } = current();
  return withTenant(tenantId, async (tx) => {
    const company = await loadCompany(tx, tenantId);
    const { from, to } = holidayRange(query, company.settings?.timezone ?? DEFAULT_TIMEZONE);
    const platform = await repo.listPlatformHolidays(tx, company.region, from, to);
    const own = await repo.listCompanyHolidays(tx, from, to);

    const merged: HolidayDto[] = [
      ...platform.map((h) => ({
        id: h.id,
        name: h.name,
        startDate: formatDateOnly(h.startDate),
        endDate: formatDateOnly(h.endDate ?? h.startDate),
        type: h.type,
        source: 'platform' as const,
        editable: false,
      })),
      ...own.map((h) => ({
        id: h.id,
        name: h.name,
        startDate: formatDateOnly(h.startDate),
        endDate: formatDateOnly(h.endDate ?? h.startDate),
        type: h.type,
        source: 'company' as const,
        editable: true,
      })),
    ];
    return merged.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name));
  });
}

export async function createHoliday(input: CreateHolidayInput): Promise<HolidayDto> {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    const settings = await repo.findSettings(tx, tenantId);
    const today = todayIn(settings?.timezone ?? DEFAULT_TIMEZONE);
    if (input.startDate < today) throw new BadRequest('HOLIDAY_IN_PAST', 'startDate cannot be in the past', { today });

    let holiday;
    try {
      holiday = await repo.createHoliday(tx, {
        tenantId,
        name: input.name,
        startDate: dateOnly(input.startDate),
        endDate: input.endDate ? dateOnly(input.endDate) : null,
        type: input.type,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new Conflict('HOLIDAY_EXISTS', 'A holiday with this name already starts on that date');
      }
      throw err;
    }
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'holiday.create',
      entityType: 'CompanyHoliday',
      entityId: holiday.id,
      details: { name: input.name, startDate: input.startDate, endDate: input.endDate ?? null, type: input.type },
    });
    return {
      id: holiday.id,
      name: holiday.name,
      startDate: input.startDate,
      endDate: input.endDate ?? input.startDate,
      type: holiday.type,
      source: 'company',
      editable: true,
    };
  });
}

export async function deleteHoliday(id: string): Promise<{ deleted: true }> {
  const { tenantId, userId } = current();
  return withTenant(tenantId, async (tx) => {
    // Platform holidays live in another table, so their ids are simply "not found" here.
    const holiday = await repo.findCompanyHoliday(tx, id);
    if (!holiday) throw new NotFound('HOLIDAY_NOT_FOUND', 'Company holiday not found');
    await repo.deleteCompanyHoliday(tx, id);
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: userId,
      action: 'holiday.delete',
      entityType: 'CompanyHoliday',
      entityId: id,
      details: { name: holiday.name, startDate: formatDateOnly(holiday.startDate) },
    });
    return { deleted: true as const };
  });
}
