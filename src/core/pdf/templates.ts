/**
 * Plain HTML templates for billing PDFs and report files (no framework). Every value is escaped;
 * money is shown South-Asian style ("Rs 27,75,000"). Labels come from the i18n catalogue in the
 * document's language (`lang`, default English): Urdu documents are `dir="rtl"` with the embedded
 * Nastaliq font (fonts.ts); numbers, codes and money stay left-to-right inside <bdi>.
 */
import { CATALOGS, enumLabel, isRtl, tr, unitLabel, type Lang, type MessageKey, type Params } from '../i18n/index.js';
import { URDU_FONT_FAMILY, urduFontFace } from './fonts.js';

export interface Letterhead {
  name: string;
  ntn: string | null;
  address: string | null;
  phone: string | null;
  logoUrl: string | null;
}

const esc = (v: unknown) =>
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
const ltr = (html: string) => `<bdi dir="ltr">${html}</bdi>`;
const money = (paisa: bigint | string | number) => ltr(rs(paisa));
const date = (d: string | null | undefined) => ltr(day(d));

/** Escaped label in the document language (params are escaped too; pre-built HTML goes in `html`). */
function label(lang: Lang, key: MessageKey, params: Params = {}, html: Record<string, string> = {}): string {
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

function shell(company: Letterhead, docTitle: string, docMeta: string, body: string, lang: Lang): string {
  return `${documentHead(lang)}<body>
  <div class="head">
    <div class="brand">
      ${company.logoUrl ? `<img src="${esc(company.logoUrl)}" alt="">` : ''}
      <div>
        <h1>${esc(company.name)}</h1>
        <div class="muted">${[company.address, company.phone, company.ntn ? `NTN ${company.ntn}` : null].filter(Boolean).map((v) => ltr(esc(v))).join(' · ')}</div>
      </div>
    </div>
    <div class="doc"><h2>${esc(docTitle)}</h2><div class="muted">${docMeta}</div></div>
  </div>
  ${body}
  </body></html>`;
}

/** Footer (page numbers) for the renderer, in the language. */
export function pdfFooter(text: string, lang: Lang): string {
  const rtl = isRtl(lang);
  return `
  <div dir="${rtl ? 'rtl' : 'ltr'}" style="width:100%;font-family:Inter,${rtl ? URDU_FONT_FAMILY : 'Arial,sans-serif'};font-size:8px;color:#64748b;padding:0 14mm;display:flex;justify-content:space-between">
    <span>${esc(text)}</span>
    <span>${esc(tr(lang, 'pdf.page'))} <span class="pageNumber"></span> ${esc(tr(lang, 'pdf.of'))} <span class="totalPages"></span></span>
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
  totalPaisa: bigint;
  paidPaisa: bigint;
  balancePaisa: bigint;
  notes: string | null;
}

export function invoiceHtml(d: InvoicePdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey, params?: Params, html?: Record<string, string>) => label(lang, key, params, html);
  const rows = d.lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td class="r">${l.quantity ? `${ltr(esc(l.quantity))} ${esc(unitLabel(lang, l.unit))}` : ''}</td>
      <td class="r">${l.ratePaisa !== null ? money(l.ratePaisa) : ''}</td><td class="r">${money(l.amountPaisa)}</td></tr>`,
    )
    .join('');
  const body = `
  <div class="grid">
    <div><div class="label">${L('pdf.billTo')}</div><strong>${esc(d.client?.name ?? '—')}</strong><div class="muted">${[d.client?.phone ? ltr(esc(d.client.phone)) : null, d.client?.address ? esc(d.client.address) : null].filter(Boolean).join('<br>')}</div></div>
    <div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}${d.project.siteAddress ? `<br>${esc(d.project.siteAddress)}` : ''}</div></div>
    <div><div class="label">${L('pdf.due')}</div><strong>${date(d.dueDate)}</strong></div>
  </div>
  <table><thead><tr><th>#</th><th>${L('pdf.description')}</th><th class="r">${L('pdf.qty')}</th><th class="r">${L('pdf.rate')}</th><th class="r">${L('pdf.amount')}</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="totals">
    <tr><td>${L('pdf.subtotal')}</td><td class="r">${money(d.subtotalPaisa)}</td></tr>
    ${d.taxPaisa > 0n ? `<tr><td>${d.taxLabel ? esc(d.taxLabel) : L('pdf.salesTax')} ${ltr(`${esc(d.taxRatePercent ?? '')}%`)}</td><td class="r">${money(d.taxPaisa)}</td></tr>` : ''}
    <tr class="grand"><td>${L('pdf.total')}</td><td class="r">${money(d.totalPaisa)}</td></tr>
    ${d.paidPaisa > 0n ? `<tr><td>${L('pdf.received')}</td><td class="r">${money(d.paidPaisa)}</td></tr><tr><td><strong>${L('pdf.balanceDue')}</strong></td><td class="r"><strong>${money(d.balancePaisa)}</strong></td></tr>` : ''}
  </table>
  ${d.notes ? `<div class="note">${esc(d.notes)}</div>` : ''}`;
  return shell(d.company, tr(lang, 'pdf.invoice'), `${ltr(esc(d.number))}<br>${L('pdf.issued', {}, { date: date(d.issueDate) })}`, body, lang);
}

