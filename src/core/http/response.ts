import type { Response } from 'express';

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): Response {
  const body: SuccessBody<T> = meta ? { success: true, data, meta } : { success: true, data };
  return res.status(200).json(body);
}

export function created<T>(res: Response, data: T): Response {
  const body: SuccessBody<T> = { success: true, data };
  return res.status(201).json(body);
}
