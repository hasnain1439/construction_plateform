import type { Request, Response } from 'express';
import { ok } from '../../core/http/response.js';
import type { NotificationsQuery } from './notifications.schema.js';
import * as service from './notifications.service.js';

export const listNotifications = async (req: Request, res: Response) => {
  const r = await service.listNotifications(req.query as unknown as NotificationsQuery);
  return ok(res, r.data, r.meta);
};
export const unreadCount = async (_req: Request, res: Response) => ok(res, await service.unreadCount());
export const markRead = async (req: Request, res: Response) => ok(res, await service.markRead(String(req.params['id'])));
export const markAllRead = async (_req: Request, res: Response) => ok(res, await service.markAllRead());
