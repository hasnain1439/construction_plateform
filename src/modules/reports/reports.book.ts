/**
 * Step 18 · per-project report books: a summary block + several tables (sections). Same file
 * pipeline as the one-table reports (reports.export.ts): JSON for screens; CSV / Excel / PDF are
 * stored as a REPORT attachment and returned as a signed link. Money is paisa in JSON and rupees
 * in the files; files are in the reader's language (titles, headers, enum cells).
 */
import type ExcelJSModule from 'exceljs';
import { renderPdf } from '../../core/pdf/renderer.js';
import { auto, date, esc, isWideTable, label, REPORT_TABLE_CSS, reportCell, reportTable, rupeesWhole, shell, type Letterhead, type ReportColumnType } from '../../core/pdf/templates.js';
import { hasKey, tr, type Lang } from '../../core/i18n/index.js';
import { localizeReport, MIME, toCsv, type Cell, type Report, type ReportColumn } from './reports.export.js';
import type { ReportFormat } from './reports.schema.js';

export interface SummaryItem {
  key: string;
  label: string;
  type: ReportColumnType;
  value: Cell;
}

export interface ReportSection {
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, Cell>>;
  totals: Record<string, Cell> | null;
  notes?: string[];
}

export interface ReportBook {
  name: string;
  title: string;
  subtitle: string;
  generatedAt: string;
  filters: Record<string, string | null>;
  project: { id: string; code: string; name: string; status: string };
  summary: SummaryItem[];
  sections: ReportSection[];
  notes?: string[];
  totalLabel?: string;
  /** JSON only (screens): structured values behind text cells, e.g. delay reasons. */
  extra?: Record<string, unknown>;
}

/** A section as a one-table Report (so the Phase 1 localizer / CSV writer can be reused). */
const asReport = (b: ReportBook, s: ReportSection): Report => ({ name: b.name, title: s.title, subtitle: b.subtitle, generatedAt: b.generatedAt, filters: b.filters, columns: s.columns, rows: s.rows, totals: s.totals });

/** Title, section titles, headers, summary labels and enum cells in `lang`. */
export function localizeBook(b: ReportBook, lang: Lang): ReportBook {
  const titleKey = `report.title.${b.name}`;
  const summary = localizeReport({ ...asReport(b, { key: 'summary', title: '', columns: b.summary.map((s) => ({ key: s.key, label: s.label, type: s.type })), rows: [Object.fromEntries(b.summary.map((s) => [s.key, s.value]))], totals: null }) }, lang);
  return {
    ...b,
    title: hasKey(titleKey) ? tr(lang, titleKey) : b.title,
    summary: b.summary.map((s, i) => ({ ...s, label: summary.columns[i]!.label, value: summary.rows[0]![s.key] ?? null })),
    sections: b.sections.map((s) => {
      const r = localizeReport(asReport(b, s), lang);
      const key = `report.section.${s.key}`;
      return { ...s, title: hasKey(key) ? tr(lang, key) : s.title, columns: r.columns, rows: r.rows };
    }),
    totalLabel: tr(lang, 'common.total'),
  };
}

/** QA-B-13: whole rupees in the files. */
const rupees = (v: Cell) => (v === null || v === '' ? null : rupeesWhole(v));
const plain = (type: ReportColumnType, v: Cell): string | number | null => (v === null || v === undefined ? null : type === 'money' ? rupees(v) : type === 'text' || type === 'date' ? String(v) : Number(v));
const headerOf = (c: { label: string; type: ReportColumnType }) => (c.type === 'money' ? `${c.label} (Rs)` : c.type === 'percent' ? `${c.label} (%)` : c.label);

