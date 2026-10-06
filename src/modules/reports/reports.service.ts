/**
 * B5 — reports. Each builder reads the owning module's numbers (receivables `moneyOf`, the cost
 * engine, the stock ledger, advances / settlements / sub-contract accounts, the cash book, FIFO
 * supplier balances) and returns one table. The same table is served as JSON or exported.
 *
 * Who may run what
 *   project-summary    THEKEDAR, PM with billing.view (own projects)
 *   material-audit     THEKEDAR, PM (own projects); values only with rates.view
 *   labor-peshgi       THEKEDAR, PM (own projects)
 *   cash-book          THEKEDAR, PM (own projects)
 *   supplier-ageing, receivables-ageing, stock-valuation   THEKEDAR
 */
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { Forbidden } from '../../core/errors/AppError.js';
import { day } from '../../core/pdf/templates.js';
import { dateOnly } from '../../core/utils/dates.js';
import type { ExpenseCategory, StockMovementType } from '../../generated/prisma/client.js';
import { daysBetween, today, ymd } from '../billing/billing.shared.js';
import { bucketsOf, PNL_BUCKETS, projectCosts } from '../billing/projectCost.service.js';
import { moneyOf } from '../billing/receivables.service.js';
import { totalsOf } from '../cashbook/cash.js';
import { periodOf, readActor, scopedProjects, str, type ReadActor } from '../dashboard/dashboard.shared.js';
import { ageing, AGEING_BUCKETS } from '../finance/ageing.js';
import { pktDayEnd, pktDayStart } from '../inventory/inventory.service.js';
import { avgOf, qn, ZERO } from '../inventory/stock.js';
import { advanceState } from '../labor/advances.service.js';
import { subAccounts } from '../labor/subcontractLedger.js';
import { supplierBalances } from '../procurement/supplierLedger.service.js';
import { findProjectFor } from '../projects/access.js';
import { letterhead, renderReport, storeReport, type Cell, type Report, type ReportColumn } from './reports.export.js';
import type { ReportName, ReportQuery } from './reports.schema.js';

const NON_DRAFT = ['ACTIVE', 'CLOSEOUT', 'HANDED_OVER', 'CLOSED'] as const;
const BUCKET_LABEL: Record<(typeof PNL_BUCKETS)[number], string> = {
  MATERIALS: 'Materials',
  LABOR_WAGES: 'Labour',
  SUBCONTRACT: 'Sub-contract',
  SITE_OVERHEAD: 'Site overhead',
  EQUIPMENT: 'Equipment',
  LOSSES: 'Losses',
};
const AGEING_COLUMNS: ReportColumn[] = AGEING_BUCKETS.map((b) => ({ key: `age_${b}`, label: `${b} days`, type: 'money' }));

const col = (key: string, label: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, label, type });
const sumCol = (rows: Array<Record<string, Cell>>, key: string) => str(rows.reduce((s, r) => s + BigInt(r[key] ?? 0), 0n));
const qtyCol = (rows: Array<Record<string, Cell>>, key: string) => Math.round(rows.reduce((s, r) => s + Number(r[key] ?? 0), 0) * 1000) / 1000;
function totalsOfColumns(columns: ReportColumn[], rows: Array<Record<string, Cell>>, skip: string[] = []) {
  return Object.fromEntries(columns.map((c) => [c.key, skip.includes(c.key) ? null : c.type === 'money' ? sumCol(rows, c.key) : c.type === 'qty' || c.type === 'int' ? qtyCol(rows, c.key) : null]));
}

interface Ctx {
  tx: Tx;
  a: ReadActor;
  q: ReportQuery;
  projectName: string;
}

const ownerOnly = (a: ReadActor) => {
  if (a.role !== 'THEKEDAR') throw new Forbidden('FORBIDDEN', 'Only the owner can run this report');
};
const periodText = (q: ReportQuery) => (q.from || q.to ? `${q.from ? day(q.from) : 'Start'} – ${day(q.to ?? today())}` : `Up to ${day(today())}`);

async function projectsFor(c: Ctx) {
  return scopedProjects(c.tx, c.a, [...NON_DRAFT], c.q.projectId);
}

// ─── 1. Project summary ─────────────────────────────────────────────────────

