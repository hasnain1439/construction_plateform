import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type {
  ChequeStatusInput,
  CorrectionInput,
  CreatePaymentInput,
  CreatePurchaseInput,
  CreatePurchaseOrderInput,
  LedgerQuery,
  ListPaymentsQuery,
  ListPurchaseOrdersQuery,
  ListPurchasesQuery,
  ListReturnsQuery,
  PurchaseReturnInput,
  ReceivePurchaseInput,
  SetRatesInput,
  UpdatePurchaseOrderInput,
} from './procurement.schema.js';
import * as orders from './purchaseOrders.service.js';
import * as purchases from './purchases.service.js';
import * as ledger from './supplierLedger.service.js';

const id = (req: Request) => String(req.params['id']);
const query = <T>(req: Request) => req.query as unknown as T;

// ─── Purchase orders ────────────────────────────────────────────────────────

export async function listOrders(req: Request, res: Response) {
  const { data, meta } = await orders.listOrders(query<ListPurchaseOrdersQuery>(req));
  return ok(res, data, meta);
}
export const getOrder = async (req: Request, res: Response) => ok(res, await orders.getOrder(id(req)));
export const createOrder = async (req: Request, res: Response) => created(res, await orders.createOrder(req.body as CreatePurchaseOrderInput));
export const updateOrder = async (req: Request, res: Response) => ok(res, await orders.updateOrder(id(req), req.body as UpdatePurchaseOrderInput));
export const cancelOrder = async (req: Request, res: Response) => ok(res, await orders.cancelOrder(id(req)));

// ─── Purchases ──────────────────────────────────────────────────────────────

export async function listPurchases(req: Request, res: Response) {
  const { data, meta } = await purchases.listPurchases(query<ListPurchasesQuery>(req));
  return ok(res, data, meta);
}
export const getPurchase = async (req: Request, res: Response) => ok(res, await purchases.getPurchase(id(req)));
export const createPurchase = async (req: Request, res: Response) => created(res, await purchases.createPurchase(req.body as CreatePurchaseInput));
export const setRates = async (req: Request, res: Response) => ok(res, await purchases.setRates(id(req), req.body as SetRatesInput));
export const correctPurchase = async (req: Request, res: Response) => created(res, await purchases.correctPurchase(id(req), req.body as CorrectionInput));
export const receivePurchase = async (req: Request, res: Response) => ok(res, await purchases.receivePurchase(id(req), req.body as ReceivePurchaseInput));
export const createReturn = async (req: Request, res: Response) => created(res, await purchases.createReturn(id(req), req.body as PurchaseReturnInput));
export async function listReturns(req: Request, res: Response) {
  const { data, meta } = await purchases.listReturns(query<ListReturnsQuery>(req));
  return ok(res, data, meta);
}

// ─── Supplier ledger + payments ─────────────────────────────────────────────

export async function getLedger(req: Request, res: Response) {
  const { data, meta } = await ledger.getLedger(id(req), query<LedgerQuery>(req));
  return ok(res, data, meta);
}
export const createPayment = async (req: Request, res: Response) => created(res, await ledger.createPayment(req.body as CreatePaymentInput));
export const setChequeStatus = async (req: Request, res: Response) => ok(res, await ledger.setChequeStatus(id(req), req.body as ChequeStatusInput));
export async function listPayments(req: Request, res: Response) {
  const { data, meta } = await ledger.listPayments(query<ListPaymentsQuery>(req));
  return ok(res, data, meta);
}
