/**
 * Report files. JSON is for screens; CSV / Excel / PDF are rendered here, stored as a REPORT
 * attachment and returned as a signed link ({ url, expiresAt }) — never the raw file.
 * Money is paisa in JSON and rupees in the files.
 */
import ExcelJS from 'exceljs';
import type { Tx } from '../../core/db/withTenant.js';
import { renderPdf } from '../../core/pdf/renderer.js';
import { reportHtml, type Letterhead, type ReportColumnType } from '../../core/pdf/templates.js';
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
  if (r.totals) lines.push(r.columns.map((c, i) => esc(i === 0 ? 'Total' : plain(c, r.totals![c.key] ?? null))).join(','));
  // BOM so Excel opens UTF-8 (Urdu names, ·) correctly.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

export async function toXlsx(r: Report): Promise<Buffer> {
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
  if (r.totals) ws.addRow(r.columns.map((c, i) => (i === 0 ? 'Total' : plain(c, r.totals![c.key] ?? null)))).font = { bold: true };
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(12, label(c).length + 2, ...r.rows.map((row) => String(row[c.key] ?? '').length + 2)));
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'qty') col.numFmt = '#,##0.###';
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function toPdf(company: Letterhead, r: Report): Promise<Buffer> {
  return renderPdf(reportHtml({ company, title: r.title, subtitle: r.subtitle, generatedOn: r.generatedAt.slice(0, 10), columns: r.columns, rows: r.rows, totals: r.totals }), `${company.name} · ${r.title}`);
}

/** Renders the file — outside any transaction (a PDF can take seconds). */
export async function renderReport(r: Report, format: Exclude<ReportFormat, 'json'>, company: Letterhead | null): Promise<Buffer> {
  if (format === 'csv') return toCsv(r);
  if (format === 'xlsx') return toXlsx(r);
  return toPdf(company!, r);
}

export { letterhead };

/** Stores the file (attachment kind REPORT) and returns a signed link. */
export async function storeReport(tx: Tx, a: { tenantId: string; userId: string }, r: Report, format: Exclude<ReportFormat, 'json'>, buffer: Buffer) {
  const id = uuidv7();
  const now = new Date();
  const fileName = `${r.name}-${r.generatedAt.slice(0, 10)}.${format}`;
  const key = await storage().put(`${a.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${format}`, buffer, MIME[format]);
  const att = await tx.attachment.create({ data: { id, tenantId: a.tenantId, kind: 'REPORT', storageKey: key, fileName, mimeType: MIME[format], sizeBytes: buffer.length, uploadedById: a.userId } });
  const signed = await signedUrlFor(att);
  return { attachmentId: id, fileName, format, mimeType: MIME[format], sizeBytes: buffer.length, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}