async function projectSummary(c: Ctx): Promise<Omit<Report, 'generatedAt' | 'filters'>> {
  if (!c.a.seesFinancials) throw new Forbidden('FORBIDDEN', 'You need financial access for this report');
  const projects = await projectsFor(c);
  const costs = await projectCosts(
    c.tx,
    c.a.tenantId,
    projects.map((p) => p.id),
  );
  const rows: Array<Record<string, Cell>> = [];
  for (const p of projects) {
    const m = await moneyOf(c.tx, c.a.tenantId, p);
    const cost = costs.get(p.id)!;
    const b = bucketsOf(cost.rows);
    rows.push({
      code: p.code,
      name: p.name,
      client: p.client?.name ?? null,
      status: p.status,
      contract: str(m.contract),
      billed: str(m.invoiced),
      received: str(m.received),
      outstanding: str(m.outstanding),
      ...Object.fromEntries(PNL_BUCKETS.map((k) => [`cost_${k}`, str(b[k])])),
      costTotal: str(cost.cost.totalPaisa),
      ownMoney: str(cost.cost.totalPaisa - m.received),
    });
  }
  const columns = [
    col('code', 'Code'),
    col('name', 'Project'),
    col('client', 'Client'),
    col('status', 'Status'),
    col('contract', 'Contract', 'money'),
    col('billed', 'Billed', 'money'),
    col('received', 'Received', 'money'),
    col('outstanding', 'Outstanding', 'money'),
    ...PNL_BUCKETS.map((k) => col(`cost_${k}`, BUCKET_LABEL[k], 'money')),
    col('costTotal', 'Cost to date', 'money'),
    col('ownMoney', 'Own money in', 'money'),
  ];
  return { name: 'project-summary', title: 'Project Summary', subtitle: `${c.projectName} · ${periodText({ format: 'json' })}`, columns, rows, totals: totalsOfColumns(columns, rows) };
}

// ─── 2. Material audit ──────────────────────────────────────────────────────

const AUDIT_TYPE: Partial<Record<StockMovementType, 'deliveredContractor' | 'deliveredOwner' | 'used' | 'transfersOut' | 'adjustments'>> = {
  RECEIPT_IN: 'deliveredContractor',
  PURCHASE_IN: 'deliveredContractor',
  PURCHASE_RETURN_OUT: 'deliveredContractor',
  OWNER_DELIVERY_IN: 'deliveredOwner',
  USAGE_OUT: 'used',
  DISPATCH_OUT: 'transfersOut',
  COUNT_ADJUSTMENT: 'adjustments',
  CORRECTION: 'adjustments',
};

