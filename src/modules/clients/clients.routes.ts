import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requireRole } from '../../core/middleware/requireRole.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './clients.controller.js';
import { clientIdParams, createClientBody, listClientsQuery, updateClientBody } from './clients.schema.js';

/** Mounted at /api/v1/clients — THEKEDAR and PM only (clients have no login). */
export const clientsRouter = Router();
clientsRouter.use(authenticate, tenantContext, readOnlyGuard, requireRole('THEKEDAR', 'PM'));

clientsRouter.get('/', validate({ query: listClientsQuery }), h(c.listClients));
clientsRouter.post('/', validate({ body: createClientBody }), h(c.createClient));
clientsRouter.get('/:id', validate({ params: clientIdParams }), h(c.getClient));
clientsRouter.patch('/:id', validate({ params: clientIdParams, body: updateClientBody }), h(c.updateClient));
