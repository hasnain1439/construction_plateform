import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './subscription.controller.js';
import { changePlanBody, listPaymentsQuery, submitPaymentBody } from './subscription.schema.js';

/**
 * Mounted at /api/v1/subscription. subscription.manage (owner-only permission). readOnlyGuard lets every route here
 * through on a READ_ONLY company — paying is how a lapsed company gets back.
 */
export const subscriptionRouter = Router();

subscriptionRouter.use(authenticate, tenantContext, readOnlyGuard, requirePerm('subscription.manage'));

subscriptionRouter.get('/', h(c.getSubscription));
subscriptionRouter.get('/plans', h(c.listPlans));
subscriptionRouter.get('/payments', validate({ query: listPaymentsQuery }), h(c.listPayments));
subscriptionRouter.post('/payments', validate({ body: submitPaymentBody }), h(c.submitPayment));
subscriptionRouter.post('/change-plan', validate({ body: changePlanBody }), h(c.changePlan));
subscriptionRouter.delete('/change-plan', h(c.cancelPlanChange));
