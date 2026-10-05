import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePermission, requireRole } from '../../core/middleware/requireRole.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './procurement.controller.js';
import {
  chequeStatusBody,
  correctionBody,
  createPaymentBody,
  createPurchaseBody,
  createPurchaseOrderBody,
  idParams,
  ledgerQuery,
  listPaymentsQuery,
  listPurchaseOrdersQuery,
  listPurchasesQuery,
  listReturnsQuery,
  purchaseReturnBody,
  receivePurchaseBody,
  setRatesBody,
  updatePurchaseOrderBody,
} from './procurement.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → role / permission → validate → handler.
 * MUNSHI may record site purchases (no rates) and receive site deliveries; everything with
 * money (rates, ledgers, payments) needs rates.view.
 */
const office = requireRole('THEKEDAR', 'PM');
const owner = requireRole('THEKEDAR');
const rates = requirePermission('rates.view');

/** Mounted at /api/v1/purchase-orders */
export const purchaseOrdersRouter = Router();
purchaseOrdersRouter.use(...company, office, rates);
purchaseOrdersRouter.get('/', validate({ query: listPurchaseOrdersQuery }), h(c.listOrders));
purchaseOrdersRouter.post('/', validate({ body: createPurchaseOrderBody }), h(c.createOrder));
purchaseOrdersRouter.get('/:id', validate({ params: idParams }), h(c.getOrder));
purchaseOrdersRouter.patch('/:id', validate({ params: idParams, body: updatePurchaseOrderBody }), h(c.updateOrder));
purchaseOrdersRouter.post('/:id/cancel', validate({ params: idParams }), h(c.cancelOrder));

/** Mounted at /api/v1/purchases */
export const purchasesRouter = Router();
purchasesRouter.use(...company);
purchasesRouter.get('/', validate({ query: listPurchasesQuery }), h(c.listPurchases));
purchasesRouter.post('/', validate({ body: createPurchaseBody }), h(c.createPurchase));
purchasesRouter.get('/:id', validate({ params: idParams }), h(c.getPurchase));
purchasesRouter.patch('/:id/rates', office, rates, validate({ params: idParams, body: setRatesBody }), h(c.setRates));
purchasesRouter.post('/:id/corrections', owner, validate({ params: idParams, body: correctionBody }), h(c.correctPurchase));
purchasesRouter.post('/:id/returns', office, rates, validate({ params: idParams, body: purchaseReturnBody }), h(c.createReturn));
purchasesRouter.post('/:id/receive', validate({ params: idParams, body: receivePurchaseBody }), h(c.receivePurchase));

/** Mounted at /api/v1/purchase-returns */
export const purchaseReturnsRouter = Router();
purchaseReturnsRouter.use(...company, office, rates);
purchaseReturnsRouter.get('/', validate({ query: listReturnsQuery }), h(c.listReturns));

/** Mounted at /api/v1/suppliers before the master-data suppliers router (per-route middleware). */
export const supplierLedgerRouter = Router();
supplierLedgerRouter.get('/:id/ledger', ...company, office, rates, validate({ params: idParams, query: ledgerQuery }), h(c.getLedger));

/** Mounted at /api/v1/supplier-payments */
export const supplierPaymentsRouter = Router();
supplierPaymentsRouter.use(...company);
supplierPaymentsRouter.get('/', office, rates, validate({ query: listPaymentsQuery }), h(c.listPayments));
supplierPaymentsRouter.post('/', owner, validate({ body: createPaymentBody }), h(c.createPayment));
supplierPaymentsRouter.patch('/:id/cheque-status', owner, validate({ params: idParams, body: chequeStatusBody }), h(c.setChequeStatus));
