import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requireRole } from '../../core/middleware/requireRole.js';
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
 * authenticate → tenantContext → readOnlyGuard → role → validate → handler.
 * Project scoping (PM / MUNSHI only their projects, outside → 404) and the finer rules
 * (MUNSHI pays from site cash only, never sees sub-contract money) are in the services.
 */
const office = requireRole('THEKEDAR', 'PM');
const owner = requireRole('THEKEDAR');

/** Project-scoped labour routes, mounted at /api/v1/projects before the projects router (middleware per route). */
export const projectLaborRouter = Router();
const p = projectLaborRouter;
p.get('/:id/labor/workers', ...company, validate({ params: idParams, query: projectWorkersQuery }), h(c.listWorkers));
p.post('/:id/labor/workers', ...company, validate({ params: idParams, body: assignWorkerBody }), h(c.assignWorker));
p.get('/:id/labor/subcontracts', ...company, validate({ params: idParams, query: subcontractsQuery }), h(c.listSubcontracts));
p.post('/:id/labor/subcontracts', ...company, office, validate({ params: idParams, body: assignSubcontractBody }), h(c.assignSubcontract));
p.post('/:id/attendance', ...company, validate({ params: idParams, body: attendanceBody }), h(c.markAttendance));
p.get('/:id/attendance', ...company, validate({ params: idParams, query: attendanceQuery }), h(c.attendanceGrid));
p.get('/:id/attendance/today', ...company, validate({ params: idParams }), h(c.todayAttendance));
p.post('/:id/work-measurements', ...company, validate({ params: idParams, body: measurementBody }), h(c.recordMeasurement));
p.get('/:id/work-measurements', ...company, validate({ params: idParams, query: measurementsQuery }), h(c.listMeasurements));
p.post('/:id/advances', ...company, validate({ params: idParams, body: advanceBody }), h(c.createAdvance));
p.get('/:id/advances', ...company, validate({ params: idParams, query: advancesQuery }), h(c.listAdvances));
p.post('/:id/settlements/generate', ...company, validate({ params: idParams, body: generateBody }), h(c.generate));
p.get('/:id/settlements', ...company, validate({ params: idParams, query: settlementsQuery }), h(c.listProjectSettlements));
p.get('/:id/subcontract-accounts', ...company, office, validate({ params: idParams }), h(c.listAccounts));

/** Mounted at /api/v1/labor — dashboard overview (THEKEDAR, PM). */
export const laborOverviewRouter = Router();
laborOverviewRouter.get('/overview', ...company, office, h(c.laborOverview));

/** One worker / sub-contractor across projects; mounted at /api/v1 before the master-data routers (per-route middleware). */
export const workforceLaborRouter = Router();
workforceLaborRouter.get('/workers/:id/labor-summary', ...company, office, validate({ params: idParams }), h(c.workerSummary));
workforceLaborRouter.get('/subcontractors/:id/labor-summary', ...company, office, validate({ params: idParams }), h(c.subcontractorSummary));

/** Mounted at /api/v1/project-workers */
export const projectWorkersRouter = Router();
projectWorkersRouter.use(...company);
projectWorkersRouter.patch('/:id', office, validate({ params: idParams, body: updateProjectWorkerBody }), h(c.updateWorker));
projectWorkersRouter.delete('/:id', office, validate({ params: idParams }), h(c.removeWorker));

/** Mounted at /api/v1/subcontract-assignments */
export const subcontractAssignmentsRouter = Router();
const s = subcontractAssignmentsRouter;
s.use(...company);
s.patch('/:id', office, validate({ params: idParams, body: updateSubcontractBody }), h(c.updateSubcontract));
s.get('/:id/ledger', office, validate({ params: idParams }), h(c.ledger));
s.post('/:id/progress', office, validate({ params: idParams, body: progressBody }), h(c.progress));
s.post('/:id/payments', office, validate({ params: idParams, body: subcontractPaymentBody }), h(c.paySubcontract));
s.post('/:id/deductions', owner, validate({ params: idParams, body: deductionBody }), h(c.deduct));

/** Mounted at /api/v1/work-measurements */
export const workMeasurementsRouter = Router();
workMeasurementsRouter.use(...company);
workMeasurementsRouter.post('/:id/verify', office, validate({ params: idParams }), h(c.verifyMeasurement));
workMeasurementsRouter.post('/:id/reject', office, validate({ params: idParams, body: rejectBody }), h(c.rejectMeasurement));

/** Mounted at /api/v1/settlements */
export const settlementsRouter = Router();
const w = settlementsRouter;
w.use(...company);
w.get('/', office, validate({ query: settlementsQuery }), h(c.listSettlements));
w.get('/:id', validate({ params: idParams }), h(c.getSettlement));
w.patch('/:id/lines/:lineId', office, validate({ params: lineParams, body: lineBody }), h(c.adjustLine));
w.post('/:id/submit', validate({ params: idParams }), h(c.submit));
w.post('/:id/approve', office, validate({ params: idParams }), h(c.approve));
w.post('/:id/return', office, validate({ params: idParams, body: returnBody }), h(c.returnSettlement));
w.post('/:id/pay', validate({ params: idParams, body: payBody }), h(c.paySettlement));
