import { z } from 'zod';
import { langSchema } from '../../core/i18n/lang.js';
import { isoDateSchema } from '../../core/utils/dates.js';
import { uuid } from '../inventory/inventory.schema.js';

/** Phase 1 reports (finance.reports.view only). */
export const PHASE1_REPORT_NAMES = ['project-summary', 'material-audit', 'labor-peshgi', 'cash-book', 'supplier-ageing', 'receivables-ageing', 'stock-valuation'] as const;
/** Step 18 reports: finance.reports.view + the source module's view key (STEP18_REPORT_PERM). */
export const STEP18_REPORT_NAMES = ['delay-analysis', 'variance', 'change-orders', 'equipment-utilisation', 'snags'] as const;
export const REPORT_NAMES = [...PHASE1_REPORT_NAMES, ...STEP18_REPORT_NAMES] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
export type Step18ReportName = (typeof STEP18_REPORT_NAMES)[number];
/** Per-project report books (GET /reports/<name>/:projectId). */
export const BOOK_NAMES = ['delay-analysis', 'variance', 'snags'] as const;
export type BookName = (typeof BOOK_NAMES)[number];

/** The module key each Step 18 report needs besides finance.reports.view (its scope picks the projects). */
export const STEP18_REPORT_PERM: Record<Step18ReportName, string> = {
  'delay-analysis': 'control.view',
  variance: 'control.view',
  'change-orders': 'changeorder.view',
  'equipment-utilisation': 'equipment.view',
  snags: 'closeout.snag.view',
};

export const REPORT_FORMATS = ['json', 'csv', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

const CO_STATUSES = ['DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'BILLED'] as const;
const EQUIPMENT_CATEGORIES = ['SHUTTERING_PLATE', 'PROP', 'SCAFFOLDING', 'MIXER', 'VIBRATOR', 'GENERATOR', 'PUMP', 'TOOL', 'OTHER'] as const;
/** Longest period the equipment utilisation report replays (days). */
export const MAX_PERIOD_DAYS = 366;

const base = {
  format: z.enum(REPORT_FORMATS).default('json').meta({ description: 'json for the screen; csv / xlsx / pdf return a signed download link' }),
  projectId: uuid('projectId').optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  lang: langSchema.optional().meta({ description: 'Language of csv / xlsx / pdf titles, headers and labels (default: your language). JSON is not translated.' }),
  status: z.enum(CO_STATUSES).optional().meta({ description: 'change-orders only: one change-order status' }),
  type: z.enum(['ADDITION', 'DEDUCTION']).optional().meta({ description: 'change-orders only: ADDITION or DEDUCTION' }),
  category: z.enum(EQUIPMENT_CATEGORIES).optional().meta({ description: 'equipment-utilisation only: one equipment category' }),
  group: z.enum(['item', 'category']).optional().meta({ description: 'equipment-utilisation only: one row per item (default) or per category' }),
};

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
const fromBeforeTo = { message: '`from` must be on or before `to`', path: ['from'] };
const datesOk = (v: { from?: string | undefined; to?: string | undefined }) => !v.from || !v.to || v.from <= v.to;

/** Phase 1 reports. */
export const reportQuery = z.object({ format: base.format, projectId: base.projectId, from: base.from, to: base.to, lang: base.lang }).refine(datesOk, fromBeforeTo);

/** Step 18 reports: + change-order / equipment filters; a period of at most MAX_PERIOD_DAYS. */
export const step18Query = z
  .object(base)
  .refine(datesOk, fromBeforeTo)
  .refine((v) => !v.from || !v.to || days(v.from, v.to) <= MAX_PERIOD_DAYS, { message: `The period can be at most ${MAX_PERIOD_DAYS} days`, path: ['from'] });

/** Phase 1 builders simply ignore the Step 18 filters. */
export type ReportQuery = z.infer<typeof step18Query>;

export const bookParams = z.object({ projectId: uuid('projectId') });
export const bookQuery = z
  .object({ format: base.format, lang: base.lang, from: isoDateSchema.optional().meta({ description: 'snags only: snags created on / after' }), to: isoDateSchema.optional().meta({ description: 'snags only: snags created on / before' }) })
  .refine(datesOk, fromBeforeTo);
export type BookQuery = z.infer<typeof bookQuery>;
