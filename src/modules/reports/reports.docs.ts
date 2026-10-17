import { errors } from '../../core/openapi/registry.js';
import { AUTH, READ_403, ok, path } from '../inventory/docs.shared.js';
import { bookParams, bookQuery, reportQuery, step18Query, STEP18_REPORT_NAMES, type BookName, type ReportName } from './reports.schema.js';

const T = 'Reports';

const INFO: Record<ReportName, { summary: string; access: string; detail: string }> = {
  'project-summary': { summary: 'Project summary', access: 'THEKEDAR, PM with billing.view (own projects)', detail: 'Per project: contract, billed, received, outstanding, cost by bucket, cost to date, own money invested.' },
  'material-audit': {
    summary: 'Material audit',
    access: 'THEKEDAR, PM (own projects); the value column needs rates.view',
    detail: 'Per project × material: delivered (contractor / owner), used, sent away, count adjustments, losses written off, in stock and value. The period limits the movement columns; stock and value are as of `to`.',
  },
  'labor-peshgi': {
    summary: 'Labour & peshgi',
    access: 'THEKEDAR, PM (own projects)',
    detail: 'Per worker / sub-contractor and project: days, wages (or work value), peshgi given / adjusted / outstanding, paid, retention and balance due. The period limits days and wages.',
  },
  'cash-book': {
    summary: 'Cash book',
    access: 'THEKEDAR, PM (own projects)',
    detail: 'Per holder and project: floats, kharcha by category, other payments, waiting approval, owed back, count differences and net. Without a period, net adds up to cash in hand.',
  },
  'supplier-ageing': { summary: 'Supplier ageing', access: 'THEKEDAR', detail: 'Udhaar per supplier in 0–15 / 16–30 / 31–60 / 60+ day buckets (FIFO), oldest unpaid days and the last payment.' },
  'receivables-ageing': { summary: 'Receivables ageing', access: 'THEKEDAR', detail: 'Outstanding per project / client in the same buckets (days since the invoice was issued), overdue and pending cheques.' },
  'stock-valuation': { summary: 'Stock valuation', access: 'THEKEDAR', detail: 'Store, sites and transit: quantity × weighted-average cost; owner-supplied stock shown without value.' },
  // Step 18
  'delay-analysis': {
    summary: 'Delay analysis — all projects',
    access: 'finance.reports.view + control.view (its project scope); no money',
    detail:
      'One row per project with a schedule: original / revised / projected end, progress, working days of delay by owner / excusable / contractor, change-order days, total, calendar days late, days ahead, late and behind milestones, top reasons (in the file language). `extra.projects[]` (JSON only): days per category and every reason with its days. The per-project book with stoppages, change orders and milestones: GET /reports/delay-analysis/{projectId}.',
  },
  variance: {
    summary: 'Variance — company summary',
    access: 'finance.reports.view + control.view (its project scope)',
    detail:
      'One row per ACTIVE / CLOSEOUT project: physical vs planned progress, materials over / under / not in the estimate; material PKR impact (fields.rates); cost estimate to date, actual, variance and % (fields.amounts + fields.rates); spent % of contract and the gap to progress (fields.amounts + fields.contract); revised contract (fields.contract); estimate at completion and projected margin (fields.amounts + rates + contract + profit). Money columns are left out without the permission. Plan + estimate are loaded once per project and the cost rows in one query. Per project: GET /reports/variance/{projectId}.',
  },
  'change-orders': {
    summary: 'Change order register',
    access: 'finance.reports.view + changeorder.view (its project scope); the total needs fields.rates or fields.amounts',
    detail:
      'Every change order across the projects: project, code, title, type, status, total (signed; left out without the price permission), days, proof type, the invoice that billed it, created and approved dates. Filters: projectId, status, type, from / to (created date). Totals count the approved set only (APPROVED / IN_PROGRESS / COMPLETED / BILLED). `extra`: count per status, approved count / total.',
  },
  'equipment-utilisation': {
    summary: 'Equipment utilisation',
    access: 'finance.reports.view + equipment.view (sites of its project scope); hire / rent / loss value need fields.rates',
    detail:
      'Per item (`group=item`, default) or category: owned at the end of the period, days on site / idle, unit-days on site / idle (end-of-day ledger balances, Karachi days; idle = owned units at the yard or in transit), utilisation % (unit-days on site ÷ owned unit-days), rented unit-days, internal hire charged and rent of the period (EquipmentCharge), lost / damaged quantity and value (EquipmentLoss reported in the period). Filters: from / to (default the last 30 days, at most 366), projectId (that site only), category.',
  },
  snags: {
    summary: 'Snag summary — all projects',
    access: 'finance.reports.view + closeout.snag.view (its project scope); cost attribution needs fields.amounts',
    detail:
      'One row per project with snags: total, open / fixed / verified, overdue (open past the target date), open snags by days open (0–7 / 8–30 / 31+), oldest open, defect-period snags (and still open), cost attributed to rework / sub-contractors / change orders (fields.amounts). Filters: projectId, from / to (logged date). Per project (by assignee, open list, defect-period list): GET /reports/snags/{projectId}.',
  },
};

