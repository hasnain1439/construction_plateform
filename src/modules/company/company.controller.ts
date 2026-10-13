import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as auditLog from './auditLog.service.js';
import type { CompanyAuditQuery, CreateHolidayInput, HolidaysQuery, UpdateCompanyInput, UpdateSettingsInput } from './company.schema.js';
import * as service from './company.service.js';

export async function getCompany(_req: Request, res: Response) {
  return ok(res, await service.getCompany());
}

export async function updateCompany(req: Request, res: Response) {
  return ok(res, await service.updateCompany(req.body as UpdateCompanyInput));
}

export async function getSettings(_req: Request, res: Response) {
  return ok(res, await service.getSettings());
}

export async function updateSettings(req: Request, res: Response) {
  return ok(res, await service.updateSettings(req.body as UpdateSettingsInput));
}

export async function listHolidays(req: Request, res: Response) {
  return ok(res, await service.listHolidays(req.query as unknown as HolidaysQuery));
}

export async function createHoliday(req: Request, res: Response) {
  return created(res, await service.createHoliday(req.body as CreateHolidayInput));
}

export async function deleteHoliday(req: Request, res: Response) {
  return ok(res, await service.deleteHoliday(String(req.params['id'])));
}

export async function listAuditLogs(req: Request, res: Response) {
  const { data, meta } = await auditLog.listCompanyAuditLogs(req.query as unknown as CompanyAuditQuery);
  return ok(res, data, meta);
}
