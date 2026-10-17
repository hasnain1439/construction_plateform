/**
 * Plain HTML templates for billing PDFs and report files (no framework). Every value is escaped;
 * money is shown South-Asian style ("Rs 27,75,000"). Labels come from the i18n catalogue in the
 * document's language (`lang`, default English): Urdu documents are `dir="rtl"` with the embedded
 * Nastaliq font (fonts.ts); numbers, codes and money stay left-to-right inside <bdi>.
 *
 * Step 18 · one letterhead for every PDF: `shell()` is the only document frame (logo, company
 * name, address, phone, NTN — and STRN on tax documents — then document title, number and date on
 * the other side). Page size, margins and the footer ("Page X of Y", generated-on date) come from
 * the renderer (renderer.ts `pdfPageOptions` + `pdfFooter` below), so every producer looks the same.
 */
import { CATALOGS, enumLabel, isRtl, tr, unitLabel, type Lang, type MessageKey, type Params } from '../i18n/index.js';
import { URDU_FONT_FAMILY, urduFontFace } from './fonts.js';

export interface Letterhead {
  name: string;
  ntn: string | null;
  address: string | null;
  phone: string | null;
  logoUrl: string | null;
  /** Sales tax registration (STRN); set only for tax reports (taxed invoices print their issue-time snapshot). */
  strn?: string | null;
}

