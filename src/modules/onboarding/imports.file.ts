/**
 * Import files: reading an uploaded .xlsx / .csv into header + rows, and building the .xlsx
 * template. exceljs is loaded lazily (only when a spreadsheet is read or written), like the
 * report export.
 */
import type ExcelJSModule from 'exceljs';
import { BadRequest } from '../../core/errors/AppError.js';
import type { EntityDef, Lookups } from './imports.entities.js';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;

export interface SheetRow {
  /** Row number as the user sees it in Excel (header = 1 usually). */
  rowNumber: number;
  cells: string[];
}
export interface Sheet {
  headers: string[];
  rows: SheetRow[];
}

async function excel(): Promise<typeof ExcelJSModule> {
  const { default: ExcelJS } = (await import('exceljs')) as { default: typeof ExcelJSModule };
  return ExcelJS;
}

const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('fullwide', { useGrouping: false }) : String(value);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { richText?: Array<{ text: string }>; result?: unknown; text?: unknown; error?: string };
    if (v.richText) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    if (v.error) return '';
  }
  return String(value).trim();
}

/** RFC 4180 CSV (quotes, "" escapes, CRLF / LF); delimiter , ; or tab picked from the header line. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

function toSheet(grid: Array<{ rowNumber: number; cells: string[] }>): Sheet {
  const nonEmpty = grid.filter((r) => r.cells.some((c) => c !== ''));
  const header = nonEmpty[0];
  if (!header) throw new BadRequest('EMPTY_FILE', 'The file has no header row');
  const rows = nonEmpty.slice(1);
  if (rows.length > MAX_IMPORT_ROWS) throw new BadRequest('TOO_MANY_ROWS', `At most ${MAX_IMPORT_ROWS} rows per file — split it into smaller files`, { max: MAX_IMPORT_ROWS, rows: rows.length });
  return { headers: header.cells, rows };
}

/** Reads an uploaded .xlsx (first sheet, or the one called "Data") or .csv (UTF-8). */
export async function readSheet(file: { buffer: Buffer; originalname: string }): Promise<Sheet> {
  const name = file.originalname.toLowerCase();
  if (isZip(file.buffer)) {
    const ExcelJS = await excel();
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequest('INVALID_FILE', 'This Excel file could not be read — save it as .xlsx and try again');
    }
    const ws = wb.getWorksheet('Data') ?? wb.worksheets.find((w) => !/instruction|hidayat/i.test(w.name)) ?? wb.worksheets[0];
    if (!ws) throw new BadRequest('EMPTY_FILE', 'The workbook has no sheets');
    const grid: SheetRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values as unknown[];
      const cells: string[] = [];
      for (let i = 1; i < values.length; i++) cells.push(cellText(values[i]));
      grid.push({ rowNumber, cells });
    });
    return toSheet(grid);
  }
  if (name.endsWith('.csv') || name.endsWith('.txt') || !name.includes('.')) {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    if (text.includes('\u0000')) throw new BadRequest('INVALID_FILE_TYPE', 'Upload an Excel (.xlsx) or CSV file');
    return toSheet(parseCsv(text).map((cells, i) => ({ rowNumber: i + 1, cells })));
  }
  throw new BadRequest('INVALID_FILE_TYPE', 'Upload an Excel (.xlsx) or CSV file');
}

/** "Daily rate (Rs)" / "dihari" / "دیہاڑی" → comparable key. */
export const headerKey = (h: string) =>
  h
    .split('(')[0]!
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/** Template: a "Data" sheet (headers + one example row) and an "Instructions" sheet. */
export async function buildTemplate(def: EntityDef, lookups: Lookups): Promise<Buffer> {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Construction Platform';
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = def.columns.map((c) => ({ header: `${c.label.en} (${c.label.roman})${c.required ? ' *' : ''}`, key: c.key, width: Math.max(18, c.label.en.length + c.label.roman.length + 8) }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  def.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.note = `${c.note.en}\n${c.note.roman}\n${c.note.urdu}${c.required ? '\n* Required / Zaroori / ضروری' : ''}`;
    if (c.text) ws.getColumn(i + 1).numFmt = '@';
  });
  const example = ws.addRow(def.columns.map((c) => (c.key === 'name' ? `${c.example} (example — delete this row)` : c.example)));
  example.font = { italic: true, color: { argb: 'FF6B7280' } };

  const info = wb.addWorksheet('Instructions');
  info.columns = [
    { header: 'Column', width: 26 },
    { header: 'Required', width: 10 },
    { header: 'English', width: 50 },
    { header: 'Roman Urdu', width: 50 },
    { header: 'اردو', width: 50 },
    { header: 'Allowed values', width: 60 },
  ];
  info.getRow(1).font = { bold: true };
  info.addRow([`${def.label.en} import`, '', 'Fill one row per record on the "Data" sheet. Delete the example row. Up to 1000 rows; keep the header row as it is.', 'Data sheet par har record ki ek line. Misaal wali line mita dein. Zyada se zyada 1000 lines; pehli (header) line na badlein.', 'ڈیٹا شیٹ پر ہر ریکارڈ کی ایک لائن۔ مثال والی لائن مٹا دیں۔ زیادہ سے زیادہ 1000 لائنیں؛ پہلی لائن نہ بدلیں۔', '']);
  for (const c of def.columns) {
    const allowed = (lookups.choices[c.key] ?? []).map((ch) => (ch.labels.length ? `${ch.value} (${ch.labels.join(' / ')})` : ch.value)).join('\n');
    const r = info.addRow([`${c.label.en} (${c.label.roman} / ${c.label.urdu})`, c.required ? 'Yes / Haan' : 'No / Nahi', c.note.en, c.note.roman, c.note.urdu, allowed]);
    r.alignment = { wrapText: true, vertical: 'top' };
  }
  info.getColumn(5).alignment = { horizontal: 'right', readingOrder: 'rtl', wrapText: true, vertical: 'top' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