async function materialAudit(c: Ctx): Promise<Omit<Report, 'generatedAt' | 'filters'>> {
  const projects = await projectsFor(c);
  const sites = await c.tx.stockLocation.findMany({ where: { tenantId: c.a.tenantId, type: 'SITE', projectId: { in: projects.map((p) => p.id) } }, select: { id: true, projectId: true } });
  const toAt = pktDayEnd(c.q.to ?? today());
  const fromAt = c.q.from ? pktDayStart(c.q.from) : null;
  const all = await c.tx.stockMovement.groupBy({
    by: ['locationId', 'materialId', 'type', 'ownerSupplied'],
    where: { tenantId: c.a.tenantId, locationId: { in: sites.map((s) => s.id) }, occurredAt: { lt: toAt } },
    _sum: { quantity: true, valuePaisa: true },
  });
  const inPeriod = fromAt
    ? await c.tx.stockMovement.groupBy({
        by: ['locationId', 'materialId', 'type', 'ownerSupplied'],
        where: { tenantId: c.a.tenantId, locationId: { in: sites.map((s) => s.id) }, occurredAt: { gte: fromAt, lt: toAt } },
        _sum: { quantity: true },
      })
    : all;
  const losses = await c.tx.shortage.groupBy({
    by: ['projectId', 'materialId'],
    where: { tenantId: c.a.tenantId, projectId: { in: projects.map((p) => p.id) }, resolution: 'ACCEPT_LOSS', ...(fromAt ? { resolvedAt: { gte: fromAt, lt: toAt } } : {}) },
    _sum: { qty: true, valuePaisa: true },
  });
  const materials = new Map(
    (await c.tx.material.findMany({ where: { tenantId: c.a.tenantId, id: { in: [...new Set([...all.map((r) => r.materialId), ...losses.map((l) => l.materialId)])] } }, select: { id: true, name: true, unit: true } })).map((m) => [m.id, m]),
  );
  const projectOf = new Map(sites.map((s) => [s.id, s.projectId!]));
  type AuditRow = Record<'deliveredContractor' | 'deliveredOwner' | 'used' | 'transfersOut' | 'adjustments' | 'losses' | 'inStock', number> & { value: bigint };
  const byKey = new Map<string, AuditRow>();
  const key = (projectId: string, materialId: string) => `${projectId}|${materialId}`;
  const row = (k: string): AuditRow => {
    const found = byKey.get(k);
    if (found) return found;
    const r: AuditRow = { deliveredContractor: 0, deliveredOwner: 0, used: 0, transfersOut: 0, adjustments: 0, losses: 0, inStock: 0, value: 0n };
    byKey.set(k, r);
    return r;
  };
  for (const g of inPeriod) {
    const field = AUDIT_TYPE[g.type];
    if (!field) continue;
    const qty = Number((g._sum.quantity ?? ZERO).toFixed(3));
    row(key(projectOf.get(g.locationId)!, g.materialId))[field] += field === 'used' || field === 'transfersOut' ? -qty : qty;
  }
  for (const g of all) {
    const r = row(key(projectOf.get(g.locationId)!, g.materialId));
    r.inStock += Number((g._sum.quantity ?? ZERO).toFixed(3));
    if (!g.ownerSupplied) r.value += g._sum.valuePaisa ?? 0n;
  }
  for (const l of losses) row(key(l.projectId!, l.materialId)).losses += Number((l._sum.qty ?? ZERO).toFixed(3));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const rows = [...byKey.entries()]
    .map(([k, r]) => {
      const [projectId, materialId] = k.split('|') as [string, string];
      const m = materials.get(materialId)!;
      const round = (n: number) => Math.round(n * 1000) / 1000;
      return {
        project: projectById.get(projectId)!.code,
        material: m.name,
        unit: m.unit,
        deliveredContractor: round(r.deliveredContractor),
        deliveredOwner: round(r.deliveredOwner),
        used: round(r.used),
        transfersOut: round(r.transfersOut),
        adjustments: round(r.adjustments),
        losses: round(r.losses),
        inStock: round(r.inStock),
        ...(c.a.seesRates ? { value: str(r.value) } : {}),
      } as Record<string, Cell>;
    })
    .sort((x, y) => String(x['project']).localeCompare(String(y['project'])) || String(x['material']).localeCompare(String(y['material'])));
  const columns = [
    col('project', 'Project'),
    col('material', 'Material'),
    col('unit', 'Unit'),
    col('deliveredContractor', 'Delivered (contractor)', 'qty'),
    col('deliveredOwner', 'Delivered (owner)', 'qty'),
    col('used', 'Used', 'qty'),
    col('transfersOut', 'Sent away', 'qty'),
    col('adjustments', 'Count adjustments', 'qty'),
    col('losses', 'Losses written off', 'qty'),
    col('inStock', 'In stock', 'qty'),
    ...(c.a.seesRates ? [col('value', 'Stock value', 'money')] : []),
  ];
  return {
    name: 'material-audit',
    title: 'Material Audit',
    subtitle: `${c.projectName} · ${periodText(c.q)}`,
    columns,
    rows,
    totals: c.a.seesRates ? { ...Object.fromEntries(columns.map((x) => [x.key, null])), value: sumCol(rows, 'value') } : null,
    notes: ['Quantities mix units, so only the value column is totalled.', 'In stock and value are as of the end date; the other columns are for the period.'],
  };
}

// ─── 3. Labour & peshgi ─────────────────────────────────────────────────────