export const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 277500000 → "Rs 27,75,000" (paisa shown only when not whole). */
export function rs(paisa: bigint | string | number): string {
  const p = BigInt(paisa);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = (abs / 100n).toString();
  const frac = abs % 100n;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${neg ? '−' : ''}Rs ${grouped}${frac ? `.${frac.toString().padStart(2, '0')}` : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-03" → "3 Sep" (no ICU differences such as "Sept"). */
export function dayMonth(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

/** "2026-09-03" → "3 Sep 2026" */
export function day(date: string | null | undefined): string {
  return date ? `${dayMonth(date)} ${date.slice(0, 4)}` : '—';
}

/** Left-to-right island (money, dates, numbers, codes) — keeps its order inside Urdu text. */
export const ltr = (html: string) => `<bdi dir="ltr">${html}</bdi>`;
/**
 * QA-B-11 · free text (names, descriptions, notes) that may be Latin inside an Urdu document: its own
 * direction from its first letter, so "Owner wants…." keeps the full stop at its end.
 */
export const auto = (html: string) => (html ? `<bdi dir="auto">${html}</bdi>` : '');
/**
 * QA-B-11 · quantity + unit as one island: a Latin unit reads "1 job" / "-155.687 cft" (LTR), an Urdu
 * unit keeps the Urdu order (direction from the unit's first letter; the number itself stays LTR).
 */
export const qtyUnit = (qtyHtml: string, unit: string) => (unit ? `<bdi dir="auto">${ltr(qtyHtml)} ${esc(unit)}</bdi>` : ltr(qtyHtml));

/**
 * QA-B-13 · report money in files: whole rupees (half away from zero), one sign style "−Rs 43,250".
 * Invoices / receipts keep their paisa (rs).
 */
export function rsWhole(paisa: bigint | string | number): string {
  return rs(BigInt(rupeesWhole(paisa)) * 100n);
}
/** Paisa → whole rupees as a number (CSV / Excel cells). */
export const rupeesWhole = (paisa: bigint | string | number): number => {
  const p = BigInt(paisa);
  const r = ((p < 0n ? -p : p) + 50n) / 100n;
  return Number(p < 0n ? -r : r);
};
const money = (paisa: bigint | string | number) => ltr(rs(paisa));
export const date = (d: string | null | undefined) => ltr(day(d));

/** Escaped label in the document language (params are escaped too; pre-built HTML goes in `html`). */
export function label(lang: Lang, key: MessageKey, params: Params = {}, html: Record<string, string> = {}): string {
  return esc(CATALOGS[lang][key]).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    html[name] !== undefined ? html[name] : params[name] !== undefined && params[name] !== null ? esc(params[name]) : whole,
  );
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { font-family: Inter, Arial, sans-serif; color: #0f172a; font-size: 11px; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1d4ed8; padding-bottom: 12px; margin-bottom: 18px; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .brand img { height: 46px; width: auto; }
  .brand h1 { font-size: 18px; margin: 0; }
  .muted { color: #64748b; }
  .doc { text-align: end; }
  .doc h2 { margin: 0; font-size: 20px; color: #1d4ed8; letter-spacing: .5px; }
  .grid { display: flex; gap: 24px; margin-bottom: 16px; }
  .grid > div { flex: 1; }
  .label { font-size: 9px; text-transform: uppercase; letter-spacing: .6px; color: #64748b; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: start; font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: #475569; background: #f1f5f9; padding: 7px 8px; }
  td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .r { text-align: end; white-space: nowrap; }
  .totals { margin-inline-start: auto; width: 46%; margin-top: 10px; }
  .totals td { border: none; padding: 4px 8px; }
  .totals .grand td { font-size: 13px; font-weight: 700; border-top: 2px solid #0f172a; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 9px; font-weight: 600; }
  .ok { background: #dcfce7; color: #166534; } .warn { background: #fef3c7; color: #92400e; } .bad { background: #fee2e2; color: #991b1b; }
  .note { margin-top: 18px; padding: 10px; background: #f8fafc; border-radius: 6px; }
  h3 { font-size: 12px; margin: 16px 0 4px; }
  thead { display: table-header-group; } tr { page-break-inside: avoid; }
  table.totals { page-break-inside: avoid; break-inside: avoid; }
  bdi[dir="auto"] { unicode-bidi: isolate; }
`;

/** Urdu: Nastaliq (embedded) with room for its tall letters; no letter-spacing / upper-casing. */
const URDU_CSS = () => `
  ${urduFontFace()}
  body { font-family: Inter, ${URDU_FONT_FAMILY}; line-height: 1.9; }
  .label, th, .doc h2 { letter-spacing: 0; text-transform: none; }
  th { font-size: 10px; } .label { font-size: 10px; }
  bdi { font-family: Inter, Arial, sans-serif; }
`;

/** `<html lang dir>` + styles for the language. */
function documentHead(lang: Lang): string {
  const rtl = isRtl(lang);
  return `<!doctype html><html lang="${lang === 'ur' ? 'ur' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${CSS}${rtl ? URDU_CSS() : ''}</style></head>`;
}

/** "+923001239901" → "+92 300 1239901" (a Pakistani mobile in E.164); anything else as stored. */
export function displayPhone(phone: string): string {
  const digits = phone.replace(/[\s-]/g, '');
  const mobile = /^\+92(3\d{2})(\d{7})$/.exec(digits);
  if (mobile) return `+92 ${mobile[1]} ${mobile[2]}`;
  // landline: "+924235761234" → "+92 42 35761234"
  const land = /^\+92([1-9]\d)(\d{7,8})$/.exec(digits);
  return land ? `+92 ${land[1]} ${land[2]}` : phone;
}

/** Company line under the name: address · phone · NTN (· STRN when the letterhead carries it). */
function companyLine(company: Letterhead, lang: Lang): string {
  return [
    company.address ? ltr(esc(company.address)) : null,
    company.phone ? ltr(esc(displayPhone(company.phone))) : null,
    company.ntn ? `${label(lang, 'pdf.ntn')} ${ltr(esc(company.ntn))}` : null,
    company.strn ? `${label(lang, 'pdf.strn')} ${ltr(esc(company.strn))}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The one document frame for every PDF: `<html lang dir>` + styles (Urdu font embedded for `ur`),
 * the letterhead block (logo, company, address, phone, NTN/STRN | document title, number, date)
 * and the body. Page numbers and the generated-on date are in the renderer's footer.
 */
export function shell(company: Letterhead, docTitle: string, docMeta: string, body: string, lang: Lang): string {
  return `${documentHead(lang)}<body>
  <div class="head letterhead" data-pdf="letterhead">
    <div class="brand">
      ${company.logoUrl ? `<img src="${esc(company.logoUrl)}" alt="">` : ''}
      <div>
        <h1>${esc(company.name)}</h1>
        <div class="muted">${companyLine(company, lang)}</div>
      </div>
    </div>
    <div class="doc"><h2>${esc(docTitle)}</h2><div class="muted">${docMeta}</div></div>
  </div>
  ${body}
  </body></html>`;
}

/**
 * Footer for the renderer (Playwright footerTemplate), in the language: footer text, generated-on
 * date and "Page X of Y" (Chromium fills .pageNumber / .totalPages). The footer is drawn in its own
 * small document, so it names the Urdu family the page itself has already loaded.
 */
export function pdfFooter(text: string, lang: Lang, generatedOn: string = new Date().toISOString().slice(0, 10)): string {
  const rtl = isRtl(lang);
  return `
  <div dir="${rtl ? 'rtl' : 'ltr'}" data-pdf="footer" style="width:100%;font-family:Inter,${rtl ? URDU_FONT_FAMILY : 'Arial,sans-serif'};font-size:8px;color:#64748b;padding:0 14mm;display:flex;justify-content:space-between;gap:12px">
    <span>${esc(text)}</span>
    <span>${label(lang, 'pdf.generated', {}, { date: date(generatedOn) })}</span>
    <span>${esc(tr(lang, 'pdf.page'))} <bdi dir="ltr"><span class="pageNumber"></span></bdi> ${esc(tr(lang, 'pdf.of'))} <bdi dir="ltr"><span class="totalPages"></span></bdi></span>
  </div>`;
}

export interface InvoicePdfData {
  company: Letterhead;
  number: string;
  issueDate: string;
  dueDate: string | null;
  client: { name: string; phone: string | null; address: string | null } | null;
  project: { name: string; code: string; siteAddress: string | null };
  lines: Array<{ description: string; quantity: string | null; unit: string | null; ratePaisa: bigint | null; amountPaisa: bigint }>;
  subtotalPaisa: bigint;
  taxPaisa: bigint;
  taxLabel: string | null;
  taxRatePercent: string | null;
  /** Step 18: base the tax was worked out on (shown when it differs from the subtotal). */
  taxableBasePaisa?: bigint;
  /** Step 18: NTN / STRN printed when the invoice carries tax. */
  taxRegistration?: { sellerNtn: string | null; sellerStrn: string | null; buyerNtn: string | null };
  totalPaisa: bigint;
  paidPaisa: bigint;
  balancePaisa: bigint;
  notes: string | null;
}

export function invoiceHtml(d: InvoicePdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const rows = d.lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${auto(esc(l.description))}</td><td class="r">${l.quantity ? qtyUnit(esc(l.quantity), unitLabel(lang, l.unit)) : ''}</td>
      <td class="r">${l.ratePaisa !== null ? money(l.ratePaisa) : ''}</td><td class="r">${money(l.amountPaisa)}</td></tr>`,
    )
    .join('');
  const body = `
  <div class="grid">
    <div><div class="label">${L('pdf.billTo')}</div><strong>${esc(d.client?.name ?? '—')}</strong><div class="muted">${[d.client?.phone ? ltr(esc(displayPhone(d.client.phone))) : null, d.client?.address ? esc(d.client.address) : null, d.taxRegistration?.buyerNtn ? `${L('pdf.ntn')} ${ltr(esc(d.taxRegistration.buyerNtn))}` : null].filter(Boolean).join('<br>')}</div></div>
    <div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}${d.project.siteAddress ? `<br>${esc(d.project.siteAddress)}` : ''}</div></div>
    <div><div class="label">${L('pdf.due')}</div><strong>${date(d.dueDate)}</strong></div>
  </div>
  <table><thead><tr><th>#</th><th>${L('pdf.description')}</th><th class="r">${L('pdf.qty')}</th><th class="r">${L('pdf.rate')}</th><th class="r">${L('pdf.amount')}</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="totals">
    <tr><td>${L('pdf.subtotal')}</td><td class="r">${money(d.subtotalPaisa)}</td></tr>
    ${d.taxPaisa > 0n && d.taxableBasePaisa !== undefined && d.taxableBasePaisa !== d.subtotalPaisa ? `<tr><td>${L('pdf.taxableValue')}</td><td class="r">${money(d.taxableBasePaisa)}</td></tr>` : ''}
    ${d.taxPaisa > 0n ? `<tr><td>${d.taxLabel ? esc(d.taxLabel) : L('pdf.salesTax')} ${ltr(`${esc(d.taxRatePercent ?? '')}%`)}</td><td class="r">${money(d.taxPaisa)}</td></tr>` : ''}
    <tr class="grand"><td>${L('pdf.total')}</td><td class="r">${money(d.totalPaisa)}</td></tr>
    ${d.paidPaisa > 0n ? `<tr><td>${L('pdf.received')}</td><td class="r">${money(d.paidPaisa)}</td></tr><tr><td><strong>${L('pdf.balanceDue')}</strong></td><td class="r"><strong>${money(d.balancePaisa)}</strong></td></tr>` : ''}
  </table>
  ${d.taxPaisa > 0n && (d.taxRegistration?.sellerNtn || d.taxRegistration?.sellerStrn) ? `<p class="muted">${[d.taxRegistration.sellerNtn ? `${L('pdf.ntn')} ${ltr(esc(d.taxRegistration.sellerNtn))}` : null, d.taxRegistration.sellerStrn ? `${L('pdf.strn')} ${ltr(esc(d.taxRegistration.sellerStrn))}` : null].filter(Boolean).join(' · ')}</p>` : ''}
  ${d.notes ? `<div class="note">${auto(esc(d.notes))}</div>` : ''}`;
  // QA-B-14: an invoice that carries sales tax is titled "Sales Tax Invoice" (wording to be confirmed by the tax adviser).
  return shell(d.company, tr(lang, d.taxPaisa > 0n ? 'pdf.salesTaxInvoice' : 'pdf.invoice'), `${ltr(esc(d.number))}<br>${L('pdf.issued', {}, { date: date(d.issueDate) })}`, body, lang);
}

export interface ReceiptPdfData {
  company: Letterhead;
  number: string;
  receivedOn: string;
  client: { name: string } | null;
  project: { name: string; code: string };
  amountPaisa: bigint;
  whtPaisa: bigint;
  /** Step 18: the client's WHT certificate number, when received. */
  whtCertificateNo?: string | null;
  /** Payment method enum (CASH, CHEQUE…) — labelled in the language. */
  method: string;
  bankName: string | null;
  chequeNo: string | null;
  reference: string | null;
  status: string;
  allocations: Array<{ invoiceNumber: string; amountPaisa: bigint }>;
  creditPaisa: bigint;
  receivedBy: string | null;
}

export function receiptHtml(d: ReceiptPdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const badge = d.status === 'CLEARED' ? 'ok' : d.status === 'PENDING' ? 'warn' : 'bad';
  const rows = d.allocations.map((a) => `<tr><td>${ltr(esc(a.invoiceNumber))}</td><td class="r">${money(a.amountPaisa)}</td></tr>`).join('');
  const method = [esc(enumLabel(lang, 'PaymentMethod', d.method)), d.bankName ? esc(d.bankName) : null].filter(Boolean).join(' · ');
  const reference = [d.chequeNo ? L('pdf.cheque', { number: d.chequeNo }) : null, d.reference ? ltr(esc(d.reference)) : null].filter(Boolean).join(' · ');
  const body = `
  <div class="grid">
    <div><div class="label">${L('pdf.receivedFrom')}</div><strong>${esc(d.client?.name ?? '—')}</strong></div>
    <div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}</div></div>
    <div><div class="label">${L('pdf.method')}</div><strong>${method}</strong><div class="muted">${reference}</div><span class="badge ${badge}">${esc(enumLabel(lang, 'ClientPaymentStatus', d.status))}</span></div>
  </div>
  <table class="totals" style="width:60%;margin-inline-start:0">
    <tr class="grand"><td>${L('pdf.amountReceived')}</td><td class="r">${money(d.amountPaisa)}</td></tr>
    ${d.whtPaisa > 0n ? `<tr><td>${L('pdf.wht')}${d.whtCertificateNo ? `<div class="muted">${L('pdf.whtCertificate', { number: d.whtCertificateNo })}</div>` : ''}</td><td class="r">${money(d.whtPaisa)}</td></tr>` : ''}
  </table>
  ${rows ? `<table><thead><tr><th>${L('pdf.againstInvoice')}</th><th class="r">${L('pdf.amount')}</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
  ${d.creditPaisa > 0n ? `<div class="note">${L('pdf.creditKept', {}, { amount: `<strong>${money(d.creditPaisa)}</strong>` })}</div>` : ''}
  ${d.receivedBy ? `<p class="muted" style="margin-top:28px">${L('pdf.receivedBy', { name: d.receivedBy })}</p>` : ''}`;
  return shell(d.company, tr(lang, 'pdf.receipt'), `${ltr(esc(d.number))}<br>${date(d.receivedOn)}`, body, lang);
}

/** What a statement row is, so its "detail" text can be written in the document language. */
export type StatementDetail =
  | { kind: 'INVOICE'; dueDate: string | null }
  | { kind: 'PAYMENT'; method: string; bankName: string | null; chequeNo: string | null; whtPaisa: bigint };

export interface StatementPdfData {
  company: Letterhead;
  client: { name: string } | null;
  project: { name: string; code: string };
  from: string;
  to: string;
  openingPaisa: bigint;
  rows: Array<{ date: string; kind: string; reference: string; description: string; detail?: StatementDetail; debitPaisa: bigint; creditPaisa: bigint; balancePaisa: bigint; status?: string | null }>;
  closingPaisa: bigint;
  creditPaisa: bigint;
}

function statementDetail(lang: Lang, r: StatementPdfData['rows'][number]): string {
  const d = r.detail;
  if (!d) return esc(r.description);
  if (d.kind === 'INVOICE') return label(lang, 'pdf.invoiceDue', {}, { date: date(d.dueDate) });
  return [
    esc(enumLabel(lang, 'PaymentMethod', d.method)),
    d.bankName ? esc(d.bankName) : null,
    d.chequeNo ? label(lang, 'pdf.cheque', { number: d.chequeNo }) : null,
    d.whtPaisa > 0n ? label(lang, 'pdf.inclWht', {}, { amount: money(d.whtPaisa) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function statementHtml(d: StatementPdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const rows = d.rows
    .map(
      (r) => `<tr><td>${date(r.date)}</td><td>${esc(enumLabel(lang, 'StatementEntry', r.kind))}${r.status ? ` <span class="badge ${r.status === 'BOUNCED' ? 'bad' : r.status === 'PENDING' ? 'warn' : 'ok'}">${esc(enumLabel(lang, 'ClientPaymentStatus', r.status))}</span>` : ''}</td>
      <td>${ltr(esc(r.reference))}</td><td>${statementDetail(lang, r)}</td><td class="r">${r.debitPaisa ? money(r.debitPaisa) : ''}</td><td class="r">${r.creditPaisa ? money(r.creditPaisa) : ''}</td><td class="r">${money(r.balancePaisa)}</td></tr>`,
    )
    .join('');
  const body = `
  <div class="grid">
    <div><div class="label">${L('pdf.owner')}</div><strong>${esc(d.client?.name ?? '—')}</strong></div>
    <div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}</div></div>
    <div><div class="label">${L('pdf.period')}</div><strong>${date(d.from)} – ${date(d.to)}</strong></div>
  </div>
  <table><thead><tr><th>${L('pdf.date')}</th><th>${L('pdf.entry')}</th><th>${L('pdf.ref')}</th><th>${L('pdf.detail')}</th><th class="r">${L('pdf.billed')}</th><th class="r">${L('pdf.received')}</th><th class="r">${L('pdf.balance')}</th></tr></thead>
  <tbody><tr><td>${date(d.from)}</td><td colspan="5"><strong>${L('pdf.openingBalance')}</strong></td><td class="r">${money(d.openingPaisa)}</td></tr>${rows}</tbody></table>
  <table class="totals">
    <tr class="grand"><td>${L('pdf.balanceDue')}</td><td class="r">${money(d.closingPaisa)}</td></tr>
    ${d.creditPaisa > 0n ? `<tr><td>${L('pdf.creditHeld')}</td><td class="r">${money(d.creditPaisa)}</td></tr>` : ''}
  </table>`;
  return shell(d.company, tr(lang, 'pdf.statement'), `${L('pdf.ownerAccount')}<br>${date(d.to)}`, body, lang);
}

export type ReportColumnType = 'text' | 'money' | 'qty' | 'int' | 'percent' | 'date';
export interface ReportPdfData {
  company: Letterhead;
  /** Already in the document language (reports.export localizeReport). */
  title: string;
  subtitle: string;
  generatedOn: string;
  columns: Array<{ key: string; label: string; type: ReportColumnType }>;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null> | null;
}

/** One report cell (one-table reports and books): money in whole rupees, numbers LTR, text `dir=auto`. */
export function reportCell(type: ReportColumnType, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money':
      return ltr(rsWhole(BigInt(v)));
    case 'percent':
      return ltr(`${v}%`);
    case 'date':
      return date(String(v));
    case 'qty':
    case 'int':
      return ltr(Number(v).toLocaleString('en-PK', { maximumFractionDigits: 3 }));
    default:
      return auto(esc(v));
  }
}

/**
 * QA-B-03 / QA-B-12 · wide report tables. More than PORTRAIT_MAX_COLUMNS columns → the PDF is A4
 * landscape; more than LANDSCAPE_MAX_COLUMNS → the table is split into parts that each repeat the
 * leading text columns (e.g. Material + Unit), so no column is ever cut at the page edge.
 */
export const PORTRAIT_MAX_COLUMNS = 8;
export const LANDSCAPE_MAX_COLUMNS = 12;
export const isWideTable = (columns: number) => columns > PORTRAIT_MAX_COLUMNS;

export function splitColumns<C extends { type: ReportColumnType }>(columns: C[], max = LANDSCAPE_MAX_COLUMNS): C[][] {
  if (columns.length <= max) return [columns];
  let lead = 0;
  while (lead < Math.min(2, columns.length - 1) && columns[lead]!.type === 'text') lead++;
  const head = columns.slice(0, lead);
  const rest = columns.slice(lead);
  const per = Math.max(1, max - lead);
  const parts: C[][] = [];
  for (let i = 0; i < rest.length; i += per) parts.push([...head, ...rest.slice(i, i + per)]);
  return parts;
}

/**
 * A report table as HTML — split into parts when too wide; the totals row (first cell "Total") only
 * in a part that has a total to show.
 */
export function reportTable(
  lang: Lang,
  columns: Array<{ key: string; label: string; type: ReportColumnType }>,
  rows: Array<Record<string, string | number | null>>,
  totals: Record<string, string | number | null> | null,
  totalLabel: string = tr(lang, 'common.total'),
): string {
  const right = (t: ReportColumnType) => (t === 'text' || t === 'date' ? '' : ' class="r"');
  return splitColumns(columns)
    .map((cols, part) => {
      const head = cols.map((c) => `<th${right(c.type)}>${esc(c.label)}</th>`).join('');
      const body = rows.map((r) => `<tr>${cols.map((c) => `<td${right(c.type)}>${reportCell(c.type, r[c.key])}</td>`).join('')}</tr>`).join('');
      const filled = totals && cols.slice(1).some((c) => totals[c.key] !== null && totals[c.key] !== undefined && totals[c.key] !== '');
      const total = filled ? `<tr class="total">${cols.map((c, i) => `<td${right(c.type)}><strong>${i === 0 ? esc(totalLabel) : reportCell(c.type, totals[c.key])}</strong></td>`).join('')}</tr>` : '';
      return `<table class="report" data-part="${part + 1}"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}">${esc(tr(lang, 'common.noRows'))}</td></tr>`}${total}</tbody></table>`;
    })
    .join('');
}

export const REPORT_TABLE_CSS = 'table.report { font-size: 8.5px; } table.report th, table.report td { padding: 5px 5px; } tr.total td { border-top: 2px solid #0f172a; } table.report + table.report { margin-top: 14px; }';

/** Generic report table (letterhead, filters line, rows, totals). Landscape: see `isWideTable`. */
export function reportHtml(d: ReportPdfData, lang: Lang = 'en'): string {
  const html = `
  <style>${REPORT_TABLE_CSS}</style>
  <div class="muted" style="margin-bottom:8px">${auto(esc(d.subtitle))}</div>
  ${reportTable(lang, d.columns, d.rows, d.totals)}`;
  return shell(d.company, lang === 'ur' ? d.title : d.title.toUpperCase(), label(lang, 'pdf.generated', {}, { date: date(d.generatedOn) }), html, lang);
}

// ─── Step 11 · Estimate (internal BoQ) and owner shopping list ───────────────

export interface EstimatePdfData {
  company: Letterhead;
  project: { name: string; code: string };
  revision: number;
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
  generatedOn: string;
  coveredAreaSqft: number;
  /** false = the reader has no fields.rates: quantities only. */
  showMoney: boolean;
  sections: Array<{
    section: string;
    amountPaisa: bigint;
    lines: Array<{ description: string; stageKey: string | null; quantity: number; unit: string; wastagePercent: number; owner: boolean; ratePaisa: bigint | null; amountPaisa: bigint | null }>;
  }>;
  directCostPaisa: bigint;
  overheadPaisa: bigint;
  contingencyPaisa: bigint;
  totalPaisa: bigint;
  perSqftPaisa: bigint | null;
}

const qty = (n: number) => ltr(Number(n).toLocaleString('en-PK', { maximumFractionDigits: 2 }));
const stageLabel = (lang: Lang, s: string | null) => (s ? esc(CATALOGS[lang][`estimate.stage.${s}` as MessageKey] ?? s) : '');
const sectionLabel = (lang: Lang, s: string) => esc(CATALOGS[lang][`estimate.section.${s}` as MessageKey] ?? s);

/** Internal BoQ: sections with their lines, section totals, overheads, contingency, total and cost per sq ft. */
export function estimateHtml(d: EstimatePdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const cols = d.showMoney ? 6 : 4;
  const body = d.sections
    .map((s) => {
      const rows = s.lines
        .map(
          (l) => `<tr><td>${esc(l.description)}${l.owner ? ` <span class="badge warn">${L('pdf.suppliedByOwner')}</span>` : ''}</td><td>${stageLabel(lang, l.stageKey)}</td>
          <td class="r">${qty(l.quantity)} ${esc(unitLabel(lang, l.unit))}</td><td class="r">${l.wastagePercent ? ltr(`${l.wastagePercent}%`) : ''}</td>
          ${d.showMoney ? `<td class="r">${l.ratePaisa !== null ? money(l.ratePaisa) : ''}</td><td class="r">${l.amountPaisa !== null ? money(l.amountPaisa) : ''}</td>` : ''}</tr>`,
        )
        .join('');
      return `<tr><td colspan="${cols}" style="background:#f8fafc"><strong>${sectionLabel(lang, s.section)}</strong>${d.showMoney ? ` <span class="muted">· ${money(s.amountPaisa)}</span>` : ''}</td></tr>${rows}`;
    })
    .join('');
  const totals = d.showMoney
    ? `<table class="totals">
    <tr><td>${L('pdf.directCost')}</td><td class="r">${money(d.directCostPaisa)}</td></tr>
    <tr><td>${sectionLabel(lang, 'SITE_OVERHEADS')}</td><td class="r">${money(d.overheadPaisa)}</td></tr>
    <tr><td>${sectionLabel(lang, 'CONTINGENCY')}</td><td class="r">${money(d.contingencyPaisa)}</td></tr>
    <tr class="grand"><td>${L('pdf.total')}</td><td class="r">${money(d.totalPaisa)}</td></tr>
    ${d.perSqftPaisa !== null ? `<tr><td>${L('pdf.costPerSqft')} (${qty(d.coveredAreaSqft)} ${esc(unitLabel(lang, 'sqft'))})</td><td class="r">${money(d.perSqftPaisa)}</td></tr>` : ''}
  </table>`
    : '';
  const html = `
  <style>table.boq { font-size: 9px; } table.boq td, table.boq th { padding: 4px 6px; }</style>
  <div class="grid"><div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}</div></div></div>
  <table class="boq"><thead><tr><th>${L('pdf.description')}</th><th>${L('pdf.neededBy')}</th><th class="r">${L('pdf.qty')}</th><th class="r">${L('pdf.wastage')}</th>${d.showMoney ? `<th class="r">${L('pdf.rate')}</th><th class="r">${L('pdf.amount')}</th>` : ''}</tr></thead><tbody>${body}</tbody></table>
  ${totals}
  <div class="note muted">${L('pdf.internalOnly')}</div>`;
  const meta = `${L('pdf.estimateRevision', { revision: d.revision, status: enumLabel(lang, 'EstimateStatus', d.status) })}<br>${label(lang, 'pdf.generated', {}, { date: date(d.generatedOn) })}`;
  return shell(d.company, tr(lang, 'pdf.estimate'), meta, html, lang);
}

export interface ShoppingListPdfData {
  company: Letterhead;
  project: { name: string; code: string };
  generatedOn: string;
  items: Array<{ description: string; quantity: number; unit: string; neededBy: string }>;
}

/** What the owner buys himself: item, quantity, unit, stage it is needed by. Never any rate. */
/** "To buy" quantity of an owner shopping item: rounded up to a whole unit (the web page shows the same). */
export const buyQuantity = (q: number) => Math.ceil(q - 1e-9);

/**
 * The owner shopping list as one WhatsApp line per item (QA-A-09): every item, "To buy" rounded up
 * as on the page, unit in the document language.
 */
export function shoppingShareItems(items: Array<{ description: string; quantity: number; unit: string }>, lang: Lang): string {
  return items.map((i) => `\n• ${i.description} — ${buyQuantity(i.quantity).toLocaleString('en-PK')} ${unitLabel(lang, i.unit)}`).join('');
}

export function shoppingListHtml(d: ShoppingListPdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey) => label(lang, key);
  const rows = d.items
    .map(
      (i, n) =>
        `<tr><td>${n + 1}</td><td>${esc(i.description)}</td><td class="r"><strong>${qty(buyQuantity(i.quantity))}</strong></td><td class="r muted">${qty(i.quantity)}</td><td>${esc(unitLabel(lang, i.unit))}</td><td>${stageLabel(lang, i.neededBy)}</td></tr>`,
    )
    .join('');
  const html = `
  <div class="grid"><div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}</div></div></div>
  <table><thead><tr><th>#</th><th>${L('pdf.description')}</th><th class="r">${L('pdf.toBuy')}</th><th class="r">${L('pdf.exactQty')}</th><th>${L('pdf.unit')}</th><th>${L('pdf.neededBy')}</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${esc(tr(lang, 'common.noRows'))}</td></tr>`}</tbody></table>`;
  return shell(d.company, tr(lang, 'pdf.ownerShoppingList'), label(lang, 'pdf.generated', {}, { date: date(d.generatedOn) }), html, lang);
}

// ─── Step 12 · Quotation (customer) and quote costing (internal) ─────────────

export interface QuotePdfData {
  company: Letterhead;
  client: { name: string; phone: string | null };
  number: string;
  revision: number;
  date: string;
  validUntil: string;
  title: string;
  siteAddress: string | null;
  city: string | null;
  contractType: string;
  structureType: string;
  plot: { unit: string; size: number; frontFt: number | null; depthFt: number | null };
  coveredAreaSqft: number;
  floors: number;
  basement: boolean;
  mumty: boolean;
  /** BoQ sections the price covers (contractor-priced work; names only — never their amounts). */
  sections: string[];
  /** Sections whose material is all owner-supplied (QA-A-05): listed as "By the owner / not included". */
  ownerSections?: string[];
  specifications: Array<{ categoryKey: string; suppliedBy: 'CONTRACTOR' | 'OWNER'; quality: string | null; materials: string[] }>;
  paymentStages: Array<{ label: string; percent: number; amountPaisa: bigint }>;
  pricePaisa: bigint;
  perSqftPaisa: bigint | null;
}

export interface QuoteInternalPdfData extends QuotePdfData {
  status: string;
  costSections: Array<{ section: string; amountPaisa: bigint }>;
  directCostPaisa: bigint;
  overheadPaisa: bigint;
  contingencyPaisa: bigint;
  costPaisa: bigint;
  finishingAllowancePaisa: bigint;
  costPerSqftPaisa: bigint | null;
  /** Only with fields.contract + fields.profit. */
  margin: { marginPercent: number; marginPaisa: bigint; marginOnPricePercent: number | null } | null;
  /** Price only with fields.contract. */
  showPrice: boolean;
}

function quoteHead(d: QuotePdfData, lang: Lang) {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const plot = `${qty(d.plot.size)} ${esc(unitLabel(lang, d.plot.unit.toLowerCase()))}${d.plot.frontFt && d.plot.depthFt ? ` (${ltr(`${d.plot.frontFt} × ${d.plot.depthFt} ft`)})` : ''}`;
  const building = [L('pdf.storeys', { count: d.floors }), d.basement ? L('pdf.basement') : null, d.mumty ? L('pdf.mumty') : null].filter(Boolean).join(' + ');
  return `
  <div class="grid">
    <div><div class="label">${L('pdf.preparedFor')}</div><strong>${esc(d.client.name)}</strong>${d.client.phone ? `<div class="muted">${ltr(esc(displayPhone(d.client.phone)))}</div>` : ''}</div>
    <div><div class="label">${L('pdf.project')}</div><strong>${esc(d.title)}</strong><div class="muted">${esc([d.siteAddress, d.city].filter(Boolean).join(', '))}</div></div>
    <div><div class="label">${L('pdf.validUntil')}</div><strong>${date(d.validUntil)}</strong></div>
  </div>
  <h3>${L('pdf.scope')}</h3>
  <table><tbody>
    <tr><td>${L('pdf.contract')}</td><td>${esc(enumLabel(lang, 'ContractType', d.contractType))}</td></tr>
    <tr><td>${L('pdf.plot')}</td><td>${plot}</td></tr>
    <tr><td>${L('pdf.building')}</td><td>${building}</td></tr>
    <tr><td>${L('pdf.structure')}</td><td>${esc(enumLabel(lang, 'StructureType', d.structureType))}</td></tr>
    <tr><td>${L('pdf.coveredArea')}</td><td>${qty(d.coveredAreaSqft)} ${esc(unitLabel(lang, 'sqft'))}</td></tr>
    <tr><td>${L('pdf.workIncluded')}</td><td>${d.sections.map((s) => sectionLabel(lang, s)).join(' · ')}</td></tr>
    ${d.ownerSections?.length ? `<tr><td>${L('pdf.workByOwner')}</td><td>${d.ownerSections.map((s) => sectionLabel(lang, s)).join(' · ')}</td></tr>` : ''}
  </tbody></table>`;
}

function quoteSpecs(d: QuotePdfData, lang: Lang) {
  const L = (key: MessageKey) => label(lang, key);
  const rows = d.specifications
    .map(
      (s) =>
        `<tr><td>${esc(tr(lang, `supply.${s.categoryKey}` as MessageKey))}</td><td>${s.suppliedBy === 'OWNER' ? L('pdf.byOwner') : L('pdf.byContractor')}</td><td>${s.quality ? esc(s.quality) : ''}</td><td>${esc(s.materials.join(', '))}</td></tr>`,
    )
    .join('');
  return `<h3>${L('pdf.specifications')}</h3>
  <table><thead><tr><th>${L('pdf.category')}</th><th>${L('pdf.suppliedBy')}</th><th>${L('pdf.quality')}</th><th>${L('pdf.description')}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function quoteSchedule(d: QuotePdfData, lang: Lang, showAmounts: boolean) {
  const L = (key: MessageKey) => label(lang, key);
  const rows = d.paymentStages
    .map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.label)}</td><td class="r">${ltr(`${s.percent}%`)}</td>${showAmounts ? `<td class="r">${money(s.amountPaisa)}</td>` : ''}</tr>`)
    .join('');
  const total = d.paymentStages.reduce((a, s) => a + s.percent, 0);
  return `<h3>${L('pdf.paymentSchedule')}</h3>
  <table><thead><tr><th>#</th><th>${L('pdf.stage')}</th><th class="r">%</th>${showAmounts ? `<th class="r">${L('pdf.amount')}</th>` : ''}</tr></thead>
  <tbody>${rows}<tr><td></td><td><strong>${L('pdf.total')}</strong></td><td class="r"><strong>${ltr(`${Math.round(total * 100) / 100}%`)}</strong></td>${showAmounts ? `<td class="r"><strong>${money(d.pricePaisa)}</strong></td>` : ''}</tr></tbody></table>`;
}

/**
 * Customer quotation: letterhead, client, total price, rate per sq ft, scope, material
 * specifications, payment schedule (100 %), validity and terms. It is built only from the fields
 * in QuotePdfData — costs, overheads, contingency and margins are not part of it.
 */
export function quoteCustomerHtml(d: QuotePdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const price = `<table class="totals">
    <tr class="grand"><td>${L('pdf.totalPrice')}</td><td class="r">${money(d.pricePaisa)}</td></tr>
    ${d.perSqftPaisa !== null ? `<tr><td>${L('pdf.ratePerSqft')} (${qty(d.coveredAreaSqft)} ${esc(unitLabel(lang, 'sqft'))})</td><td class="r">${money(d.perSqftPaisa)}</td></tr>` : ''}
  </table>`;
  const terms = (['pdf.quoteTerm.validity', 'pdf.quoteTerm.changes', 'pdf.quoteTerm.owner', 'pdf.quoteTerm.fees', 'pdf.quoteTerm.payments'] as MessageKey[])
    .map((k) => `<li>${L(k, {}, { date: date(d.validUntil) })}</li>`)
    .join('');
  const html = `
  ${quoteHead(d, lang)}
  ${price}
  ${quoteSpecs(d, lang)}
  ${quoteSchedule(d, lang, true)}
  <h3>${L('pdf.terms')}</h3><ol>${terms}</ol>
  <div class="note muted">${L('pdf.quickEstimateNote')}</div>`;
  const meta = `${L('pdf.quoteMeta', { number: d.number, revision: d.revision })}<br>${label(lang, 'pdf.issued', {}, { date: date(d.date) })}`;
  return shell(d.company, tr(lang, 'pdf.quote'), meta, html, lang);
}

/** Internal quote costing: the customer content plus cost by BoQ section, overheads, contingency, finishing allowance, price and margin. */
export function quoteInternalHtml(d: QuoteInternalPdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  // Overheads and contingency are shown once, in the totals below (QA-A-33)
  const rows = d.costSections
    .filter((s) => s.section !== 'SITE_OVERHEADS' && s.section !== 'CONTINGENCY')
    .map((s) => `<tr><td>${sectionLabel(lang, s.section)}</td><td class="r">${money(s.amountPaisa)}</td></tr>`)
    .join('');
  const html = `
  ${quoteHead(d, lang)}
  <h3>${L('pdf.estimatedCost')}</h3>
  <table><tbody>${rows}</tbody></table>
  <table class="totals">
    <tr><td>${L('pdf.directCost')}</td><td class="r">${money(d.directCostPaisa)}</td></tr>
    <tr><td>${sectionLabel(lang, 'SITE_OVERHEADS')}</td><td class="r">${money(d.overheadPaisa)}</td></tr>
    <tr><td>${sectionLabel(lang, 'CONTINGENCY')}</td><td class="r">${money(d.contingencyPaisa)}</td></tr>
    <tr><td><strong>${L('pdf.estimatedCost')}</strong></td><td class="r"><strong>${money(d.costPaisa)}</strong></td></tr>
    ${d.costPerSqftPaisa !== null ? `<tr><td>${L('pdf.costPerSqft')}</td><td class="r">${money(d.costPerSqftPaisa)}</td></tr>` : ''}
    ${d.finishingAllowancePaisa > 0n ? `<tr><td>${L('pdf.finishingAllowance')}</td><td class="r">${money(d.finishingAllowancePaisa)}</td></tr>` : ''}
    ${d.showPrice ? `<tr class="grand"><td>${L('pdf.totalPrice')}</td><td class="r">${money(d.pricePaisa)}</td></tr>` : ''}
    ${d.showPrice && d.perSqftPaisa !== null ? `<tr><td>${L('pdf.ratePerSqft')}</td><td class="r">${money(d.perSqftPaisa)}</td></tr>` : ''}
    ${d.margin ? `<tr><td>${L('pdf.margin')} (${ltr(`${d.margin.marginPercent}%`)})</td><td class="r">${money(d.margin.marginPaisa)}${d.margin.marginOnPricePercent !== null ? ` · ${ltr(`${d.margin.marginOnPricePercent}%`)}` : ''}</td></tr>` : ''}
  </table>
  ${quoteSpecs(d, lang)}
  ${quoteSchedule(d, lang, d.showPrice)}
  <div class="note muted">${L('pdf.internalOnly')} · ${L('pdf.quickEstimateNote')}</div>`;
  const meta = `${L('pdf.quoteMeta', { number: d.number, revision: d.revision })} · ${esc(enumLabel(lang, 'QuoteStatus', d.status))}<br>${label(lang, 'pdf.generated', {}, { date: date(d.date) })}`;
  return shell(d.company, tr(lang, 'pdf.quoteInternal'), meta, html, lang);
}
