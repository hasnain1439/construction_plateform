import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import type { ChangePlanInput, ListPaymentsQuery, SubmitPaymentInput } from './subscription.schema.js';
import * as service from './subscription.service.js';

export async function getSubscription(_req: Request, res: Response) {
  return ok(res, await service.getSubscription());
}

export async function listPlans(_req: Request, res: Response) {
  return ok(res, await service.listPlans());
}

export async function submitPayment(req: Request, res: Response) {
  return created(res, await service.submitPayment(req.body as SubmitPaymentInput));
}

export async function listPayments(req: Request, res: Response) {
  const { data, meta } = await service.listPayments(req.query as unknown as ListPaymentsQuery);
  return ok(res, data, meta);
}

export async function changePlan(req: Request, res: Response) {
  return ok(res, await service.changePlan(req.body as ChangePlanInput));
}

export async function cancelPlanChange(_req: Request, res: Response) {
  return ok(res, await service.cancelPlanChange());
}
