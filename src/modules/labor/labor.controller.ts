import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as advances from './advances.service.js';
import * as assignments from './assignments.service.js';
import * as attendance from './attendance.service.js';
import type {
  AdvanceInput,
  AdvancesQuery,
  AssignSubcontractInput,
  AssignWorkerInput,
  AttendanceInput,
  AttendanceQuery,
  DeductionInput,
  LineInput,
  MeasurementInput,
  MeasurementsQuery,
  PayInput,
  ProgressInput,
  SettlementsQuery,
  SubcontractPaymentInput,
  UpdateProjectWorkerInput,
  UpdateSubcontractInput,
} from './labor.schema.js';
import type { Created } from './labor.shared.js';
import * as measurements from './measurements.service.js';
import * as overview from './overview.service.js';
import * as settlements from './settlements.service.js';
import * as subcontracts from './subcontracts.service.js';

const param = (req: Request, name: string) => String(req.params[name]);
const query = <T>(req: Request) => req.query as unknown as T;
/** Offline creates: 201 the first time, 200 (same record) when the clientId is sent again. */
const replayable = <T>(res: Response, r: Created<T>) => (r.created ? created(res, r.data) : ok(res, r.data));

// B1
export const listWorkers = async (req: Request, res: Response) => ok(res, await assignments.listProjectWorkers(param(req, 'id'), query<{ active?: boolean }>(req)));
export const assignWorker = async (req: Request, res: Response) => created(res, await assignments.assignWorker(param(req, 'id'), req.body as AssignWorkerInput));
export const updateWorker = async (req: Request, res: Response) => ok(res, await assignments.updateProjectWorker(param(req, 'id'), req.body as UpdateProjectWorkerInput));
export const removeWorker = async (req: Request, res: Response) => ok(res, await assignments.removeProjectWorker(param(req, 'id')));
export const listSubcontracts = async (req: Request, res: Response) => ok(res, await assignments.listSubcontracts(param(req, 'id'), query<{ active?: boolean }>(req)));
export const assignSubcontract = async (req: Request, res: Response) =>
  created(res, await assignments.assignSubcontract(param(req, 'id'), req.body as AssignSubcontractInput));
export const updateSubcontract = async (req: Request, res: Response) => ok(res, await assignments.updateSubcontract(param(req, 'id'), req.body as UpdateSubcontractInput));

// B2
export const markAttendance = async (req: Request, res: Response) => ok(res, await attendance.markAttendance(param(req, 'id'), req.body as AttendanceInput));
export const attendanceGrid = async (req: Request, res: Response) => ok(res, await attendance.attendanceGrid(param(req, 'id'), query<AttendanceQuery>(req)));
export const todayAttendance = async (req: Request, res: Response) => ok(res, await attendance.todayAttendance(param(req, 'id')));

// B3
export const recordMeasurement = async (req: Request, res: Response) => replayable(res, await measurements.recordMeasurement(param(req, 'id'), req.body as MeasurementInput));
export async function listMeasurements(req: Request, res: Response) {
  const { data, meta } = await measurements.listMeasurements(param(req, 'id'), query<MeasurementsQuery>(req));
  return ok(res, data, meta);
}
export const verifyMeasurement = async (req: Request, res: Response) => ok(res, await measurements.verifyMeasurement(param(req, 'id')));
export const rejectMeasurement = async (req: Request, res: Response) => ok(res, await measurements.rejectMeasurement(param(req, 'id'), (req.body as { note: string }).note));
export const createAdvance = async (req: Request, res: Response) => replayable(res, await advances.createAdvance(param(req, 'id'), req.body as AdvanceInput));
export async function listAdvances(req: Request, res: Response) {
  const { data, meta } = await advances.listAdvances(param(req, 'id'), query<AdvancesQuery>(req));
  return ok(res, data, meta);
}

// B4
export const generate = async (req: Request, res: Response) => ok(res, await settlements.generate(param(req, 'id'), (req.body as { weekStart: string }).weekStart));
export async function listProjectSettlements(req: Request, res: Response) {
  const { data, meta } = await settlements.listSettlements(param(req, 'id'), query<SettlementsQuery>(req));
  return ok(res, data, meta);
}
export async function listSettlements(req: Request, res: Response) {
  const { data, meta } = await settlements.listSettlements(null, query<SettlementsQuery>(req));
  return ok(res, data, meta);
}
export const getSettlement = async (req: Request, res: Response) => ok(res, await settlements.getSettlement(param(req, 'id')));
export const adjustLine = async (req: Request, res: Response) => ok(res, await settlements.adjustLine(param(req, 'id'), param(req, 'lineId'), req.body as LineInput));
export const submit = async (req: Request, res: Response) => ok(res, await settlements.submit(param(req, 'id')));
export const approve = async (req: Request, res: Response) => ok(res, await settlements.approve(param(req, 'id')));
export const returnSettlement = async (req: Request, res: Response) => ok(res, await settlements.returnSettlement(param(req, 'id'), (req.body as { comment: string }).comment));
export const paySettlement = async (req: Request, res: Response) => ok(res, await settlements.pay(param(req, 'id'), req.body as PayInput));

// Office overview
export const laborOverview = async (_req: Request, res: Response) => ok(res, await overview.laborOverview());
export const workerSummary = async (req: Request, res: Response) => ok(res, await overview.workerSummary(param(req, 'id')));
export const subcontractorSummary = async (req: Request, res: Response) => ok(res, await overview.subcontractorSummary(param(req, 'id')));

// B5
export const listAccounts = async (req: Request, res: Response) => ok(res, await subcontracts.listAccounts(param(req, 'id')));
export const ledger = async (req: Request, res: Response) => ok(res, await subcontracts.ledger(param(req, 'id')));
export const progress = async (req: Request, res: Response) => ok(res, await subcontracts.progress(param(req, 'id'), req.body as ProgressInput));
export const paySubcontract = async (req: Request, res: Response) => created(res, await subcontracts.pay(param(req, 'id'), req.body as SubcontractPaymentInput));
export const deduct = async (req: Request, res: Response) => created(res, await subcontracts.deduct(param(req, 'id'), req.body as DeductionInput));