async function laborPeshgi(c: Ctx): Promise<Omit<Report, 'generatedAt' | 'filters'>> {
  const projects = await projectsFor(c);
  const ids = projects.map((p) => p.id);
  const code = new Map(projects.map((p) => [p.id, p.code]));
  const period = c.q.from || c.q.to ? periodOf(c.q) : null;
  const dateRange = period ? { gte: dateOnly(period.from), lte: dateOnly(period.to) } : undefined;

  const workers = await c.tx.projectWorker.findMany({ where: { tenantId: c.a.tenantId, projectId: { in: ids } }, include: { worker: { select: { id: true, name: true, type: true } } } });
  const attendance = await c.tx.attendance.groupBy({
    by: ['projectId', 'workerId', 'status'],
    where: { tenantId: c.a.tenantId, projectId: { in: ids }, status: { in: ['FULL', 'HALF'] }, ...(dateRange ? { date: dateRange } : {}) },
    _count: true,
  });
  const lines = await c.tx.wageSettlementLine.findMany({
    where: { tenantId: c.a.tenantId, settlement: { projectId: { in: ids }, status: { not: 'RETURNED' }, ...(dateRange ? { weekStart: dateRange } : {}) } },
    select: { workerId: true, grossPaisa: true, netPaisa: true, paymentStatus: true, settlement: { select: { projectId: true } } },
  });
  const advances = await c.tx.advance.findMany({
    where: { tenantId: c.a.tenantId, projectId: { in: ids } },
    include: { allocations: { select: { amountPaisa: true, line: { select: { settlement: { select: { status: true } } } } } } },
  });

  const rows: Array<Record<string, Cell>> = [];
  for (const pw of workers) {
    const days = attendance.filter((x) => x.projectId === pw.projectId && x.workerId === pw.workerId).reduce((n, x) => n + x._count * (x.status === 'FULL' ? 1 : 0.5), 0);
    const mine = lines.filter((l) => l.workerId === pw.workerId && l.settlement.projectId === pw.projectId);
    const adv = advances.filter((x) => x.workerId === pw.workerId && x.projectId === pw.projectId);
    const given = adv.filter((x) => !dateRange || (ymd(x.date)! >= period!.from && ymd(x.date)! <= period!.to)).reduce((s, x) => s + x.amountPaisa, 0n);
    const states = adv.map(advanceState);
    if (!days && !mine.length && !adv.length) continue;
    rows.push({
      payee: pw.worker.name,
      kind: 'Worker',
      trade: pw.worker.type.replaceAll('_', ' ').toLowerCase(),
      project: code.get(pw.projectId)!,
      days,
      earned: str(mine.reduce((s, l) => s + l.grossPaisa, 0n)),
      peshgiGiven: str(given),
      peshgiAdjusted: str(states.reduce((s, x) => s + x.adjusted, 0n)),
      peshgiOutstanding: str(states.reduce((s, x) => s + x.outstanding, 0n)),
      paid: str(mine.filter((l) => l.paymentStatus === 'PAID').reduce((s, l) => s + l.netPaisa, 0n)),
      retentionHeld: null,
      balanceDue: str(mine.filter((l) => l.paymentStatus !== 'PAID').reduce((s, l) => s + l.netPaisa, 0n)),
    });
  }

  const assignments = await c.tx.subcontractAssignment.findMany({ where: { tenantId: c.a.tenantId, projectId: { in: ids } }, include: { subcontractor: { select: { name: true, trade: true } } } });
  const accounts = await subAccounts(c.tx, c.a.tenantId, assignments);
  for (const s of assignments) {
    const acc = accounts.get(s.id)!;
    const adv = advances.filter((x) => x.assignmentId === s.id);
    rows.push({
      payee: s.subcontractor.name,
      kind: 'Sub-contractor',
      trade: s.subcontractor.trade.replaceAll('_', ' ').toLowerCase(),
      project: code.get(s.projectId)!,
      days: null,
      earned: str(acc.valuePaisa),
      peshgiGiven: str(adv.reduce((t, x) => t + x.amountPaisa, 0n)),
      peshgiAdjusted: str(adv.reduce((t, x) => t + x.amountPaisa, 0n)),
      peshgiOutstanding: '0',
      paid: str(acc.paidPaisa),
      retentionHeld: str(acc.retentionHeldPaisa),
      balanceDue: str(acc.balanceDuePaisa),
    });
  }
  const columns = [
    col('payee', 'Name'),
    col('kind', 'Type'),
    col('trade', 'Trade'),
    col('project', 'Project'),
    col('days', 'Days', 'qty'),
    col('earned', 'Wages / work value', 'money'),
    col('peshgiGiven', 'Peshgi given', 'money'),
    col('peshgiAdjusted', 'Peshgi adjusted', 'money'),
    col('peshgiOutstanding', 'Peshgi outstanding', 'money'),
    col('paid', 'Paid', 'money'),
    col('retentionHeld', 'Retention held', 'money'),
    col('balanceDue', 'Balance due', 'money'),
  ];
  return {
    name: 'labor-peshgi',
    title: 'Labour & Peshgi',
    subtitle: `${c.projectName} · ${periodText(c.q)}`,
    columns,
    rows,
    totals: totalsOfColumns(columns, rows),
    notes: ['Workers: wages from weekly settlements (returned weeks left out); balance due = settlement lines not paid yet.', 'Sub-contractors: the running account (value − retention − paid − deductions); negative = overpaid. Their advances go straight into the account.'],
  };
}