const BOOKS: Record<BookName, { summary: string; access: string; detail: string }> = {
  'delay-analysis': {
    summary: 'Delay analysis — one project (book)',
    access: 'finance.reports.view + control.view',
    detail:
      'Summary (original / baseline / planned / revised / projected end, progress, days by category, calendar days late, ahead) + sections: `categories` (days and reasons), `stoppages` (approved + pending: dates, days, reason, category, status, note; total = approved days), `changeOrders` (approved change orders with days), `milestones` (late, behind or slipped vs the baseline). No money. A project without a schedule → 409 NO_SCHEDULE.',
  },
  variance: {
    summary: 'Variance — one project (book)',
    access: 'finance.reports.view + control.view',
    detail:
      'Summary (progress, planned progress, cost totals, spent %, revised contract, projected margin — each with its money permission) + sections: `materials` (Step 14 material variance; PKR with fields.rates), `costBuckets` (estimate total / to date, actual, variance; money with fields.amounts + fields.rates), `burn` (per month: progress, cost, cumulative, spent %, gap).',
  },
  snags: {
    summary: 'Snag summary — one project (book)',
    access: 'finance.reports.view + closeout.snag.view',
    detail:
      'Summary (counts, defect period, cost attribution with fields.amounts) + sections: `byAssignee` (worker / sub-contractor / nobody: open, fixed, verified, overdue, cost), `open` (oldest first: location, assignee, days open, target, overdue days), `defectPeriod`. from / to = logged date.',
  },
};

const file = (name: string, format: string, mime: string) => ({
  attachmentId: '0199a8c0-0000-7000-8000-000000000f51',
  fileName: `${name}-2026-10-06.${format}`,
  format,
  mimeType: mime,
  sizeBytes: 7393,
  url: `http://localhost:4000/api/v1/attachments/0199a8c0-0000-7000-8000-000000000f51/file/${name}-2026-10-06.${format}?tid=…&exp=…&sig=…`,
  downloadUrl: `http://localhost:4000/api/v1/attachments/0199a8c0-0000-7000-8000-000000000f51/file/${name}-2026-10-06.${format}?tid=…&exp=…&sig=…&dl=1`,
  expiresAt: '2026-10-06T10:15:00.000Z',
});

export function registerReportsDocs(): void {
  for (const [name, info] of Object.entries(INFO) as Array<[ReportName, (typeof INFO)[ReportName]]>) {
    path(T, 'get', `/api/v1/reports/${name}`, {
      summary: info.summary,
      description:
        `${info.access}. ${info.detail} ` +
        '`format=json` (default) returns the table: `columns` (key, label, type text / money / qty / int / percent / date), `rows`, `totals`. ' +
        '`csv` / `xlsx` / `pdf` (letterhead) are stored as a REPORT attachment and answer `{ attachmentId, fileName, format, mimeType, sizeBytes, url, downloadUrl, expiresAt }` — signed links named after the file (`url` previews, `downloadUrl` saves; QA-B-15: `<report>[-<project code>]-<yyyy-mm-dd>.<ext>`), never the raw file. JSON free text (subtitle, notes, reason cells) follows `X-Lang`, else English. Money is paisa in JSON and rupees in files. Files are in `lang` (en / roman / ur; default the signed-in user’s language): title, headers, Total and status / type / unit cells; Urdu PDFs are right-to-left with an embedded Nastaliq font.',
      request: { query: (STEP18_REPORT_NAMES as readonly string[]).includes(name) ? step18Query : reportQuery },
      responses: {
        ...ok(
          'Report table (json) or a signed link (csv / xlsx / pdf)',
          name === 'supplier-ageing'
            ? file(name, 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            : {
                name,
                title: info.summary,
                subtitle: 'All projects · Up to 6 Oct 2026',
                generatedAt: '2026-10-06T05:00:00.000Z',
                filters: { projectId: null, from: null, to: null },
                columns: [
                  { key: 'project', label: 'Project', type: 'text' },
                  { key: 'value', label: 'Value', type: 'money' },
                ],
                rows: [{ project: 'MSB-2026-012', value: '79890724' }],
                totals: { project: null, value: '79890724' },
              },
        ),
        ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'], 503: ['PDF_UNAVAILABLE'] }),
      },
    });
  }
  for (const [name, info] of Object.entries(BOOKS) as Array<[BookName, (typeof BOOKS)[BookName]]>) {
    path(T, 'get', `/api/v1/reports/${name}/{projectId}`, {
      summary: info.summary,
      description:
        `${info.access}. ${info.detail} ` +
        '`format=json` (default) returns the book: `project`, `summary` [{ key, label, type, value }], `sections` [{ key, title, columns, rows, totals }]. `csv` (summary, then each section) / `xlsx` (a summary sheet + one sheet per section) / `pdf` (letterhead, summary, one table per section) answer a signed link like the other reports, in `lang`.',
      request: { params: bookParams, query: bookQuery },
      responses: {
        ...ok('Report book (json) or a signed link (csv / xlsx / pdf)', {
          name: `${name}-project`,
          title: info.summary,
          subtitle: 'MSB-2026-012 DHA Phase 6 · 10 Marla · as of 16 Oct 2026',
          generatedAt: '2026-10-16T05:00:00.000Z',
          filters: { projectId: '0199a8c0-0000-7000-8000-000000000012', from: null, to: null },
          project: { id: '0199a8c0-0000-7000-8000-000000000012', code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE' },
          summary: [{ key: 'totalDays', label: 'Total delay days', type: 'int', value: 5 }],
          sections: [{ key: 'stoppages', title: 'Stoppages', columns: [{ key: 'reason', label: 'Reason', type: 'text' }], rows: [{ reason: 'RAIN' }], totals: null }],
        }),
        ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'], ...(name === 'delay-analysis' ? { 409: ['NO_SCHEDULE'] as string[] } : ({} as Record<number, string[]>)), 503: ['PDF_UNAVAILABLE'] }),
      },
    });
  }
}
