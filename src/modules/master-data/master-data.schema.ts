import { z } from 'zod';
import { paginationQuery } from '../../core/http/pagination.js';
import { phoneSchema } from '../auth/auth.schema.js';
import { companyPhoneSchema, ntnSchema, paisaSchema } from '../company/company.schema.js';
import { SUBCONTRACT_KEYS } from './catalog.js';

const uuid = (label: string) => z.uuid({ error: `Invalid ${label}` });
const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const idParams = z.object({ id: uuid('id') });

export const supplyCategorySchema = z.enum(['GREY_STRUCTURE', 'FINISHING']);
export const altUnitsSchema = z
  .array(z.object({ unit: z.string().trim().min(1).max(20), factor: z.number().positive() }))
  .max(5)
  .meta({ example: [{ unit: 'kg', factor: 50 }], description: 'How many of `unit` make one base unit' });

// ─── Materials ──────────────────────────────────────────────────────────────

export const listMaterialsQuery = z.object({
  groupId: uuid('groupId').optional(),
  search: z.string().trim().min(1).max(100).optional(),
  supplyCategory: supplyCategorySchema.optional(),
  includeHidden: boolQuery.meta({ description: 'THEKEDAR / PM only (ignored for MUNSHI)' }),
});

export const createMaterialBody = z.object({
  groupId: uuid('groupId'),
  name: z.string().trim().min(2, 'Name is too short').max(80),
  unit: z.string().trim().min(1).max(20).meta({ example: 'bag' }),
  unitDetail: z.string().trim().max(80).optional().meta({ example: '1 bag = 40 kg' }),
  altUnits: altUnitsSchema.default([]),
  supplyCategory: supplyCategorySchema.optional().meta({ description: 'Defaults from the group section (CIVIL → GREY_STRUCTURE)' }),
});

export const updateMaterialBody = z
  .object({
    groupId: uuid('groupId').optional(),
    name: z.string().trim().min(2, 'Name is too short').max(80).optional(),
    unit: z.string().trim().min(1).max(20).optional().meta({ description: 'Locked for catalog materials and materials with rates' }),
    unitDetail: z.string().trim().max(80).nullable().optional(),
    altUnits: altUnitsSchema.optional(),
    supplyCategory: supplyCategorySchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

// ─── Quality categories ─────────────────────────────────────────────────────

const categoryCode = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,9}$/, 'code must be 2–10 uppercase letters, digits or _')
  .meta({ example: 'A_LUX' });

export const listCategoriesQuery = z.object({ includeArchived: boolQuery });

export const createCategoryBody = z.object({
  name: z.string().trim().min(1).max(60).meta({ example: 'A Luxury' }),
  code: categoryCode,
  description: z.string().trim().max(300).optional(),
  copyRatesFromCategoryId: uuid('copyRatesFromCategoryId').optional().meta({ description: 'Start with the current rates of this category' }),
});

export const duplicateCategoryBody = createCategoryBody.omit({ copyRatesFromCategoryId: true });

export const updateCategoryBody = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    isDefault: z.literal(true, { error: 'Make another category the default instead' }).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

// ─── Price list ─────────────────────────────────────────────────────────────

export const priceListQuery = z.object({
  categoryId: uuid('categoryId').optional().meta({ description: 'Defaults to the default category' }),
  groupId: uuid('groupId').optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

export const setPriceListBody = z.object({
  categoryId: uuid('categoryId'),
  rates: z
    .array(
      z.object({
        materialId: uuid('materialId'),
        ratePaisa: paisaSchema,
        specification: z.string().trim().max(200).nullable().optional().meta({ example: 'DG / Bestway, fresh stock' }),
      }),
    )
    .min(1, 'At least one rate')
    .max(500, 'At most 500 rates per request')
    .refine((rates) => new Set(rates.map((r) => r.materialId)).size === rates.length, 'Each material may appear only once'),
});

export const bulkPercentBody = z.object({
  categoryId: uuid('categoryId'),
  percent: z.number().min(-50, 'percent must be between -50 and 100').max(100, 'percent must be between -50 and 100').refine((p) => p !== 0, 'percent cannot be 0'),
  groupId: uuid('groupId').optional(),
  materialIds: z.array(uuid('materialId')).min(1).max(500).optional(),
});

export const priceHistoryQuery = z.object({
  materialId: uuid('materialId'),
  categoryId: uuid('categoryId').optional(),
});

export type ListMaterialsQuery = z.infer<typeof listMaterialsQuery>;
export type CreateMaterialInput = z.infer<typeof createMaterialBody>;
export type UpdateMaterialInput = z.infer<typeof updateMaterialBody>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuery>;
export type CreateCategoryInput = z.infer<typeof createCategoryBody>;
export type DuplicateCategoryInput = z.infer<typeof duplicateCategoryBody>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryBody>;
export type PriceListQuery = z.infer<typeof priceListQuery>;
export type SetPriceListInput = z.infer<typeof setPriceListBody>;
export type BulkPercentInput = z.infer<typeof bulkPercentBody>;
export type PriceHistoryQuery = z.infer<typeof priceHistoryQuery>;

// ─── Labour rates ───────────────────────────────────────────────────────────

export const laborRateKindSchema = z.enum(['DAILY', 'SUBCONTRACT']);
export const laborUnitSchema = z.enum(['DAY', 'SQFT', 'TON', 'BRICK', 'RFT', 'LUMPSUM']);

export const setLaborRatesBody = z.object({
  rates: z
    .array(
      z.object({
        kind: laborRateKindSchema,
        key: z.string().trim().toUpperCase().meta({ example: 'MISTRI' }),
        label: z.string().trim().min(1).max(60).optional(),
        unit: laborUnitSchema,
        ratePaisa: paisaSchema,
        overtimeMultiplier: z.number().min(1).max(3).nullable().optional().meta({ example: 1.5 }),
      }),
    )
    .min(1)
    .max(50)
    .refine((rates) => new Set(rates.map((r) => `${r.kind}:${r.key}`)).size === rates.length, 'Each kind + key may appear only once'),
});

// ─── Payment schedule templates ─────────────────────────────────────────────

export const billingModelSchema = z.enum(['STAGE_SCHEDULE', 'RUNNING_BILLS']);
const stagesSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(80),
      percent: z.number().positive('percent must be > 0').max(100),
      isRetention: z.boolean().optional(),
    }),
  )
  .min(1, 'At least one stage')
  .max(15, 'At most 15 stages')
  .meta({
    example: [
      { label: 'Advance', percent: 20 },
      { label: 'Grey structure', percent: 50 },
      { label: 'Finishing', percent: 25 },
      { label: 'Retention', percent: 5, isRetention: true },
    ],
  });

