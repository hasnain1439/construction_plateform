/**
 * Report files. JSON is for screens; CSV / Excel / PDF are rendered here, stored as a REPORT
 * attachment and returned as a signed link ({ url, expiresAt }) — never the raw file.
 * Money is paisa in JSON and rupees in the files.
 */
import type ExcelJSModule from 'exceljs';
import type { Tx } from '../../core/db/withTenant.js';
import { renderPdf } from '../../core/pdf/renderer.js';
import { reportHtml, type Letterhead, type ReportColumnType } from '../../core/pdf/templates.js';
import { enumLabel, hasKey, tr, unitLabel, type Lang } from '../../core/i18n/index.js';
import { uuidv7 } from '../../core/utils/uuid.js';
import { signedUrlFor } from '../attachments/attachments.service.js';
import { storage } from '../attachments/storage.provider.js';
import { letterhead } from '../billing/documents.js';
import type { ReportFormat } from './reports.schema.js';

export type Cell = string | number | null;
export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}
export interface Report {
  name: string;
  title: string;
  /** Filters in words, e.g. "All projects · 1 Sep – 6 Oct 2026" */
  subtitle: string;
  generatedAt: string;
  filters: Record<string, string | null>;
  columns: ReportColumn[];
  rows: Array<Record<string, Cell>>;
  totals: Record<string, Cell> | null;
  notes?: string[];
  /** "Total" in the file language (set by localizeReport). */
  totalLabel?: string;
  /** Step 18: extra JSON for the screens (charts); never in the files. */
  extra?: Record<string, unknown>;
}

// ─── Language of the files ──────────────────────────────────────────────────

/**
 * Step 18: enum cells by column key → `<prefix>.<VALUE>` in the catalogue (statuses, types,
 * categories, reasons, buckets, stages).
 */
const CELL_ENUM: Record<string, string> = {
  coStatus: 'report.v.coStatus',
  coType: 'pdf.changeOrderType',
  proofType: 'pdf.proofType',
  snagStatus: 'report.v.snagStatus',
  milestoneStatus: 'report.v.milestoneStatus',
  stoppageStatus: 'report.v.stoppageStatus',
  delayCategory: 'report.v.delayCategory',
  reason: 'report.v.reason',
  bucket: 'report.v.bucket',
  varianceStatus: 'report.v.varianceStatus',
  category: 'report.v.category',
  assigneeKind: 'report.v.assigneeKind',
  stage: 'estimate.stage',
  progressBasis: 'report.v.progressBasis',
  projectionBasis: 'report.v.projectionBasis',
};

/** Columns whose label differs from the shared `report.col.<key>` one. */
const COLUMN_KEY: Record<string, string> = { 'receivables-ageing:project': 'report.col.code', 'material-audit:value': 'report.col.stockValue' };
/** Words the builders put in cells → enum labels. */
const CELL_KEY: Record<string, string> = {
  Worker: 'enum.PayeeKind.WORKER',
  'Sub-contractor': 'enum.PayeeKind.SUBCONTRACTOR',
  Store: 'enum.StockLocationType.STORE',
  Site: 'enum.StockLocationType.SITE',
  Transit: 'enum.StockLocationType.TRANSIT',
  'In transit': 'enum.StockLocationType.TRANSIT',
};

function columnLabel(lang: Lang, report: string, c: ReportColumn): string {
  const special = COLUMN_KEY[`${report}:${c.key}`];
  if (special && hasKey(special)) return tr(lang, special);
  const age = /^age_(.+)$/.exec(c.key);
  if (age) return tr(lang, 'report.col.ageDays', { range: age[1] });
  const bucket = /^cost_(.+)$/.exec(c.key);
  if (bucket) return enumLabel(lang, 'CostBucket', bucket[1]);
  const spent = /^spent_(.+)$/.exec(c.key);
  if (spent) return enumLabel(lang, 'ExpenseCategory', spent[1]);
  const key = `report.col.${c.key}`;
  return hasKey(key) ? tr(lang, key) : c.label;
}

function localCell(lang: Lang, key: string, v: Cell): Cell {
  if (typeof v !== 'string') return v;
  if (key === 'status') return enumLabel(lang, 'ProjectStatus', v);
  if (key === 'unit') return unitLabel(lang, v);
  const prefix = CELL_ENUM[key];
  if (prefix) {
    const k = `${prefix}.${v}`;
    return hasKey(k) ? tr(lang, k) : v;
  }
  const k = CELL_KEY[v];
  return (key === 'kind' || key === 'location') && k && hasKey(k) ? tr(lang, k) : v;
}