// ─── 4. Cash book ───────────────────────────────────────────────────────────

const CATEGORIES: ExpenseCategory[] = ['TEA_WATER', 'TRANSPORT', 'UNLOADING', 'FUEL', 'SMALL_TOOLS', 'URGENT_MATERIAL', 'OWNER_PURCHASE', 'REPAIRS', 'OTHER'];

async function cashBook(c: Ctx): Promise<Omit<Report, 'generatedAt' | 'filters'>> {
  const projects = await projectsFor(c);
  const ids = projects.map((p) => p.id);
  const code = new Map(projects.map((p) => [p.id, p.code]));
  const accounts = await c.tx.cashAccount.findMany({
    where: c.a.role === 'THEKEDAR' ? { tenantId: c.a.tenantId } : { tenantId: c.a.tenantId, OR: [{ holderUserId: c.a.userId }, { holder: { projectAccess: { some: { projectId: { in: ids } } } } }] },
    include: { holder: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });
  const period = c.q.from || c.q.to ? periodOf(c.q) : null;
  const projectFilter = c.q.projectId || c.a.role !== 'THEKEDAR' ? { projectId: { in: ids } } : {};
  const groups = await c.tx.cashEntry.groupBy({
    by: ['accountId', 'projectId', 'type', 'category', 'status', 'recoverableFromHolder'],
    where: { tenantId: c.a.tenantId, accountId: { in: accounts.map((x) => x.id) }, ...projectFilter, ...(period ? { occurredAt: { gte: period.fromAt, lt: period.toAt } } : {}) },
    _sum: { amountPaisa: true },
  });
  const totals = await totalsOf(
    c.tx,
    c.a.tenantId,
    accounts.map((x) => x.id),
  );
  const rows: Array<Record<string, Cell>> = [];
  for (const acc of accounts) {
    const projectIds = [...new Set(groups.filter((g) => g.accountId === acc.id).map((g) => g.projectId))];
    for (const projectId of projectIds) {
      const mine = groups.filter((g) => g.accountId === acc.id && g.projectId === projectId);
      const sum = (f: (g: (typeof mine)[number]) => boolean, sign = 1n) => str(mine.filter(f).reduce((s, g) => s + (g._sum.amountPaisa ?? 0n), 0n) * sign);
      rows.push({
        holder: acc.holder.name,
        project: projectId ? (code.get(projectId) ?? '—') : 'No project',
        floats: sum((g) => g.type === 'FLOAT_IN' && g.status !== 'PENDING_ACK'),
        ...Object.fromEntries(CATEGORIES.map((cat) => [`spent_${cat}`, sum((g) => g.type === 'EXPENSE' && g.category === cat, -1n)])),
        otherPayments: sum((g) => ['PESHGI', 'WAGE_PAYMENT', 'SUBCONTRACT_PAYMENT', 'PURCHASE'].includes(g.type), -1n),
        pendingApproval: sum((g) => g.status === 'PENDING_APPROVAL', -1n),
        recoverable: sum((g) => g.status === 'REJECTED' && g.recoverableFromHolder, -1n),
        countDifferences: sum((g) => g.type === 'COUNT_ADJUSTMENT'),
        net: sum((g) => g.status !== 'PENDING_ACK'),
      });
    }
  }
  const columns = [
    col('holder', 'Holder'),
    col('project', 'Project'),
    col('floats', 'Floats received', 'money'),
    ...CATEGORIES.map((cat) => col(`spent_${cat}`, cat.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase()), 'money')),
    col('otherPayments', 'Peshgi / wages / sub-contract / purchases', 'money'),
    col('pendingApproval', 'Waiting approval', 'money'),
    col('recoverable', 'Owed back by holder', 'money'),
    col('countDifferences', 'Count differences', 'money'),
    col('net', 'Net (period)', 'money'),
  ];
  const balance = accounts.reduce((s, x) => s + totals.get(x.id)!.balancePaisa, 0n);
  return {
    name: 'cash-book',
    title: 'Cash Book',
    subtitle: `${c.projectName} · ${periodText(c.q)} · Cash in hand now ${Number(balance / 100n).toLocaleString('en-PK')}`,
    columns,
    rows,
    totals: totalsOfColumns(columns, rows),
    notes: ['One row per holder and project. Without a period, "Net" adds up to each holder’s cash in hand.'],
  };
}

