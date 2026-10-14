import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as checklist from './checklist.service.js';
import * as demo from './demo.service.js';
import type { ImportEntity } from './imports.entities.js';
import * as imports from './imports.service.js';
import type { OpeningInput, OpeningKind } from './onboarding.schema.js';
import * as opening from './opening.service.js';

// ─── Checklist ──────────────────────────────────────────────────────────────
export const getChecklist = async (_req: Request, res: Response) => ok(res, await checklist.getChecklist());
export const dismissChecklist = async (req: Request, res: Response) => ok(res, await checklist.dismiss((req.body as { dismissed: boolean }).dismissed));
export const ratesReviewed = async (_req: Request, res: Response) => ok(res, await checklist.markRatesReviewed());

// ─── Imports ────────────────────────────────────────────────────────────────
export const importTemplate = (entity: ImportEntity) => async (_req: Request, res: Response) => {
  const file = await imports.template(entity);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(file.buffer);
};
export const importPreview = (entity: ImportEntity) => async (req: Request, res: Response) => ok(res, await imports.preview(entity, req.file));
export const importCommit = (entity: ImportEntity) => async (req: Request, res: Response) =>
  created(res, await imports.commit(entity, req.file, { skipInvalid: (req.query as { skipInvalid?: boolean }).skipInvalid === true }));

// ─── Opening balances ───────────────────────────────────────────────────────
export const listOpenings = async (req: Request, res: Response) => ok(res, await opening.listOpenings(req.query as { kind?: OpeningKind }));
export const createOpening = async (req: Request, res: Response) => created(res, await opening.createOpening(req.body as OpeningInput));

// ─── Demo ───────────────────────────────────────────────────────────────────
export const createDemo = async (_req: Request, res: Response) => created(res, await demo.createDemo());
export const deleteDemo = async (_req: Request, res: Response) => ok(res, await demo.deleteDemo());
