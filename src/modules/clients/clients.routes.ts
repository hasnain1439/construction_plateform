import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import * as c from './clients.controller.js';
import { clientIdParams, createClientBody, listClientsQuery, updateClientBody } from './clients.schema.js';

/** Mounted at /api/v1/clients — clients.client.* (clients have no login). */
export const clientsRouter = Router();
clientsRouter.use(authenticate, tenantContext, readOnlyGuard);

clientsRouter.get('/', requirePerm('clients.client.view'), validate({ query: listClientsQuery }), h(c.listClients));
clientsRouter.post('/', requirePerm('clients.client.create'), validate({ body: createClientBody }), h(c.createClient));
clientsRouter.get('/:id', requirePerm('clients.client.view'), validate({ params: clientIdParams }), h(c.getClient));
clientsRouter.patch('/:id', requirePerm('clients.client.edit'), validate({ params: clientIdParams, body: updateClientBody }), h(c.updateClient));
