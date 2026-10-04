import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { companyPhoneSchema, paisaSchema } from '../company/company.schema.js';
import { SUPPLY_CATEGORY_KEYS } from './presets.js';

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });
const feet = (max = 1000) => z.number().positive('Must be greater than 0').max(max);
const area = z.number().min(0).max(1_000_000);

export const idParams = z.object({ id: uuid('id') });

export const projectStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED', 'READ_ONLY']);
export const contractTypeSchema = z.enum(['FULL', 'GREY_OWNER_FINISHING', 'LABOR_ONLY']);
export const billingModelSchema = z.enum(['STAGE_SCHEDULE', 'RUNNING_BILLS']);
export const floorLevelSchema = z.enum(['BASEMENT', 'GROUND', 'FIRST', 'SECOND', 'THIRD', 'MUMTY']);
export const roomTypeSchema = z.enum([
  'MASTER_BEDROOM',
  'BEDROOM',
  'ATTACHED_BATH',
  'POWDER_ROOM',
  'KITCHEN',
  'TV_LOUNGE',
  'DRAWING_ROOM',
  'DINING',
  'STORE',
  'TERRACE',
  'STAIR',
  'GARAGE',
  'OTHER',
]);
export const openingTypeSchema = z.enum(['DOOR', 'WINDOW', 'VENTILATOR']);

// ─── List ───────────────────────────────────────────────────────────────────

export const listProjectsQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional().meta({ description: 'Name, code or client name contains' }),
  status: projectStatusSchema.optional(),
  contractType: contractTypeSchema.optional(),
  pmId: uuid('pmId').optional().meta({ description: 'Projects this PM is assigned to' }),
});

// ─── Tab 1 — basic ──────────────────────────────────────────────────────────

const projectCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/, 'Code: 2–30 letters, digits or dashes')
  .meta({ example: 'MSB-2026-016' });

export const newClientSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80),
  phone: companyPhoneSchema,
  email: z.email('Invalid email').trim().toLowerCase().max(120).optional(),
});

const basicFields = {
  name: z.string().trim().min(3, 'Name is too short').max(120).meta({ example: 'Gulberg · 10 Marla' }),
  code: projectCode,
  clientId: uuid('clientId'),
  newClient: newClientSchema,
  siteAddress: z.string().trim().min(3).max(300).meta({ example: 'House 12, Block B, Gulberg III' }),
  city: z.string().trim().min(2).max(60).meta({ example: 'Lahore' }),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
};

export const createProjectBody = z
  .object({
    name: basicFields.name,
    code: basicFields.code.optional().meta({ description: 'Auto (e.g. MSB-2026-016) when omitted' }),
    clientId: basicFields.clientId.optional(),
    newClient: basicFields.newClient.optional(),
    siteAddress: basicFields.siteAddress,
    city: basicFields.city,
    startDate: basicFields.startDate,
    endDate: basicFields.endDate,
    pmId: uuid('pmId').optional(),
    munshiId: uuid('munshiId').optional(),
  })
  .refine((v) => Boolean(v.clientId) !== Boolean(v.newClient), { message: 'Send either clientId or newClient', path: ['clientId'] })
  .refine((v) => v.endDate >= v.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] });

export const updateBasicBody = z
  .object({
    name: basicFields.name.optional(),
    code: basicFields.code.optional(),
    clientId: basicFields.clientId.optional(),
    newClient: basicFields.newClient.optional(),
    siteAddress: basicFields.siteAddress.optional(),
    city: basicFields.city.optional(),
    startDate: basicFields.startDate.optional(),
    endDate: basicFields.endDate.optional(),
  })
  .refine((v) => !(v.clientId && v.newClient), { message: 'Send either clientId or newClient', path: ['clientId'] })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const setTeamBody = z
  .object({
    pmId: uuid('pmId').nullable().optional().meta({ description: 'null removes the PM; omitted = unchanged' }),
    munshiIds: z
      .array(uuid('munshiId'))
      .max(20)
      .transform((ids) => [...new Set(ids)])
      .optional()
      .meta({ description: '[] removes every Munshi; omitted = unchanged' }),
  })
  .refine((v) => v.pmId !== undefined || v.munshiIds !== undefined, { message: 'Nothing to update' });

// ─── Tab 2 — contract ───────────────────────────────────────────────────────

const percent = z.number().positive('percent must be > 0').max(100);

export const stageInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  percent,
  isRetention: z.boolean().optional(),
});

export const supplyRuleInputSchema = z.object({
  categoryKey: z.enum(SUPPLY_CATEGORY_KEYS),
  suppliedBy: z.enum(['CONTRACTOR', 'OWNER']),
  qualityCategoryId: uuid('qualityCategoryId').nullable().optional(),
});

export const updateContractBody = z
  .object({
    contractType: contractTypeSchema,
    billingModel: billingModelSchema,
    contractValuePaisa: paisaSchema.optional().meta({ description: 'Required for FULL and GREY_OWNER_FINISHING', example: '1850000000' }),
    ratePerSqftPaisa: paisaSchema.optional().meta({ description: 'Required for LABOR_ONLY', example: '45000' }),
    retentionPercent: z.number().min(0).max(10).optional(),
    defectPeriodMonths: z.number().int().min(0).max(24).optional(),
    supplyRules: z
      .array(supplyRuleInputSchema)
      .max(20)
      .refine((rows) => new Set(rows.map((r) => r.categoryKey)).size === rows.length, 'Each category may appear only once')
      .optional()
      .meta({ description: 'Overrides on top of the contract-type preset' }),
    billingStages: z.array(stageInputSchema).min(1).max(15).optional(),
    templateId: uuid('templateId').optional().meta({ description: 'Copy the stages of a payment template' }),
  })
  .refine((v) => !(v.billingStages && v.templateId), { message: 'Send billingStages or templateId, not both', path: ['templateId'] });

