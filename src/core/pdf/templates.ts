/**
 * Plain HTML templates for billing PDFs (no framework). Every value is escaped; money is
 * shown South-Asian style ("Rs 27,75,000").
 */

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

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { font-family: Inter, Arial, sans-serif; color: #0f172a; font-size: 11px; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1d4ed8; padding-bottom: 12px; margin-bottom: 18px; }
  .brand { display: flex; gap: 12px; align-items: center; }
  .brand img { height: 46px; width: auto; }
  .brand h1 { font-size: 18px; margin: 0; }
  .muted { color: #64748b; }
  .doc { text-align: right; }
  .doc h2 { margin: 0; font-size: 20px; color: #1d4ed8; letter-spacing: .5px; }
  .grid { display: flex; gap: 24px; margin-bottom: 16px; }
  .grid > div { flex: 1; }
  .label { font-size: 9px; text-transform: uppercase; letter-spacing: .6px; color: #64748b; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: #475569; background: #f1f5f9; padding: 7px 8px; }
  td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 46%; margin-top: 10px; }
  .totals td { border: none; padding: 4px 8px; }
  .totals .grand td { font-size: 13px; font-weight: 700; border-top: 2px solid #0f172a; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 9px; font-weight: 600; }
  .ok { background: #dcfce7; color: #166534; } .warn { background: #fef3c7; color: #92400e; } .bad { background: #fee2e2; color: #991b1b; }
  .note { margin-top: 18px; padding: 10px; background: #f8fafc; border-radius: 6px; }
`;

function shell(company: Letterhead, docTitle: string, docMeta: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="head">
    <div class="brand">
      ${company.logoUrl ? `<img src="${esc(company.logoUrl)}" alt="">` : ''}
      <div>
        <h1>${esc(company.name)}</h1>
        <div class="muted">${[company.address, company.phone, company.ntn ? `NTN ${company.ntn}` : null].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </div>
    <div class="doc"><h2>${esc(docTitle)}</h2><div class="muted">${docMeta}</div></div>
  </div>
  ${body}
  </body></html>`;
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

export function invoiceHtml(d: InvoicePdfData): string {
  const rows = d.lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td class="r">${l.quantity ? `${esc(l.quantity)} ${esc(l.unit ?? '')}` : ''}</td>
      <td class="r">${l.ratePaisa !== null ? rs(l.ratePaisa) : ''}</td><td class="r">${rs(l.amountPaisa)}</td></tr>`,
    )
    .join('');
  const body = `
  <div class="grid">
    <div><div class="label">Bill to</div><strong>${esc(d.client?.name ?? '—')}</strong><div class="muted">${[d.client?.phone, d.client?.address].filter(Boolean).map(esc).join('<br>')}</div></div>
    <div><div class="label">Project</div><strong>${esc(d.project.name)}</strong><div class="muted">${esc(d.project.code)}${d.project.siteAddress ? `<br>${esc(d.project.siteAddress)}` : ''}</div></div>
    <div><div class="label">Due</div><strong>${day(d.dueDate)}</strong></div>
  </div>
  <table><thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="totals">
    <tr><td>Subtotal</td><td class="r">${rs(d.subtotalPaisa)}</td></tr>
    ${d.taxPaisa > 0n ? `<tr><td>${esc(d.taxLabel ?? 'Sales tax')} ${esc(d.taxRatePercent ?? '')}%</td><td class="r">${rs(d.taxPaisa)}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td class="r">${rs(d.totalPaisa)}</td></tr>
    ${d.paidPaisa > 0n ? `<tr><td>Received</td><td class="r">${rs(d.paidPaisa)}</td></tr><tr><td><strong>Balance due</strong></td><td class="r"><strong>${rs(d.balancePaisa)}</strong></td></tr>` : ''}
  </table>
  ${d.notes ? `<div class="note">${esc(d.notes)}</div>` : ''}`;
  return shell(d.company, 'INVOICE', `${esc(d.number)}<br>Issued ${day(d.issueDate)}`, body);
}

export interface ReceiptPdfData {
  company: Letterhead;
  number: string;
  receivedOn: string;
  client: { name: string } | null;
  project: { name: string; code: string };
  amountPaisa: bigint;
  whtPaisa: bigint;
  method: string;
  reference: string | null;
  status: string;
  allocations: Array<{ invoiceNumber: string; amountPaisa: bigint }>;
  creditPaisa: bigint;
  receivedBy: string | null;
}

export function receiptHtml(d: ReceiptPdfData): string {
  const badge = d.status === 'CLEARED' ? 'ok' : d.status === 'PENDING' ? 'warn' : 'bad';
  const rows = d.allocations.map((a) => `<tr><td>${esc(a.invoiceNumber)}</td><td class="r">${rs(a.amountPaisa)}</td></tr>`).join('');
  const body = `
  <div class="grid">
    <div><div class="label">Received from</div><strong>${esc(d.client?.name ?? '—')}</strong></div>
    <div><div class="label">Project</div><strong>${esc(d.project.name)}</strong><div class="muted">${esc(d.project.code)}</div></div>
    <div><div class="label">Method</div><strong>${esc(d.method)}</strong><div class="muted">${esc(d.reference ?? '')}</div><span class="badge ${badge}">${esc(d.status)}</span></div>
  </div>
  <table class="totals" style="width:60%;margin-left:0">
    <tr class="grand"><td>Amount received</td><td class="r">${rs(d.amountPaisa)}</td></tr>
    ${d.whtPaisa > 0n ? `<tr><td>Tax withheld (WHT)</td><td class="r">${rs(d.whtPaisa)}</td></tr>` : ''}
  </table>
  ${rows ? `<table><thead><tr><th>Against invoice</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
  ${d.creditPaisa > 0n ? `<div class="note">Kept as advance / credit: <strong>${rs(d.creditPaisa)}</strong> — applied to the next invoice.</div>` : ''}
  ${d.receivedBy ? `<p class="muted" style="margin-top:28px">Received by ${esc(d.receivedBy)}</p>` : ''}`;
  return shell(d.company, 'RECEIPT', `${esc(d.number)}<br>${day(d.receivedOn)}`, body);
}

export interface StatementPdfData {
  company: Letterhead;
  client: { name: string } | null;
  project: { name: string; code: string };
  from: string;
  to: string;
  openingPaisa: bigint;
  rows: Array<{ date: string; kind: string; reference: string; description: string; debitPaisa: bigint; creditPaisa: bigint; balancePaisa: bigint; status?: string | null }>;
  closingPaisa: bigint;
  creditPaisa: bigint;
}

export function statementHtml(d: StatementPdfData): string {
  const rows = d.rows
    .map(
      (r) => `<tr><td>${day(r.date)}</td><td>${esc(r.kind)}${r.status ? ` <span class="badge ${r.status === 'BOUNCED' ? 'bad' : r.status === 'PENDING' ? 'warn' : 'ok'}">${esc(r.status)}</span>` : ''}</td>
      <td>${esc(r.reference)}</td><td>${esc(r.description)}</td><td class="r">${r.debitPaisa ? rs(r.debitPaisa) : ''}</td><td class="r">${r.creditPaisa ? rs(r.creditPaisa) : ''}</td><td class="r">${rs(r.balancePaisa)}</td></tr>`,
    )
    .join('');
  const body = `
  <div class="grid">
    <div><div class="label">Owner</div><strong>${esc(d.client?.name ?? '—')}</strong></div>
    <div><div class="label">Project</div><strong>${esc(d.project.name)}</strong><div class="muted">${esc(d.project.code)}</div></div>
    <div><div class="label">Period</div><strong>${day(d.from)} – ${day(d.to)}</strong></div>
  </div>
  <table><thead><tr><th>Date</th><th>Entry</th><th>Ref</th><th>Detail</th><th class="r">Billed</th><th class="r">Received</th><th class="r">Balance</th></tr></thead>
  <tbody><tr><td>${day(d.from)}</td><td colspan="5"><strong>Opening balance</strong></td><td class="r">${rs(d.openingPaisa)}</td></tr>${rows}</tbody></table>
  <table class="totals">
    <tr class="grand"><td>Balance due</td><td class="r">${rs(d.closingPaisa)}</td></tr>
    ${d.creditPaisa > 0n ? `<tr><td>Advance / credit held</td><td class="r">${rs(d.creditPaisa)}</td></tr>` : ''}
  </table>`;
  return shell(d.company, 'STATEMENT', `Owner account<br>${day(d.to)}`, body);
}
