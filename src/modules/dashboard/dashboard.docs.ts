import { z } from 'zod';
import { errors } from '../../core/openapi/registry.js';
import { AUTH, IDS, READ_403, ok, path } from '../inventory/docs.shared.js';
import { overviewQuery } from './dashboard.schema.js';

const T = 'Dashboard';
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE' };
const AHMED = { id: '0199a8c0-0000-7000-8000-000000000101', name: 'Ahmed Raza' };

export function registerDashboardDocs(): void {
  path(T, 'get', '/api/v1/dashboard/overview', {
    summary: 'Company overview',
    description:
      'THEKEDAR / PM (PM: assigned projects). Default period: the last 30 days. Cached for 60 s per user (cleared by any write). ' +
      'Money keys (receivables, collected %, overdue, supplier udhaar, store stock value, cash with site staff, own money, project money columns, `payments`) are only present with billing.view — a PM without financials gets the operational version. ' +
      'Projects at risk = an overdue invoice, or own money invested above 10 % of the contract. `delayed` stays 0 until the schedule exists (Phase 2). ' +
      'Wages by worker type come from the weekly settlements of weeks starting in the period (returned weeks left out). Alerts = latest open billing events + unread critical notifications.',
    request: { query: overviewQuery },
    responses: {
      ...ok('Overview', {
        period: { from: '2026-09-07', to: '2026-10-06' },
        asOf: '2026-10-06',
        seesFinancials: true,
        kpis: {
          activeProjects: { count: 3, atRisk: 2, delayed: 0 },
          pendingApprovals: 6,
          openShortages: 2,
          dispatchesOnTheWay: 2,
          receivablesOutstandingPaisa: '287000000',
          collectedPercent: 91.3,
          invoicedPaisa: '3330000000',
          receivedPaisa: '3040000000',
          overduePaisa: '155000000',
          supplierUdhaarPaisa: '247600000',
          supplierOldestDays: 35,
          supplierPaidPercent: 21.4,
          storeStockValuePaisa: '79890724',
          inTransitValuePaisa: '45917265',
          cashWithSiteStaffPaisa: '3080000',
          ownMoneyInvestedPaisa: '-2900000000',
        },
        site: {
          hazriToday: { mistri: 2, mazdoor: 4, other: 1, total: 7 },
          assignedWorkers: 8,
          peshgiThisWeekPaisa: '0',
          siteKharchaThisWeekPaisa: '3200000',
          week: { weekStart: '2026-10-05', weekEnd: '2026-10-11' },
          deliveriesToday: 1,
          openShortages: 2,
        },
        labor: {
          period: { from: '2026-09-07', to: '2026-10-06' },
          wagesPaisa: '15200000',
          byWorkerType: [{ type: 'MAZDOOR', days: 64.5, wagesPaisa: '6200000' }],
          subcontractorsOverpaid: 1,
        },
        alerts: [{ source: 'BILLING_EVENT', id: IDS.payment, type: 'CHEQUE_BOUNCED', severity: 'CRITICAL', title: 'MCB cheque 118845 bounced — Rs 11,00,000', project: DHA, at: '2026-09-22T06:00:00.000Z', actionUrl: `/projects/${IDS.dha}/billing/payments` }],
        projects: [
          {
            project: DHA,
            client: AHMED,
            contractPaisa: '1850000000',
            invoicedPaisa: '925000000',
            receivedPaisa: '815000000',
            outstandingPaisa: '110000000',
            overduePaisa: '110000000',
            spentToDatePaisa: '132621576',
            ownMoneyInvestedPaisa: '-682378424',
            percentBilled: 50,
            percentSpentOfContract: 7.1,
            atRisk: true,
            nextBillableStage: { id: IDS.purchase, label: 'Grey structure — first floor & roof', status: 'UPCOMING', amountPaisa: '277500000' },
          },
        ],
        payments: {
          period: { from: '2026-09-07', to: '2026-10-06' },
          receivedPaisa: '150000000',
          byMethod: [{ method: 'CHEQUE', amountPaisa: '150000000', count: 1 }],
          cheques: { clearedPaisa: '150000000', pendingPaisa: '0', bouncedPaisa: '110000000' },
        },
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/dashboard/site/{projectId}', {
    summary: 'Site dashboard (munshi landing page)',
    description:
      'Anyone with access to the project (MUNSHI, PM, THEKEDAR; outside → 404). Today’s hazri, material on the way (quantities only), the caller’s own cash (null without a cash account), a to-do list and recent usage / own kharcha. No rates, values or company money.',
    request: { params: z.object({ projectId: z.uuid() }) },
    responses: {
      ...ok('Site dashboard', {
        project: DHA,
        date: '2026-10-06',
        week: { weekStart: '2026-10-05', weekEnd: '2026-10-11' },
        hazriToday: { assigned: 8, marked: 0, full: 0, half: 0, absent: 0, unmarked: 8, present: { mistri: 0, mazdoor: 0, other: 0 } },
        incoming: [{ kind: 'DISPATCH', id: IDS.dispatch, number: 'GP-0144', from: 'Central Store', vehicleNo: 'LES-4471', date: '2026-10-06T04:30:00.000Z', items: [{ material: { id: IDS.cement, name: 'Cement OPC', unit: 'bag' }, quantity: 100 }], actionUrl: `/projects/${IDS.dha}/site/incoming/dispatch/${IDS.dispatch}` }],
        myCash: { accountId: IDS.payment, balancePaisa: '930000', pendingAckPaisa: '0', pendingApprovalPaisa: '0', openTopup: { id: IDS.payment, amountPaisa: '4000000', requestedAt: '2026-10-05T11:00:00.000Z' } },
        todo: [
          { type: 'MARK_HAZRI', label: "Mark today's hazri (8 left)", actionUrl: `/projects/${IDS.dha}/labor/hazri` },
          { type: 'RECEIVE', label: 'Receive GP-0144 from Central Store', actionUrl: `/projects/${IDS.dha}/site/incoming/dispatch/${IDS.dispatch}` },
        ],
        recent: { usage: [{ id: IDS.purchase, date: '2026-10-05', items: [{ material: { id: IDS.cement, name: 'Cement OPC', unit: 'bag' }, quantity: 30 }] }], myKharcha: [] },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
}
