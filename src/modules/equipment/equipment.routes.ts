import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './equipment.controller.js';
import * as S from './equipment.schema.js';

/**
 * authenticate → tenantContext → readOnlyGuard → requirePerm → validate → handler.
 * Location / project scope (assigned projects; the yard for equipment managers) is checked in the
 * services; out of scope → 404. Rates and amounts only with fields.rates.
 */

/** Mounted at /api/v1/equipment — fixed paths before /:id. */
export const equipmentRouter = Router();
equipmentRouter.use(...company);
equipmentRouter.get('/balances', requirePerm('equipment.view'), validate({ query: S.balancesQuery }), h(c.allocation));
equipmentRouter.get('/movements', requirePerm('equipment.view'), validate({ query: S.movementsQuery }), h(c.listMovements));
equipmentRouter.get('/charges', requirePerm('equipment.view'), validate({ query: S.listChargesQuery }), h(c.listCharges));
equipmentRouter.post('/accruals/run', requirePerm('equipment.manage'), validate({ body: S.accrualBody }), h(c.runAccrual));
equipmentRouter.get('/shuttering-demand', requirePerm('equipment.view'), validate({ query: S.shutteringDemandQuery }), h(c.shutteringDemand));
equipmentRouter.get('/idle', requirePerm('equipment.view'), validate({ query: S.idleQuery }), h(c.listIdle));
equipmentRouter.post('/idle/check', requirePerm('equipment.rental.manage'), h(c.runIdleCheck));

equipmentRouter.get('/transfers', requirePerm('equipment.view'), validate({ query: S.listTransfersQuery }), h(c.listTransfers));
equipmentRouter.post('/transfers', requirePerm('equipment.transfer.create'), validate({ body: S.createTransferBody }), h(c.createTransfer));
equipmentRouter.get('/transfers/:id', requirePerm('equipment.view'), validate({ params: S.idParams }), h(c.getTransfer));
equipmentRouter.post('/transfers/:id/receive', requirePerm('equipment.receiving.create'), validate({ params: S.idParams, body: S.receiveTransferBody }), h(c.receiveTransfer));
equipmentRouter.post('/transfers/:id/cancel', requirePerm('equipment.transfer.create'), validate({ params: S.idParams }), h(c.cancelTransfer));

equipmentRouter.get('/rentals', requirePerm('equipment.view'), validate({ query: S.listRentalsQuery }), h(c.listRentals));
equipmentRouter.post('/rentals', requirePerm('equipment.rental.manage'), validate({ body: S.createRentalBody }), h(c.createRental));
equipmentRouter.get('/rentals/:id', requirePerm('equipment.view'), validate({ params: S.idParams }), h(c.getRental));
equipmentRouter.post('/rentals/:id/extend', requirePerm('equipment.rental.manage'), validate({ params: S.idParams, body: S.extendRentalBody }), h(c.extendRental));
equipmentRouter.post('/rentals/:id/return', requirePerm('equipment.rental.manage'), validate({ params: S.idParams, body: S.returnRentalBody }), h(c.returnRental));
equipmentRouter.post('/rentals/:id/close', requirePerm('equipment.rental.manage'), validate({ params: S.idParams, body: S.closeRentalBody }), h(c.closeRental));

equipmentRouter.get('/losses', requirePerm('equipment.view'), validate({ query: S.listLossesQuery }), h(c.listLosses));
equipmentRouter.post('/losses', requirePerm('equipment.loss.create'), validate({ body: S.reportLossBody }), h(c.reportLoss));
equipmentRouter.get('/losses/:id', requirePerm('equipment.view'), validate({ params: S.idParams }), h(c.getLoss));
equipmentRouter.post('/losses/:id/charge', requirePerm('equipment.loss.approve'), validate({ params: S.idParams, body: S.chargeLossBody }), h(c.chargeLoss));

equipmentRouter.get('/', requirePerm('equipment.view'), validate({ query: S.listEquipmentQuery }), h(c.listEquipment));
equipmentRouter.post('/', requirePerm('equipment.manage'), validate({ body: S.createEquipmentBody }), h(c.createEquipment));
equipmentRouter.get('/:id', requirePerm('equipment.view'), validate({ params: S.idParams }), h(c.getEquipment));
equipmentRouter.patch('/:id', requirePerm('equipment.manage'), validate({ params: S.idParams, body: S.updateEquipmentBody }), h(c.updateEquipment));
equipmentRouter.post('/:id/stock-in', requirePerm('equipment.manage'), validate({ params: S.idParams, body: S.stockInBody }), h(c.stockIn));
equipmentRouter.post('/:id/adjust', requirePerm('equipment.manage'), validate({ params: S.idParams, body: S.adjustBody }), h(c.adjust));

/** Mounted at /api/v1/projects before the projects router (per-route middleware). */
export const projectEquipmentRouter = Router();
projectEquipmentRouter.get('/:id/equipment', ...company, requirePerm('equipment.view'), validate({ params: S.idParams }), h(c.projectEquipment));
projectEquipmentRouter.get('/:id/shuttering-demand', ...company, requirePerm('equipment.view'), validate({ params: S.idParams, query: S.projectShutteringQuery }), h(c.projectShutteringDemand));
