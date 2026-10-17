import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type * as S from './equipment.schema.js';
import * as eq from './equipment.service.js';
import * as losses from './losses.service.js';
import * as rentals from './rentals.service.js';
import * as shuttering from './shuttering.service.js';
import * as transfers from './transfers.service.js';

const id = (req: Request) => String(req.params['id']);
const query = <T>(req: Request) => req.query as unknown as T;
async function paged(res: Response, p: Promise<{ data: unknown; meta: Parameters<typeof ok>[2] }>) {
  const { data, meta } = await p;
  return ok(res, data, meta);
}

export const listEquipment = (req: Request, res: Response) => paged(res, eq.listEquipment(query<S.ListEquipmentQuery>(req)));
export const createEquipment = async (req: Request, res: Response) => created(res, await eq.createEquipment(req.body as S.CreateEquipmentInput));
export const getEquipment = async (req: Request, res: Response) => ok(res, await eq.getEquipment(id(req)));
export const updateEquipment = async (req: Request, res: Response) => ok(res, await eq.updateEquipment(id(req), req.body as S.UpdateEquipmentInput));
export const stockIn = async (req: Request, res: Response) => created(res, await eq.stockIn(id(req), req.body as S.StockInInput));
export const adjust = async (req: Request, res: Response) => ok(res, await eq.adjust(id(req), req.body as S.AdjustInput));
export const allocation = async (req: Request, res: Response) => ok(res, await eq.allocation(query<S.BalancesQuery>(req)));
export const listMovements = (req: Request, res: Response) => paged(res, eq.listMovements(query<S.MovementsQuery>(req)));
export const projectEquipment = async (req: Request, res: Response) => ok(res, await eq.projectEquipment(id(req)));
export const listCharges = (req: Request, res: Response) => paged(res, eq.listCharges(query<S.ListChargesQuery>(req)));
export const runAccrual = async (req: Request, res: Response) => ok(res, await eq.runAccrual(req.body as S.AccrualInput));

export const listTransfers = (req: Request, res: Response) => paged(res, transfers.listTransfers(query<S.ListTransfersQuery>(req)));
export const createTransfer = async (req: Request, res: Response) => created(res, await transfers.createTransfer(req.body as S.CreateTransferInput));
export const getTransfer = async (req: Request, res: Response) => ok(res, await transfers.getTransfer(id(req)));
export const receiveTransfer = async (req: Request, res: Response) => ok(res, await transfers.receiveTransfer(id(req), req.body as S.ReceiveTransferInput));
export const cancelTransfer = async (req: Request, res: Response) => ok(res, await transfers.cancelTransfer(id(req)));

export const listRentals = (req: Request, res: Response) => paged(res, rentals.listRentals(query<S.ListRentalsQuery>(req)));
export const createRental = async (req: Request, res: Response) => created(res, await rentals.createRental(req.body as S.CreateRentalInput));
export const getRental = async (req: Request, res: Response) => ok(res, await rentals.getRental(id(req)));
export const extendRental = async (req: Request, res: Response) => ok(res, await rentals.extendRental(id(req), req.body as S.ExtendRentalInput));
export const returnRental = async (req: Request, res: Response) => ok(res, await rentals.returnRental(id(req), req.body as S.ReturnRentalInput));
export const closeRental = async (req: Request, res: Response) => ok(res, await rentals.closeRental(id(req), req.body as S.CloseRentalInput));

export const listLosses = (req: Request, res: Response) => paged(res, losses.listLosses(query<S.ListLossesQuery>(req)));
export const reportLoss = async (req: Request, res: Response) => created(res, await losses.reportLoss(req.body as S.ReportLossInput));
export const getLoss = async (req: Request, res: Response) => ok(res, await losses.getLoss(id(req)));
export const shutteringDemand = async (req: Request, res: Response) => ok(res, await shuttering.shutteringDemand(query<S.ShutteringDemandQuery>(req)));
export const projectShutteringDemand = async (req: Request, res: Response) => ok(res, await shuttering.projectShutteringDemand(id(req), query<Omit<S.ShutteringDemandQuery, 'projectId'>>(req)));
export const listIdle = async (req: Request, res: Response) => ok(res, await shuttering.listIdle(query<S.IdleQuery>(req)));
export const runIdleCheck = async (_req: Request, res: Response) => ok(res, await shuttering.runIdleCheck());

export const chargeLoss = async (req: Request, res: Response) => ok(res, await losses.chargeLoss(id(req), req.body as S.ChargeLossInput));
