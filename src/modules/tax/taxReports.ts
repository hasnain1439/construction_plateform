/**
 * Step 18 — tax reports, served at /api/v1/reports/<name> through the reports export pipeline
 * (JSON for screens; CSV / Excel / PDF stored as a REPORT attachment → signed link).
 *
 *   wht-summary            per client × month: gross received, WHT deducted, certificates received / missing
 *   tax-invoice-register   issued invoices of the period: taxable value, rate, tax, authority, status
 *
 * Access: tax.view (route) + fields.amounts (money). Company-wide; `projectId` narrows to one
 * project the caller can see. Default period: the current Pakistan tax year (1 July – 30 June).
 */
import { assertPerm, fieldAccess } from '../../core/auth/access.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Forbidden } from '../../core/errors/AppError.js';
import { enumLabel, tr, trCount, type Lang, type Params } from '../../core/i18n/index.js';
import { jsonLang } from '../../core/i18n/requestLang.js';
import { day, rsWhole } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import { today, ymd } from '../billing/billing.shared.js';
import { documentLang } from '../billing/documents.js';
import { readActor, type ReadActor } from '../dashboard/dashboard.shared.js';
import { findProjectFor } from '../projects/access.js';
import { letterhead, renderReport, storeReport, type Cell, type Report, type ReportColumn } from '../reports/reports.export.js';
import { taxYearOf, whtRateOf } from './tax.rules.js';
import type { TaxReportName, TaxReportQuery } from './tax.schema.js';

