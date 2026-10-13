import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './labor.controller.js';
import {
  advanceBody,
  advancesQuery,
  assignSubcontractBody,
  assignWorkerBody,
  attendanceBody,
  attendanceQuery,
  deductionBody,
  generateBody,
  idParams,
  lineBody,
  lineParams,
  measurementBody,
  measurementsQuery,
  payBody,
  progressBody,
  projectWorkersQuery,
  rejectBody,
  returnBody,
  settlementsQuery,
  subcontractPaymentBody,
  subcontractsQuery,
  updateProjectWorkerBody,
  updateSubcontractBody,
} from './labor.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → requirePerm → validate → handler.
 * Project scoping (PM / MUNSHI only their projects, outside → 404) and the finer rules
 * (MUNSHI pays from site cash only, never sees sub-contract money) are in the services.
 */

/** Project-scoped labour routes, mounted at /api/v1/projects before the projects router (middleware per route). */
export const projectLaborRouter = Router();
const p = projectLaborRouter;
p.get('/:id/labor/workers', ...company, requirePerm('labor.team.view'), validate({ params: idParams, query: projectWorkersQuery }), h(c.listWorkers));
p.post('/:id/labor/workers', ...company, requirePerm('labor.team.create'), validate({ params: idParams, body: assignWorkerBody }), h(c.assignWorker));
p.get('/:id/labor/subcontracts', ...company, requirePerm('labor.team.view'), validate({ params: idParams, query: subcontractsQuery }), h(c.listSubcontracts));
p.post('/:id/labor/subcontracts', ...company, requirePerm('labor.subcontract.create'), validate({ params: idParams, body: assignSubcontractBody }), h(c.assignSubcontract));
p.post('/:id/attendance', ...company, requirePerm('labor.attendance.create'), validate({ params: idParams, body: attendanceBody }), h(c.markAttendance));
p.get('/:id/attendance', ...company, requirePerm('labor.attendance.view'), validate({ params: idParams, query: attendanceQuery }), h(c.attendanceGrid));
p.get('/:id/attendance/today', ...company, requirePerm('labor.attendance.view'), validate({ params: idParams }), h(c.todayAttendance));
p.post('/:id/work-measurements', ...company, requirePerm('labor.measurement.create'), validate({ params: idParams, body: measurementBody }), h(c.recordMeasurement));
p.get('/:id/work-measurements', ...company, requirePerm('labor.measurement.view'), validate({ params: idParams, query: measurementsQuery }), h(c.listMeasurements));
p.post('/:id/advances', ...company, requirePerm('labor.advance.create'), validate({ params: idParams, body: advanceBody }), h(c.createAdvance));
p.get('/:id/advances', ...company, requirePerm('labor.advance.view'), validate({ params: idParams, query: advancesQuery }), h(c.listAdvances));
p.post('/:id/settlements/generate', ...company, requirePerm('labor.settlement.create'), validate({ params: idParams, body: generateBody }), h(c.generate));
p.get('/:id/settlements', ...company, requirePerm('labor.settlement.view'), validate({ params: idParams, query: settlementsQuery }), h(c.listProjectSettlements));
p.get('/:id/subcontract-accounts', ...company, requirePerm('labor.account.view'), validate({ params: idParams }), h(c.listAccounts));

/** Mounted at /api/v1/labor — dashboard overview (THEKEDAR, PM). */
export const laborOverviewRouter = Router();
laborOverviewRouter.get('/overview', ...company, requirePerm('dashboard.overview.view'), h(c.laborOverview));

/** One worker / sub-contractor across projects; mounted at /api/v1 before the master-data routers (per-route middleware). */
export const workforceLaborRouter = Router();
workforceLaborRouter.get('/workers/:id/labor-summary', ...company, requirePerm('labor.account.view'), validate({ params: idParams }), h(c.workerSummary));
workforceLaborRouter.get('/subcontractors/:id/labor-summary', ...company, requirePerm('labor.account.view'), validate({ params: idParams }), h(c.subcontractorSummary));

/** Mounted at /api/v1/project-workers */
export const projectWorkersRouter = Router();
projectWorkersRouter.use(...company);
projectWorkersRouter.patch('/:id', requirePerm('labor.team.edit'), validate({ params: idParams, body: updateProjectWorkerBody }), h(c.updateWorker));
projectWorkersRouter.delete('/:id', requirePerm('labor.team.edit'), validate({ params: idParams }), h(c.removeWorker));

/** Mounted at /api/v1/subcontract-assignments */
export const subcontractAssignmentsRouter = Router();
const s = subcontractAssignmentsRouter;
s.use(...company);
s.patch('/:id', requirePerm('labor.subcontract.edit'), validate({ params: idParams, body: updateSubcontractBody }), h(c.updateSubcontract));
s.get('/:id/ledger', requirePerm('labor.account.view'), validate({ params: idParams }), h(c.ledger));
s.post('/:id/progress', requirePerm('labor.subcontract.edit'), validate({ params: idParams, body: progressBody }), h(c.progress));
s.post('/:id/payments', requirePerm('labor.subcontractpayment.create'), validate({ params: idParams, body: subcontractPaymentBody }), h(c.paySubcontract));
s.post('/:id/deductions', requirePerm('labor.subcontract.manage'), validate({ params: idParams, body: deductionBody }), h(c.deduct));

/** Mounted at /api/v1/work-measurements */
export const workMeasurementsRouter = Router();
workMeasurementsRouter.use(...company);
workMeasurementsRouter.post('/:id/verify', requirePerm('labor.measurement.approve'), validate({ params: idParams }), h(c.verifyMeasurement));
workMeasurementsRouter.post('/:id/reject', requirePerm('labor.measurement.approve'), validate({ params: idParams, body: rejectBody }), h(c.rejectMeasurement));

/** Mounted at /api/v1/settlements */
export const settlementsRouter = Router();
const w = settlementsRouter;
w.use(...company);
w.get('/', requirePerm('labor.settlement.approve'), validate({ query: settlementsQuery }), h(c.listSettlements));
w.get('/:id', requirePerm('labor.settlement.view'), validate({ params: idParams }), h(c.getSettlement));
w.patch('/:id/lines/:lineId', requirePerm('labor.settlement.edit'), validate({ params: lineParams, body: lineBody }), h(c.adjustLine));
w.post('/:id/submit', requirePerm('labor.settlement.create'), validate({ params: idParams }), h(c.submit));
w.post('/:id/approve', requirePerm('labor.settlement.approve'), validate({ params: idParams }), h(c.approve));
w.post('/:id/return', requirePerm('labor.settlement.approve'), validate({ params: idParams, body: returnBody }), h(c.returnSettlement));
w.post('/:id/pay', requirePerm('labor.wagepayment.create'), validate({ params: idParams, body: payBody }), h(c.paySettlement));
