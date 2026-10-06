import { errors } from '../../core/openapi/registry.js';
import { AUTH, READ_403, ok, path } from '../inventory/docs.shared.js';
import { reportQuery, type ReportName } from './reports.schema.js';

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
};

const file = (name: string, format: string, mime: string) => ({
  attachmentId: '0199a8c0-0000-7000-8000-000000000f51',
  fileName: `${name}-2026-10-06.${format}`,
  format,
  mimeType: mime,
  sizeBytes: 7393,
  url: `https://res.cloudinary.com/demo/raw/upload/s--sig--/${name}-2026-10-06.${format}`,
  expiresAt: '2026-10-06T10:15:00.000Z',
});

export function registerReportsDocs(): void {
  for (const [name, info] of Object.entries(INFO) as Array<[ReportName, (typeof INFO)[ReportName]]>) {
    path(T, 'get', `/api/v1/reports/${name}`, {
      summary: info.summary,
      description:
        `${info.access}. ${info.detail} ` +
        '`format=json` (default) returns the table: `columns` (key, label, type text / money / qty / int / percent / date), `rows`, `totals`. ' +
        '`csv` / `xlsx` / `pdf` (letterhead) are stored as a REPORT attachment and answer `{ url, expiresAt }` — a signed link, never the raw file. Money is paisa in JSON and rupees in files.',
      request: { query: reportQuery },
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
}
