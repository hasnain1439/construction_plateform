import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
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
 * authenticate → tenantContext → readOnlyGuard → requirePerm → validate → handler.
 * MUNSHI may record site purchases (no rates) and receive site deliveries; everything with
 * money (rates, ledgers, payments) needs fields.rates.
 */

/** Mounted at /api/v1/purchase-orders */
export const purchaseOrdersRouter = Router();
purchaseOrdersRouter.use(...company);
purchaseOrdersRouter.get('/', requirePerm('procurement.order.view'), validate({ query: listPurchaseOrdersQuery }), h(c.listOrders));
purchaseOrdersRouter.post('/', requirePerm('procurement.order.create'), validate({ body: createPurchaseOrderBody }), h(c.createOrder));
purchaseOrdersRouter.get('/:id', requirePerm('procurement.order.view'), validate({ params: idParams }), h(c.getOrder));
purchaseOrdersRouter.patch('/:id', requirePerm('procurement.order.create'), validate({ params: idParams, body: updatePurchaseOrderBody }), h(c.updateOrder));
purchaseOrdersRouter.post('/:id/cancel', requirePerm('procurement.order.create'), validate({ params: idParams }), h(c.cancelOrder));

/** Mounted at /api/v1/purchases */
export const purchasesRouter = Router();
purchasesRouter.use(...company);
purchasesRouter.get('/', requirePerm('procurement.purchase.view'), validate({ query: listPurchasesQuery }), h(c.listPurchases));
purchasesRouter.post('/', requirePerm('procurement.purchase.create'), validate({ body: createPurchaseBody }), h(c.createPurchase));
purchasesRouter.get('/:id', requirePerm('procurement.purchase.view'), validate({ params: idParams }), h(c.getPurchase));
purchasesRouter.patch('/:id/rates', requirePerm('procurement.purchase.edit'), validate({ params: idParams, body: setRatesBody }), h(c.setRates));
purchasesRouter.post('/:id/corrections', requirePerm('procurement.purchase.manage'), validate({ params: idParams, body: correctionBody }), h(c.correctPurchase));
purchasesRouter.post('/:id/returns', requirePerm('procurement.return.create'), validate({ params: idParams, body: purchaseReturnBody }), h(c.createReturn));
purchasesRouter.post('/:id/receive', requirePerm('procurement.receiving.create'), validate({ params: idParams, body: receivePurchaseBody }), h(c.receivePurchase));

/** Mounted at /api/v1/purchase-returns */
export const purchaseReturnsRouter = Router();
purchaseReturnsRouter.use(...company, requirePerm('procurement.return.view'));
purchaseReturnsRouter.get('/', validate({ query: listReturnsQuery }), h(c.listReturns));

/** Mounted at /api/v1/suppliers before the master-data suppliers router (per-route middleware). */
export const supplierLedgerRouter = Router();
supplierLedgerRouter.get('/:id/ledger', ...company, requirePerm('procurement.ledger.view'), validate({ params: idParams, query: ledgerQuery }), h(c.getLedger));

/** Mounted at /api/v1/supplier-payments */
export const supplierPaymentsRouter = Router();
supplierPaymentsRouter.use(...company);
supplierPaymentsRouter.get('/', requirePerm('procurement.payment.view'), validate({ query: listPaymentsQuery }), h(c.listPayments));
supplierPaymentsRouter.post('/', requirePerm('procurement.payment.create', { amountFrom: (req) => (req.body as { amountPaisa?: string | number } | undefined)?.amountPaisa }), validate({ body: createPaymentBody }), h(c.createPayment));
supplierPaymentsRouter.patch('/:id/cheque-status', requirePerm('procurement.payment.manage'), validate({ params: idParams, body: chequeStatusBody }), h(c.setChequeStatus));