// ─── 5. Supplier ageing ─────────────────────────────────────────────────────

async function supplierAgeing(c: Ctx): Promise<Omit<Report, 'generatedAt' | 'filters'>> {
  ownerOnly(c.a);
  const suppliers = await c.tx.supplier.findMany({ where: { tenantId: c.a.tenantId }, select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' } });
  const bal = await supplierBalances(
    c.tx,
    c.a.tenantId,
    suppliers.map((s) => s.id),
  );
  const lastPayments = await c.tx.supplierLedgerEntry.findMany({
    where: { tenantId: c.a.tenantId, type: 'PAYMENT' },
    orderBy: { occurredAt: 'desc' },
    distinct: ['supplierId'],
    select: { supplierId: true, occurredAt: true, amountPaisa: true },
  });
  const day0 = today();
  const rows = suppliers
    .map((s) => {
      const b = bal.get(s.id)!;
      const ages = ageing(b.openDebits.map((d) => ({ days: daysBetween(ymd(d.at)!, day0), amountPaisa: d.leftPaisa })));
      const last = lastPayments.find((p) => p.supplierId === s.id);
      return {
        supplier: s.name,
        phone: s.phone,
        balance: str(b.balancePaisa),
        ...Object.fromEntries(AGEING_BUCKETS.map((k) => [`age_${k}`, str(ages[k])])),
        oldestDays: b.oldestUnpaidDays,
        lastPaymentOn: last ? ymd(last.occurredAt) : null,
        lastPayment: last ? str(-last.amountPaisa) : null,
      } as Record<string, Cell>;
    })
    .filter((r) => r['balance'] !== '0' || r['lastPaymentOn'] !== null);
  const columns = [col('supplier', 'Supplier'), col('phone', 'Phone'), col('balance', 'Udhaar', 'money'), ...AGEING_COLUMNS, col('oldestDays', 'Oldest (days)', 'int'), col('lastPaymentOn', 'Last payment', 'date'), col('lastPayment', 'Amount', 'money')];
  return {
    name: 'supplier-ageing',
    title: 'Supplier Ageing',
    subtitle: `All suppliers · as of ${day(day0)}`,
    columns,
    rows,
    totals: totalsOfColumns(columns, rows, ['oldestDays', 'lastPayment']),
    notes: ['Payments clear the oldest purchases first (FIFO); age = days since the purchase.'],
  };
}

// ─── 6. Receivables ageing ──────────────────────────────────────────────────

async function receivablesAgeing(c: Ctx): Promise<Omit<Report, 'generatedAt' | 'filters'>> {
  ownerOnly(c.a);
  const projects = await projectsFor(c);
  const rows: Array<Record<string, Cell>> = [];
  for (const p of projects) {
    const m = await moneyOf(c.tx, c.a.tenantId, p);
    if (m.invoiced === 0n) continue;
    rows.push({
      project: p.code,
      name: p.name,
      client: p.client?.name ?? null,
      invoiced: str(m.invoiced),
      received: str(m.received),
      outstanding: str(m.outstanding),
      ...Object.fromEntries(AGEING_BUCKETS.map((k) => [`age_${k}`, str(m.ageing[k])])),
      overdue: str(m.overdue),
      oldestOverdueDays: m.oldestOverdueDays,
      pendingCheques: str(m.pendingCheques),
    });
  }
  const columns = [
    col('project', 'Code'),
    col('name', 'Project'),
    col('client', 'Client'),
    col('invoiced', 'Invoiced', 'money'),
    col('received', 'Received', 'money'),
    col('outstanding', 'Outstanding', 'money'),
    ...AGEING_COLUMNS,
    col('overdue', 'Overdue', 'money'),
    col('oldestOverdueDays', 'Oldest overdue (days)', 'int'),
    col('pendingCheques', 'Cheques pending', 'money'),
  ];
  return {
    name: 'receivables-ageing',
    title: 'Receivables Ageing',
    subtitle: `${c.projectName} · as of ${day(today())}`,
    columns,
    rows,
    totals: totalsOfColumns(columns, rows, ['oldestOverdueDays']),
    notes: ['Age = days since the invoice was issued; outstanding includes cheques not cleared yet.'],
  };
}

// ─── 7. Stock valuation ─────────────────────────────────────────────────────

async function stockValuation(c: Ctx): Promise<Omit<Report, 'generatedAt' | 'filters'>> {
  ownerOnly(c.a);
  const locations = await c.tx.stockLocation.findMany({
    where: { tenantId: c.a.tenantId, ...(c.q.projectId ? { projectId: c.q.projectId } : {}) },
    select: { id: true, name: true, type: true },
    orderBy: [{ type: 'desc' }, { name: 'asc' }],
  });
  const groups = await c.tx.stockMovement.groupBy({
    by: ['locationId', 'materialId', 'ownerSupplied'],
    where: { tenantId: c.a.tenantId, locationId: { in: locations.map((l) => l.id) }, occurredAt: { lt: pktDayEnd(c.q.to ?? today()) } },
    _sum: { quantity: true, valuePaisa: true },
  });
  const materials = new Map((await c.tx.material.findMany({ where: { tenantId: c.a.tenantId, id: { in: [...new Set(groups.map((g) => g.materialId))] } }, select: { id: true, name: true, unit: true } })).map((m) => [m.id, m]));
  const rows: Array<Record<string, Cell>> = [];
  for (const l of locations) {
    for (const g of groups.filter((x) => x.locationId === l.id && !x.ownerSupplied)) {
      const qty = g._sum.quantity ?? ZERO;
      if (qty.lte(0)) continue;
      const value = g._sum.valuePaisa ?? 0n;
      const owner = groups.find((x) => x.locationId === l.id && x.materialId === g.materialId && x.ownerSupplied);
      const m = materials.get(g.materialId)!;
      rows.push({
        location: l.type === 'TRANSIT' ? 'In transit' : l.name,
        kind: l.type === 'STORE' ? 'Store' : l.type === 'SITE' ? 'Site' : 'Transit',
        material: m.name,
        unit: m.unit,
        quantity: qn(qty),
        avgCost: str(avgOf(qty, value)),
        value: str(value),
        ownerQuantity: owner ? qn(owner._sum.quantity ?? ZERO) : 0,
      });
    }
  }
  const columns = [
    col('location', 'Location'),
    col('kind', 'Type'),
    col('material', 'Material'),
    col('unit', 'Unit'),
    col('quantity', 'Quantity', 'qty'),
    col('avgCost', 'Average cost', 'money'),
    col('value', 'Value', 'money'),
    col('ownerQuantity', 'Owner-supplied qty (no value)', 'qty'),
  ];
  return {
    name: 'stock-valuation',
    title: 'Stock Valuation',
    subtitle: `${c.projectName === 'All projects' ? 'Store + sites + transit' : c.projectName} · as of ${day(c.q.to ?? today())}`,
    columns,
    rows,
    totals: { ...Object.fromEntries(columns.map((x) => [x.key, null])), value: sumCol(rows, 'value') },
    notes: ['Quantity × weighted-average cost per location; owner-supplied stock carries no value.'],
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const BUILDERS: Record<ReportName, (c: Ctx) => Promise<Omit<Report, 'generatedAt' | 'filters'>>> = {
  'project-summary': projectSummary,
  'material-audit': materialAudit,
  'labor-peshgi': laborPeshgi,
  'cash-book': cashBook,
  'supplier-ageing': supplierAgeing,
  'receivables-ageing': receivablesAgeing,
  'stock-valuation': stockValuation,
};

export async function buildReport(tx: Tx, a: ReadActor, name: ReportName, q: ReportQuery): Promise<Report> {
  const project = q.projectId ? await findProjectFor(tx, a, q.projectId) : null;
  const built = await BUILDERS[name]({ tx, a, q, projectName: project ? `${project.code} ${project.name}` : 'All projects' });
  return { ...built, generatedAt: new Date().toISOString(), filters: { projectId: q.projectId ?? null, from: q.from ?? null, to: q.to ?? null } };
}

export async function runReport(name: ReportName, q: ReportQuery) {
  const a = readActor();
  if (a.role === 'MUNSHI') throw new Forbidden('FORBIDDEN', 'Reports are for the office');
  const { report, company } = await withTenant(a.tenantId, async (tx) => ({
    report: await buildReport(tx, a, name, q),
    company: q.format === 'pdf' ? await letterhead(tx, a.tenantId) : null,
  }));
  if (q.format === 'json') return report;
  const buffer = await renderReport(report, q.format, company);
  return withTenant(a.tenantId, (tx) => storeReport(tx, a, report, q.format as Exclude<ReportQuery['format'], 'json'>, buffer));
}