const col = (key: string, label: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, label, type });
const sum = (rows: Array<Record<string, Cell>>, key: string) => rows.reduce((s, r) => s + BigInt(r[key] ?? 0), 0n);
const count = (rows: Array<Record<string, Cell>>, key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
const LIVE_OR_CANCELLED = ['ISSUED', 'PARTLY_PAID', 'PAID', 'CANCELLED'] as const;

interface Ctx {
  tx: Tx;
  a: ReadActor;
  q: TaxReportQuery;
  from: string;
  to: string;
  periodText: string;
  projectId: string | null;
  projectName: string;
  /** Language of the free text (subtitle, notes): X-Lang / English for JSON, the file language for files. */
  lang: Lang;
}

/**
 * QA-B-05 / QA-B-20 · a note as a stable code + params (`noteCodes`, for the apps) and as text in
 * the report language (`notes`). Codes: WHT_GROSS, WHT_MISSING_CERTIFICATES {amountPaisa},
 * TAX_SUBTOTAL {authority, ratePercent, taxablePaisa, taxPaisa, count}, CANCELLED_NOT_COUNTED {count},
 * TAX_FROZEN, TAX_ADVISER.
 */
export interface NoteCode {
  code: 'WHT_GROSS' | 'WHT_MISSING_CERTIFICATES' | 'TAX_SUBTOTAL' | 'CANCELLED_NOT_COUNTED' | 'TAX_FROZEN' | 'TAX_ADVISER';
  params: Record<string, string | number>;
}

function noteText(lang: Lang, n: NoteCode): string {
  const p = n.params;
  switch (n.code) {
    case 'WHT_GROSS':
      return tr(lang, 'report.note.whtGross');
    case 'WHT_MISSING_CERTIFICATES':
      return tr(lang, 'report.note.whtMissing', { amount: rsWhole(String(p['amountPaisa'])) });
    case 'TAX_SUBTOTAL':
      return trCount(lang, 'report.note.taxSubtotal', Number(p['count']), { authority: p['authority'], rate: p['ratePercent'], taxable: rsWhole(String(p['taxablePaisa'])), tax: rsWhole(String(p['taxPaisa'])) } as Params);
    case 'CANCELLED_NOT_COUNTED':
      return trCount(lang, 'report.note.cancelled', Number(p['count']));
    case 'TAX_FROZEN':
      return tr(lang, 'report.note.taxFrozen');
    case 'TAX_ADVISER':
      return tr(lang, 'tax.adviserNote');
  }
}

type Built = Omit<Report, 'generatedAt' | 'filters'> & { noteCodes: NoteCode[] };
const withNotes = (lang: Lang, codes: NoteCode[]) => ({ notes: codes.map((n) => noteText(lang, n)), noteCodes: codes });

// ─── WHT summary ────────────────────────────────────────────────────────────

async function whtSummary(c: Ctx): Promise<Built> {
  const payments = await c.tx.clientPayment.findMany({
    where: {
      tenantId: c.a.tenantId,
      status: { not: 'BOUNCED' },
      receivedOn: { gte: dateOnly(c.from), lte: dateOnly(c.to) },
      ...(c.projectId ? { projectId: c.projectId } : {}),
    },
    include: { client: { select: { id: true, name: true, ntn: true } } },
    orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
  });
  const groups = new Map<string, { client: string; ntn: string | null; month: string; rows: typeof payments }>();
  for (const p of payments) {
    const month = ymd(p.receivedOn)!.slice(0, 7);
    const key = `${p.client?.id ?? '-'}|${month}`;
    const g = groups.get(key) ?? { client: p.client?.name ?? '—', ntn: p.client?.ntn ?? null, month, rows: [] };
    g.rows.push(p);
    groups.set(key, g);
  }
  const rows: Array<Record<string, Cell>> = [...groups.values()]
    .sort((x, y) => x.client.localeCompare(y.client) || x.month.localeCompare(y.month))
    .map((g) => {
      const cash = g.rows.reduce((s, p) => s + p.amountPaisa, 0n);
      const wht = g.rows.reduce((s, p) => s + p.whtDeductedPaisa, 0n);
      const withWht = g.rows.filter((p) => p.whtDeductedPaisa > 0n);
      const missing = withWht.filter((p) => !p.whtCertificateNo);
      return {
        client: g.client,
        ntn: g.ntn,
        month: g.month,
        payments: g.rows.length,
        gross: (cash + wht).toString(),
        cashReceived: cash.toString(),
        wht: wht.toString(),
        whtRate: Number(whtRateOf(cash, wht)),
        certificatesReceived: withWht.length - missing.length,
        certificatesMissing: missing.length,
        whtWithoutCertificate: missing.reduce((s, p) => s + p.whtDeductedPaisa, 0n).toString(),
      };
    });
  const columns = [
    col('client', 'Client'),
    col('ntn', 'NTN'),
    col('month', 'Month'),
    col('payments', 'Receipts', 'int'),
    col('gross', 'Gross received', 'money'),
    col('cashReceived', 'Cash received', 'money'),
    col('wht', 'WHT deducted', 'money'),
    col('whtRate', 'WHT rate', 'percent'),
    col('certificatesReceived', 'Certificates received', 'int'),
    col('certificatesMissing', 'Certificates missing', 'int'),
    col('whtWithoutCertificate', 'WHT without certificate', 'money'),
  ];
  const cash = sum(rows, 'cashReceived');
  const wht = sum(rows, 'wht');
  const missingWht = sum(rows, 'whtWithoutCertificate');
  return {
    name: 'wht-summary',
    title: 'WHT Summary',
    subtitle: `${c.projectName} · ${c.periodText}`,
    columns,
    rows,
    totals: {
      client: null,
      ntn: null,
      month: null,
      payments: count(rows, 'payments'),
      gross: (cash + wht).toString(),
      cashReceived: cash.toString(),
      wht: wht.toString(),
      whtRate: Number(whtRateOf(cash, wht)),
      certificatesReceived: count(rows, 'certificatesReceived'),
      certificatesMissing: count(rows, 'certificatesMissing'),
      whtWithoutCertificate: missingWht.toString(),
    },
    ...withNotes(c.lang, [
      { code: 'WHT_GROSS', params: {} },
      ...(missingWht > 0n ? [{ code: 'WHT_MISSING_CERTIFICATES' as const, params: { amountPaisa: missingWht.toString() } }] : []),
      { code: 'TAX_ADVISER', params: {} },
    ]),
  };
}

// ─── Tax-wise invoice register ──────────────────────────────────────────────

async function taxInvoiceRegister(c: Ctx): Promise<Built> {
  const invoices = await c.tx.invoice.findMany({
    where: {
      tenantId: c.a.tenantId,
      status: { in: [...LIVE_OR_CANCELLED] },
      issueDate: { gte: dateOnly(c.from), lte: dateOnly(c.to) },
      ...(c.projectId ? { projectId: c.projectId } : {}),
    },
    include: { client: { select: { name: true, ntn: true } }, project: { select: { code: true } } },
    orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
  });
  const authorityOf = (i: (typeof invoices)[number]) => (i.taxPaisa > 0n ? (i.taxAuthority ?? i.taxLabel ?? 'Sales tax') : '');
  const sorted = [...invoices].sort((x, y) => {
    const ax = authorityOf(x);
    const ay = authorityOf(y);
    if (ax !== ay) return ax === '' ? 1 : ay === '' ? -1 : ax.localeCompare(ay);
    return 0; // already by date → number
  });
  const rows: Array<Record<string, Cell>> = sorted.map((i) => ({
    number: i.number,
    issueDate: ymd(i.issueDate),
    client: i.client?.name ?? null,
    clientNtn: i.buyerNtn ?? i.client?.ntn ?? null,
    code: i.project.code,
    value: i.subtotalPaisa.toString(),
    taxableValue: (i.taxPaisa > 0n ? i.taxableBasePaisa : 0n).toString(),
    taxRate: i.taxPaisa > 0n && i.taxRatePercent !== null ? Number(i.taxRatePercent) : 0,
    tax: i.taxPaisa.toString(),
    total: i.totalPaisa.toString(),
    authority: authorityOf(i) || null,
    invoiceStatus: i.status,
  }));
  const columns = [
    col('number', 'Invoice no.'),
    col('issueDate', 'Date', 'date'),
    col('client', 'Client'),
    col('clientNtn', 'Client NTN'),
    col('code', 'Project'),
    col('value', 'Value', 'money'),
    col('taxableValue', 'Taxable value', 'money'),
    col('taxRate', 'Tax rate', 'percent'),
    col('tax', 'Tax', 'money'),
    col('total', 'Total', 'money'),
    col('authority', 'Authority'),
    col('invoiceStatus', 'Status'),
  ];
  const counted = rows.filter((r) => r['invoiceStatus'] !== 'CANCELLED');
  // Subtotals per authority + rate (cancelled invoices left out).
  const byAuthority = new Map<string, { authority: string; rate: number; taxable: bigint; tax: bigint; n: number }>();
  for (const r of counted.filter((x) => x['authority'])) {
    const k = `${String(r['authority'])} ${r['taxRate']}%`;
    const g = byAuthority.get(k) ?? { authority: String(r['authority']), rate: Number(r['taxRate']), taxable: 0n, tax: 0n, n: 0 };
    g.taxable += BigInt(r['taxableValue'] as string);
    g.tax += BigInt(r['tax'] as string);
    g.n += 1;
    byAuthority.set(k, g);
  }
  const cancelled = rows.length - counted.length;
  return {
    name: 'tax-invoice-register',
    title: 'Tax-wise Invoice Register',
    subtitle: `${c.projectName} · ${c.periodText}`,
    columns,
    rows,
    totals: {
      number: null,
      issueDate: null,
      client: null,
      clientNtn: null,
      code: null,
      value: sum(counted, 'value').toString(),
      taxableValue: sum(counted, 'taxableValue').toString(),
      taxRate: null,
      tax: sum(counted, 'tax').toString(),
      total: sum(counted, 'total').toString(),
      authority: null,
      invoiceStatus: null,
    },
    ...withNotes(c.lang, [
      ...[...byAuthority.values()].map((g) => ({ code: 'TAX_SUBTOTAL' as const, params: { authority: g.authority, ratePercent: g.rate, taxablePaisa: g.taxable.toString(), taxPaisa: g.tax.toString(), count: g.n } })),
      ...(cancelled ? [{ code: 'CANCELLED_NOT_COUNTED' as const, params: { count: cancelled } }] : []),
      { code: 'TAX_FROZEN', params: {} },
      { code: 'TAX_ADVISER', params: {} },
    ]),
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const BUILDERS: Record<TaxReportName, (c: Ctx) => Promise<Built>> = {
  'wht-summary': whtSummary,
  'tax-invoice-register': taxInvoiceRegister,
};

/** `lang`: language of the subtitle and notes (JSON: X-Lang, else English; files: the file language). */
export async function buildTaxReport(tx: Tx, a: ReadActor, name: TaxReportName, q: TaxReportQuery, lang: Lang = 'en'): Promise<Report & { noteCodes: NoteCode[] }> {
  const year = taxYearOf(q.to ?? q.from ?? today());
  const from = q.from ?? year.from;
  const to = q.to ?? (q.from ? today() : year.to);
  const periodText = !q.from && !q.to ? tr(lang, 'report.sub.taxYear', { label: year.label, from: day(year.from), to: day(year.to) }) : `${day(from)} – ${day(to)}`;
  const project = q.projectId ? await findProjectFor(tx, a, q.projectId) : null;
  const built = await BUILDERS[name]({ tx, a, q, from, to, periodText, projectId: project?.id ?? null, projectName: project ? `${project.code} ${project.name}` : tr(lang, 'report.sub.allProjects'), lang });
  return { ...built, generatedAt: new Date().toISOString(), filters: { projectId: q.projectId ?? null, from, to } };
}

/** Cells only these reports have, in the file language (status, "Sales tax"). */
function localizeCells(r: Report, lang: Lang): Report {
  return { ...r, rows: r.rows.map((row) => ('invoiceStatus' in row ? { ...row, invoiceStatus: enumLabel(lang, 'InvoiceStatus', row['invoiceStatus'] as string) } : row)) };
}

export async function runTaxReport(name: TaxReportName, q: TaxReportQuery) {
  const a = readActor();
  assertPerm('tax.view', a, 'Tax reports are for the owner and accounts');
  if (!fieldAccess().amounts) throw new Forbidden('FORBIDDEN', 'You need permission to see money amounts for tax reports');
  const { report, company, lang } = await withTenant(a.tenantId, async (tx) => {
    const lang = q.format === 'json' ? jsonLang() : await documentLang(tx, a.userId, q.lang);
    return {
      lang,
      report: await buildTaxReport(tx, a, name, q, lang),
      company: q.format === 'pdf' ? await letterhead(tx, a.tenantId, { taxIds: true }) : null,
    };
  });
  if (q.format === 'json') return report;
  const buffer = await renderReport(localizeCells(report, lang), q.format, company, lang);
  return withTenant(a.tenantId, (tx) => storeReport(tx, a, report, q.format as 'csv' | 'xlsx' | 'pdf', buffer));
}
