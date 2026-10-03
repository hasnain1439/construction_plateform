import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requireRole } from '../../core/middleware/requireRole.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './company.controller.js';
import { createHolidayBody, holidayIdParams, holidaysQuery, updateCompanyBody, updateSettingsBody } from './company.schema.js';

/** Mounted at /api/v1/company */
export const companyRouter = Router();

companyRouter.use(authenticate, tenantContext, readOnlyGuard);

companyRouter.get('/', requireRole('THEKEDAR', 'PM'), h(c.getCompany));
companyRouter.patch('/', requireRole('THEKEDAR'), validate({ body: updateCompanyBody }), h(c.updateCompany));

companyRouter.get('/settings', requireRole('THEKEDAR'), h(c.getSettings));
companyRouter.patch('/settings', requireRole('THEKEDAR'), validate({ body: updateSettingsBody }), h(c.updateSettings));

companyRouter.get('/holidays', validate({ query: holidaysQuery }), h(c.listHolidays));
companyRouter.post('/holidays', requireRole('THEKEDAR'), validate({ body: createHolidayBody }), h(c.createHoliday));
companyRouter.delete('/holidays/:id', requireRole('THEKEDAR'), validate({ params: holidayIdParams }), h(c.deleteHoliday));
