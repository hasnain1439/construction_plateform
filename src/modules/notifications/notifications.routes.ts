import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { validate } from '../../core/middleware/validate.js';
import { company } from '../inventory/inventory.routes.js';
import * as c from './notifications.controller.js';
import { idParams, notificationsQuery } from './notifications.schema.js';

/** Mounted at /api/v1/notifications — every company user sees only their own notifications. */
export const notificationsRouter = Router();
notificationsRouter.get('/', ...company, validate({ query: notificationsQuery }), h(c.listNotifications));
notificationsRouter.get('/unread-count', ...company, h(c.unreadCount));
notificationsRouter.patch('/read-all', ...company, h(c.markAllRead));
notificationsRouter.patch('/:id/read', ...company, validate({ params: idParams }), h(c.markRead));