/**
 * The report for a file in `lang`: title, column headers, "Total" and enum cells (status, type,
 * unit) translated. Names, codes, numbers and the subtitle (filters / dates) stay as built.
 * JSON responses are never translated (the apps label them).
 */
export function localizeReport(r: Report, lang: Lang): Report {
  const titleKey = `report.title.${r.name}`;
  return {
    ...r,
    title: hasKey(titleKey) ? tr(lang, titleKey) : r.title,
    columns: r.columns.map((c) => ({ ...c, label: columnLabel(lang, r.name, c) })),
    rows: r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, localCell(lang, k, v)]))),
    totalLabel: tr(lang, 'common.total'),
  };
}

export const MIME: Record<Exclude<ReportFormat, 'json'>, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** Paisa → rupees as a plain number (files). */
const rupees = (v: Cell) => (v === null || v === '' ? null : Number(BigInt(v)) / 100);
const plain = (c: ReportColumn, v: Cell): string | number | null => (v === null || v === undefined ? null : c.type === 'money' ? rupees(v) : c.type === 'text' || c.type === 'date' ? String(v) : Number(v));
const label = (c: ReportColumn) => (c.type === 'money' ? `${c.label} (Rs)` : c.type === 'percent' ? `${c.label} (%)` : c.label);

export function toCsv(r: Report): Buffer {
  const esc = (v: string | number | null) => {
    if (v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [r.columns.map((c) => esc(label(c))).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => esc(plain(c, row[c.key] ?? null))).join(','));
  if (r.totals) lines.push(r.columns.map((c, i) => esc(i === 0 ? (r.totalLabel ?? 'Total') : plain(c, r.totals![c.key] ?? null))).join(','));
  // BOM so Excel opens UTF-8 (Urdu names, ·) correctly.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

export async function toXlsx(r: Report): Promise<Buffer> {
  // Loaded on first export only: exceljs is heavy (~0.2 s), and most API processes / test files never need it.
  const { default: ExcelJS } = (await import('exceljs')) as { default: typeof ExcelJSModule };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Construction Platform';
  wb.created = new Date(r.generatedAt);
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([r.subtitle]).font = { color: { argb: 'FF64748B' } };
  ws.addRow([]);
  const header = ws.addRow(r.columns.map(label));
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  for (const row of r.rows) ws.addRow(r.columns.map((c) => plain(c, row[c.key] ?? null)));
  if (r.totals) ws.addRow(r.columns.map((c, i) => (i === 0 ? (r.totalLabel ?? 'Total') : plain(c, r.totals![c.key] ?? null)))).font = { bold: true };
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(12, label(c).length + 2, ...r.rows.map((row) => String(row[c.key] ?? '').length + 2)));
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'qty') col.numFmt = '#,##0.###';
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function toPdf(company: Letterhead, r: Report, lang: Lang = 'en'): Promise<Buffer> {
  return renderPdf(reportHtml({ company, title: r.title, subtitle: r.subtitle, generatedOn: r.generatedAt.slice(0, 10), columns: r.columns, rows: r.rows, totals: r.totals }, lang), `${company.name} · ${r.title}`, lang);
}

/** Renders the file — outside any transaction (a PDF can take seconds). */
export async function renderReport(report: Report, format: Exclude<ReportFormat, 'json'>, company: Letterhead | null, lang: Lang = 'en'): Promise<Buffer> {
  const r = localizeReport(report, lang);
  if (format === 'csv') return toCsv(r);
  if (format === 'xlsx') return toXlsx(r);
  return toPdf(company!, r, lang);
}

export { letterhead };

/** Stores the file (attachment kind REPORT) and returns a signed link. */
export async function storeReport(tx: Tx, a: { tenantId: string; userId: string }, r: Pick<Report, 'name' | 'generatedAt'>, format: Exclude<ReportFormat, 'json'>, buffer: Buffer) {
  const id = uuidv7();
  const now = new Date();
  const fileName = `${r.name}-${r.generatedAt.slice(0, 10)}.${format}`;
  const key = await storage().put(`${a.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${format}`, buffer, MIME[format]);
  const att = await tx.attachment.create({ data: { id, tenantId: a.tenantId, kind: 'REPORT', storageKey: key, fileName, mimeType: MIME[format], sizeBytes: buffer.length, uploadedById: a.userId } });
  const signed = await signedUrlFor(att);
  return { attachmentId: id, fileName, format, mimeType: MIME[format], sizeBytes: buffer.length, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}
