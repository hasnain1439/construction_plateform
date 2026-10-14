import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './company.controller.js';
import { companyAuditQuery, createHolidayBody, holidayIdParams, holidaysQuery, updateCompanyBody, updateSettingsBody } from './company.schema.js';

/** Mounted at /api/v1/company */
export const companyRouter = Router();

companyRouter.use(authenticate, tenantContext, readOnlyGuard);

companyRouter.get('/', requirePerm('company.profile.view'), h(c.getCompany));
companyRouter.patch('/', requirePerm('company.settings.manage'), validate({ body: updateCompanyBody }), h(c.updateCompany));

companyRouter.get('/settings', requirePerm('company.settings.manage'), h(c.getSettings));
companyRouter.patch('/settings', requirePerm('company.settings.manage'), validate({ body: updateSettingsBody }), h(c.updateSettings));

companyRouter.get('/holidays', validate({ query: holidaysQuery }), h(c.listHolidays));
companyRouter.post('/holidays', requirePerm('company.holiday.manage'), validate({ body: createHolidayBody }), h(c.createHoliday));
companyRouter.delete('/holidays/:id', requirePerm('company.holiday.manage'), validate({ params: holidayIdParams }), h(c.deleteHoliday));

// Who changed what, including changes made by platform support (owner only).
companyRouter.get('/audit-logs', requirePerm('company.audit.view'), validate({ query: companyAuditQuery }), h(c.listAuditLogs));
