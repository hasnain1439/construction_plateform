import { errors } from '../../core/openapi/registry.js';
import { receivablesQuery } from '../billing/billing.schema.js';
import { AUTH, IDS, READ_403, ok, path } from '../inventory/docs.shared.js';
import { cashFlowQuery, pnlQuery } from './finance.schema.js';

const T = 'Finance';
const DHA = { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla', status: 'ACTIVE' };
const ageing = [
  { bucket: '0-15', amountPaisa: '0' },
  { bucket: '16-30', amountPaisa: '0' },
  { bucket: '31-60', amountPaisa: '110000000' },
  { bucket: '60+', amountPaisa: '0' },
];

export function registerFinanceDocs(): void {
  path(T, 'get', '/api/v1/finance/receivables', {
    summary: 'Receivables with ageing',
    description: 'THEKEDAR. The Step 8 company receivables plus `ageing` per project and in the totals: outstanding by days since the invoice was issued (0–15 / 16–30 / 31–60 / 60+).',
    request: { query: receivablesQuery },
    responses: {
      ...ok('Receivables', {
        asOf: '2026-10-06',
        items: [{ project: DHA, client: { id: IDS.purchase, name: 'Ahmed Raza', phone: '+923001112222' }, outstandingPaisa: '110000000', overduePaisa: '110000000', ageing }],
        totals: { outstandingPaisa: '287000000', overduePaisa: '155000000', overdueProjects: 2, ageing },
      }),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'get', '/api/v1/finance/cash-flow', {
    summary: 'Cash-flow outlook (estimate)',
    description:
      'THEKEDAR. An honest estimate from data already in the system — see `assumptions`. Receipts = unpaid invoice balances by due date (overdue → this month) + stages with an expected date. ' +
      'Outflows = supplier udhaar due 30 days after each unpaid purchase (FIFO) + the average weekly wages / sub-contract / kharcha of the last 8 weeks × days in the month (this month: days left). ' +
      'Own money invested starts at today’s figure and goes down by each month’s net.',
    request: { query: cashFlowQuery },
    responses: {
      ...ok('Outlook', {
        estimate: true,
        asOf: '2026-10-06',
        months: [
          {
            month: '2026-10',
            days: 26,
            expectedReceipts: { invoicesPaisa: '287000000', stagesPaisa: '0', totalPaisa: '287000000' },
            plannedOutflows: { suppliersPaisa: '113600000', wagesPaisa: '4173928', subcontractPaisa: '25767857', expensesPaisa: '4141428', totalPaisa: '147683213' },
            netPaisa: '139316787',
            ownMoneyInvestedAfterPaisa: '-3039316787',
          },
        ],
        openingOwnMoneyInvestedPaisa: '-2900000000',
        closingOwnMoneyInvestedPaisa: '-3039316787',
        beyondHorizonReceiptsPaisa: '0',
        weeklyRunRate: { wagesPaisa: '1123750', subcontractPaisa: '6937500', expensesPaisa: '1115000' },
        assumptions: ['This is an estimate, not a forecast you can bank on: it only uses what is already in the system.'],
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }),
    },
  });
  path(T, 'get', '/api/v1/finance/pnl', {
    summary: 'Profit & loss to date',
    description:
      'THEKEDAR, or a PM with profit.view (assigned projects). Billed = live invoices before sales tax, recoverable invoices left out (they pass the owner’s own purchases through). ' +
      'Cost by bucket from the cost engine (MATERIALS, LABOR_WAGES, SUBCONTRACT, SITE_OVERHEAD, EQUIPMENT, LOSSES — they add up to cost to date). Gross profit = billed − cost; margin = gross profit ÷ billed. ' +
      '`projectedMarginPercent` is null until the estimate engine (Phase 2). Trend: the 12 months ending with `to`.',
    request: { query: pnlQuery },
    responses: {
      ...ok('P&L', {
        period: { from: null, to: '2026-10-06' },
        buckets: ['MATERIALS', 'LABOR_WAGES', 'SUBCONTRACT', 'SITE_OVERHEAD', 'EQUIPMENT', 'LOSSES'],
        projects: [
          {
            project: DHA,
            client: { id: IDS.purchase, name: 'Ahmed Raza' },
            revisedContractPaisa: '1850000000',
            billedToDatePaisa: '925000000',
            receivedToDatePaisa: '815000000',
            costToDatePaisa: '132621576',
            cost: { MATERIALS: '67796576', LABOR_WAGES: '8390000', SUBCONTRACT: '55500000', SITE_OVERHEAD: '370000', EQUIPMENT: '565000', LOSSES: '0' },
            grossProfitToDatePaisa: '792378424',
            marginToDatePercent: 85.6,
            percentBilled: 50,
            percentCostOfContract: 7.1,
            projectedMarginPercent: null,
            projectedMarginNote: 'Available after the estimate engine (Phase 2)',
          },
        ],
        totals: { billedToDatePaisa: '925000000', costToDatePaisa: '132621576', grossProfitToDatePaisa: '792378424', marginToDatePercent: 85.6 },
        trend: [{ month: '2026-09', billedPaisa: '370000000', costPaisa: '62000000', grossProfitPaisa: '308000000' }],
        projectedMarginNote: 'Available after the estimate engine (Phase 2)',
      }),
      ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }),
    },
  });
  path(T, 'get', '/api/v1/finance/cash-floats', {
    summary: 'Cash floats overview',
    description: 'THEKEDAR (all holders) / PM (own + munshis on their projects). The Step 7 accounts plus phone, active projects, total floated, spent this week, last count and pending top-up, with totals.',
    responses: {
      ...ok('Cash with site staff', {
        week: { weekStart: '2026-10-05', weekEnd: '2026-10-11' },
        items: [
          {
            id: IDS.payment,
            name: 'Rafaqat Ali — site cash',
            holder: { id: IDS.payment, name: 'Rafaqat Ali', role: 'MUNSHI', phone: '+923211234567' },
            isActive: true,
            balancePaisa: '930000',
            pendingAckPaisa: '0',
            pendingApprovalPaisa: '0',
            recoverablePaisa: '0',
            lastCountAt: '2026-09-28T13:00:00.000Z',
            lastEntryAt: '2026-10-04T07:00:00.000Z',
            projects: [DHA],
            totalFloatedPaisa: '5000000',
            spentThisWeekPaisa: '0',
            lastCount: { countedAt: '2026-09-28T13:00:00.000Z', differencePaisa: '-10000' },
            pendingTopup: { id: IDS.payment, amountPaisa: '4000000', note: 'Wages on Saturday + cement unloading', requestedAt: '2026-10-05T11:00:00.000Z' },
          },
        ],
        totals: { balancePaisa: '3080000', pendingAckPaisa: '0', pendingApprovalPaisa: '3200000', recoverablePaisa: '0', holders: 2, spentThisWeekPaisa: '3200000', pendingTopupsPaisa: '4000000', pendingTopups: 1 },
      }),
      ...errors({ ...AUTH, 403: READ_403 }),
    },
  });
}