export function bookCsv(b: ReportBook): Buffer {
  const esc2 = (v: string | number | null) => {
    if (v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const parts = [[esc2(b.title), esc2(b.subtitle)].join(','), ...b.summary.map((s) => [esc2(headerOf(s)), esc2(plain(s.type, s.value))].join(','))];
  for (const s of b.sections) {
    const table = toCsv({ ...asReport(b, s), totalLabel: b.totalLabel }).toString('utf8').replace(/^﻿/, '').trimEnd();
    parts.push('', esc2(s.title), table);
  }
  return Buffer.from(`﻿${parts.join('\r\n')}\r\n`, 'utf8');
}

export async function bookXlsx(b: ReportBook): Promise<Buffer> {
  const { default: ExcelJS } = (await import('exceljs')) as { default: typeof ExcelJSModule };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Construction Platform';
  wb.created = new Date(b.generatedAt);
  const used = new Set<string>();
  const sheetName = (title: string) => {
    let n = title.replace(/[*?:\\/[\]]/g, ' ').slice(0, 31) || 'Sheet';
    for (let i = 2; used.has(n); i++) n = `${n.slice(0, 28)} ${i}`;
    used.add(n);
    return n;
  };
  const summary = wb.addWorksheet(sheetName(b.title));
  summary.addRow([b.title]).font = { bold: true, size: 14 };
  summary.addRow([b.subtitle]).font = { color: { argb: 'FF64748B' } };
  summary.addRow([]);
  for (const s of b.summary) summary.addRow([headerOf(s), plain(s.type, s.value)]);
  summary.getColumn(1).width = 36;
  summary.getColumn(2).width = 22;
  for (const s of b.sections) {
    const ws = wb.addWorksheet(sheetName(s.title));
    ws.addRow([s.title]).font = { bold: true, size: 13 };
    ws.addRow([]);
    const header = ws.addRow(s.columns.map(headerOf));
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    for (const row of s.rows) ws.addRow(s.columns.map((c) => plain(c.type, row[c.key] ?? null)));
    if (s.totals) ws.addRow(s.columns.map((c, i) => (i === 0 ? (b.totalLabel ?? 'Total') : plain(c.type, s.totals![c.key] ?? null)))).font = { bold: true };
    s.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(40, Math.max(12, headerOf(c).length + 2, ...s.rows.map((row) => String(row[c.key] ?? '').length + 2)));
      if (c.type === 'money') col.numFmt = '#,##0';
      if (c.type === 'qty') col.numFmt = '#,##0.###';
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** QA-B-03: a book prints landscape when any of its tables is wide (more than 8 columns). */
export const bookIsWide = (b: Pick<ReportBook, 'sections'>) => b.sections.some((s) => isWideTable(s.columns.length));

/**
 * Letterhead + summary block + one table per section (the Phase 1 report look). Wide sections are
 * split into parts that repeat the leading text columns (templates.ts reportTable), money is in whole
 * rupees and the totals row shows only where it has numbers (QA-B-03, QA-B-13).
 */
export function bookHtml(company: Letterhead, b: ReportBook, lang: Lang): string {
  const summary = b.summary.length
    ? `<table class="report summary"><tbody>${b.summary.map((s) => `<tr><td>${esc(s.label)}</td><td class="r"><strong>${reportCell(s.type, s.value)}</strong></td></tr>`).join('')}</tbody></table>`
    : '';
  const sections = b.sections.map((s) => `<h3>${esc(s.title)}</h3>${reportTable(lang, s.columns, s.rows, s.totals, b.totalLabel ?? tr(lang, 'common.total'))}`).join('');
  const html = `
  <style>${REPORT_TABLE_CSS}
  table.summary { width: 60%; } h3 { font-size: 12px; margin: 18px 0 2px; color: #1d4ed8; }</style>
  <div class="muted" style="margin-bottom:8px">${auto(esc(b.subtitle))}</div>${summary}${sections}`;
  return shell(company, lang === 'ur' ? b.title : b.title.toUpperCase(), label(lang, 'pdf.generated', {}, { date: date(b.generatedAt.slice(0, 10)) }), html, lang);
}

/** Renders the book file in `lang` — outside any transaction. */
export async function renderBook(book: ReportBook, format: Exclude<ReportFormat, 'json'>, company: Letterhead | null, lang: Lang = 'en'): Promise<Buffer> {
  const b = localizeBook(book, lang);
  if (format === 'csv') return bookCsv(b);
  if (format === 'xlsx') return bookXlsx(b);
  return renderPdf(bookHtml(company!, b, lang), `${company!.name} · ${b.title}`, lang, { landscape: bookIsWide(b) });
}

export { MIME };