export interface ReceiptPdfData {
  company: Letterhead;
  number: string;
  receivedOn: string;
  client: { name: string } | null;
  project: { name: string; code: string };
  amountPaisa: bigint;
  whtPaisa: bigint;
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
    ${d.whtPaisa > 0n ? `<tr><td>${L('pdf.wht')}</td><td class="r">${money(d.whtPaisa)}</td></tr>` : ''}
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

function cell(type: ReportColumnType, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money':
      return money(BigInt(v));
    case 'percent':
      return ltr(`${v}%`);
    case 'date':
      return date(String(v));
    case 'qty':
    case 'int':
      return ltr(Number(v).toLocaleString('en-PK', { maximumFractionDigits: 3 }));
    default:
      return esc(v);
  }
}

/** Generic report table (letterhead, filters line, rows, totals). */
export function reportHtml(d: ReportPdfData, lang: Lang = 'en'): string {
  const right = (t: ReportColumnType) => (t === 'text' || t === 'date' ? '' : ' class="r"');
  const head = d.columns.map((c) => `<th${right(c.type)}>${esc(c.label)}</th>`).join('');
  const body = d.rows.map((r) => `<tr>${d.columns.map((c) => `<td${right(c.type)}>${cell(c.type, r[c.key])}</td>`).join('')}</tr>`).join('');
  const totals = d.totals ? `<tr class="total">${d.columns.map((c, i) => `<td${right(c.type)}><strong>${i === 0 ? esc(tr(lang, 'common.total')) : cell(c.type, d.totals![c.key])}</strong></td>`).join('')}</tr>` : '';
  const html = `
  <style>table.report { font-size: 8.5px; } table.report th, table.report td { padding: 5px 5px; } tr.total td { border-top: 2px solid #0f172a; }</style>
  <div class="muted" style="margin-bottom:8px">${esc(d.subtitle)}</div>
  <table class="report"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${d.columns.length}">${esc(tr(lang, 'common.noRows'))}</td></tr>`}${totals}</tbody></table>`;
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
export function shoppingListHtml(d: ShoppingListPdfData, lang: Lang = 'en'): string {
  const L = (key: MessageKey) => label(lang, key);
  const rows = d.items
    .map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.description)}</td><td class="r">${qty(i.quantity)}</td><td>${esc(unitLabel(lang, i.unit))}</td><td>${stageLabel(lang, i.neededBy)}</td></tr>`)
    .join('');
  const html = `
  <div class="grid"><div><div class="label">${L('pdf.project')}</div><strong>${esc(d.project.name)}</strong><div class="muted">${ltr(esc(d.project.code))}</div></div></div>
  <table><thead><tr><th>#</th><th>${L('pdf.description')}</th><th class="r">${L('pdf.qty')}</th><th>${L('pdf.unit')}</th><th>${L('pdf.neededBy')}</th></tr></thead><tbody>${rows || `<tr><td colspan="5">${esc(tr(lang, 'common.noRows'))}</td></tr>`}</tbody></table>`;
  return shell(d.company, tr(lang, 'pdf.ownerShoppingList'), label(lang, 'pdf.generated', {}, { date: date(d.generatedOn) }), html, lang);
}