// ─── Tab 3 — plot & structure ───────────────────────────────────────────────

export const updatePlotStructureBody = z
  .object({
    plotUnit: z.enum(['MARLA', 'KANAL', 'SQFT']),
    plotSize: z.number().positive().max(100_000),
    marlaStandard: z.union([z.literal(225), z.literal(272.25)]).optional(),
    frontFt: feet(),
    depthFt: feet(),
    cornerPlot: z.boolean().default(false),
    structureType: z.enum(['FRAMED', 'LOAD_BEARING']),
    hasBasement: z.boolean().default(false),
    basementHeightFt: feet(30).optional(),
    floors: z
      .array(z.object({ level: floorLevelSchema, ceilingHeightFt: feet(30) }))
      .min(1)
      .max(6)
      .refine((f) => new Set(f.map((x) => x.level)).size === f.length, 'Each level may appear only once')
      .refine((f) => f.some((x) => x.level === 'GROUND'), 'A GROUND floor is required'),
    force: z.boolean().default(false).meta({ description: 'Remove floors that still have rooms (their rooms are deleted)' }),
  })
  .refine((v) => !v.hasBasement || v.basementHeightFt !== undefined, { message: 'basementHeightFt is required with a basement', path: ['basementHeightFt'] })
  .refine((v) => v.hasBasement || !v.floors.some((f) => f.level === 'BASEMENT'), { message: 'BASEMENT floor needs hasBasement: true', path: ['floors'] });

// ─── Tab 4 — coverage ───────────────────────────────────────────────────────

export const updateCoverageBody = z
  .object({
    coveredAreaSqft: z.number().positive('coveredAreaSqft must be > 0').max(1_000_000),
    semiCoveredSqft: area.default(0),
    openAreaSqft: area.default(0),
    boundaryWall: z.boolean(),
    boundaryLengthFt: feet(10_000).optional(),
    boundaryHeightFt: feet(30).optional(),
    boundaryThickness: z.enum(['IN_4_5', 'IN_9']).optional(),
    boundaryPlasterSides: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .refine(
    (v) => !v.boundaryWall || (v.boundaryLengthFt !== undefined && v.boundaryHeightFt !== undefined && v.boundaryThickness !== undefined && v.boundaryPlasterSides !== undefined),
    { message: 'Boundary length, height, thickness and plaster sides are required with a boundary wall', path: ['boundaryWall'] },
  );

// ─── Tab 5 — rooms & openings ───────────────────────────────────────────────

export const openingInputSchema = z.object({
  type: openingTypeSchema,
  widthFt: feet(50),
  heightFt: feet(30),
  quantity: z.number().int().min(1).max(50).default(1),
});

export const createRoomBody = z.object({
  type: roomTypeSchema,
  name: z.string().trim().min(1).max(60).optional(),
  lengthFt: feet(200),
  widthFt: feet(200),
  heightFt: feet(30).optional().meta({ description: "Defaults to the floor's ceiling height" }),
  isWet: z.boolean().optional().meta({ description: 'Overrides the automatic wet flag (bath, powder room, kitchen)' }),
  openings: z.array(openingInputSchema).max(30).default([]),
});

export const updateRoomBody = z
  .object({
    type: roomTypeSchema.optional(),
    name: z.string().trim().min(1).max(60).optional(),
    lengthFt: feet(200).optional(),
    widthFt: feet(200).optional(),
    heightFt: feet(30).optional(),
    isWet: z.boolean().nullable().optional().meta({ description: 'true/false overrides; null goes back to automatic' }),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const updateOpeningBody = z
  .object({
    type: openingTypeSchema.optional(),
    widthFt: feet(50).optional(),
    heightFt: feet(30).optional(),
    quantity: z.number().int().min(1).max(50).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const copyFloorBody = z.object({
  targetFloorId: uuid('targetFloorId'),
  replace: z.boolean().default(false).meta({ description: 'Delete the rooms already on the target floor first' }),
});

// ─── Status ─────────────────────────────────────────────────────────────────

export const changeStatusBody = z.object({
  status: z.enum(['ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED']),
  note: z.string().trim().max(500).optional(),
});

export type ListProjectsQuery = z.infer<typeof listProjectsQuery>;
export type CreateProjectInput = z.infer<typeof createProjectBody>;
export type UpdateBasicInput = z.infer<typeof updateBasicBody>;
export type SetTeamInput = z.infer<typeof setTeamBody>;
export type UpdateContractInput = z.infer<typeof updateContractBody>;
export type UpdatePlotStructureInput = z.infer<typeof updatePlotStructureBody>;
export type UpdateCoverageInput = z.infer<typeof updateCoverageBody>;
export type CreateRoomInput = z.infer<typeof createRoomBody>;
export type UpdateRoomInput = z.infer<typeof updateRoomBody>;
export type OpeningInput = z.infer<typeof openingInputSchema>;
export type UpdateOpeningInput = z.infer<typeof updateOpeningBody>;
export type CopyFloorInput = z.infer<typeof copyFloorBody>;
export type ChangeStatusInput = z.infer<typeof changeStatusBody>;