export const createTemplateBody = z.object({
  name: z.string().trim().min(2).max(80).meta({ example: 'Villa — 4 stages' }),
  billingModel: billingModelSchema.default('STAGE_SCHEDULE'),
  stages: stagesSchema,
  isDefault: z.boolean().default(false),
});

export const updateTemplateBody = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    billingModel: billingModelSchema.optional(),
    stages: stagesSchema.optional(),
    isDefault: z.literal(true, { error: 'Make another template the default instead' }).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export type SetLaborRatesInput = z.infer<typeof setLaborRatesBody>;
export type CreateTemplateInput = z.infer<typeof createTemplateBody>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateBody>;

// ─── Suppliers ──────────────────────────────────────────────────────────────

export const listSuppliersQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional().meta({ description: 'Name, phone or city contains' }),
  category: z.string().trim().min(1).max(40).optional(),
  isActive: boolQuery,
});

const supplierFields = {
  name: z.string().trim().min(2, 'Name is too short').max(80).meta({ example: 'Al-Madina Cement Agency' }),
  category: z.string().trim().min(2).max(40).meta({ example: 'Cement' }),
  phone: companyPhoneSchema.meta({ example: '042-35761234' }),
  city: z.string().trim().min(2).max(60).meta({ example: 'Lahore' }),
  address: z.string().trim().max(200),
  ntn: ntnSchema,
  notes: z.string().trim().max(500),
};

export const createSupplierBody = z.object({
  name: supplierFields.name,
  category: supplierFields.category,
  phone: supplierFields.phone.optional(),
  city: supplierFields.city.optional(),
  address: supplierFields.address.optional(),
  ntn: supplierFields.ntn.optional(),
  notes: supplierFields.notes.optional(),
});

export const updateSupplierBody = z
  .object({
    name: supplierFields.name.optional(),
    category: supplierFields.category.optional(),
    phone: supplierFields.phone.nullable().optional(),
    city: supplierFields.city.nullable().optional(),
    address: supplierFields.address.nullable().optional(),
    ntn: supplierFields.ntn.nullable().optional(),
    notes: supplierFields.notes.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export const setSupplierRatesBody = z.object({
  rates: z
    .array(z.object({ materialId: uuid('materialId'), ratePaisa: paisaSchema }))
    .min(1, 'At least one rate')
    .max(200, 'At most 200 rates per request')
    .refine((rates) => new Set(rates.map((r) => r.materialId)).size === rates.length, 'Each material may appear only once'),
});

export type ListSuppliersQuery = z.infer<typeof listSuppliersQuery>;
export type CreateSupplierInput = z.infer<typeof createSupplierBody>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierBody>;
export type SetSupplierRatesInput = z.infer<typeof setSupplierRatesBody>;

// ─── Workers ────────────────────────────────────────────────────────────────

export const workerTypeSchema = z.enum(['MISTRI', 'MISTRI_TILES', 'MAZDOOR', 'STEEL_FIXER_HELPER', 'CHOWKIDAR', 'OTHER']);

export const listWorkersQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional().meta({ description: 'Name or phone contains' }),
  type: workerTypeSchema.optional(),
  isActive: boolQuery,
});

export const createWorkerBody = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80).meta({ example: 'Ustad Akram' }),
  type: workerTypeSchema,
  phone: phoneSchema.optional(),
  dailyRatePaisa: paisaSchema.optional().meta({ description: "Defaults to the company's labour rate for this type", example: '280000' }),
  notes: z.string().trim().max(500).optional(),
});

export const updateWorkerBody = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80).optional(),
    type: workerTypeSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    dailyRatePaisa: paisaSchema.optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

// ─── Sub-contractors ────────────────────────────────────────────────────────

export const tradeSchema = z.enum(SUBCONTRACT_KEYS);

export const listSubcontractorsQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional(),
  trade: tradeSchema.optional(),
  isActive: boolQuery,
});

export const createSubcontractorBody = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80).meta({ example: 'Ustad Sharif Shuttering' }),
  trade: tradeSchema,
  phone: companyPhoneSchema.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const updateSubcontractorBody = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80).optional(),
    trade: tradeSchema.optional(),
    phone: companyPhoneSchema.nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

export type ListWorkersQuery = z.infer<typeof listWorkersQuery>;
export type CreateWorkerInput = z.infer<typeof createWorkerBody>;
export type UpdateWorkerInput = z.infer<typeof updateWorkerBody>;
export type ListSubcontractorsQuery = z.infer<typeof listSubcontractorsQuery>;
export type CreateSubcontractorInput = z.infer<typeof createSubcontractorBody>;
export type UpdateSubcontractorInput = z.infer<typeof updateSubcontractorBody>;
