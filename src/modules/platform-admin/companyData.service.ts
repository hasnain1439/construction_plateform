/**
 * Read-only look into one company's data for the platform super admin: its projects, its
 * team and phones, and its activity and money. Nothing here changes company data.
 *
 * Every look is written to the audit log (`admin.company_data_viewed`, shown in the company's
 * timeline) — at most once per admin, company and section every 10 minutes, so paging
 * around does not flood the log.
 */
import { prismaAdmin } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/withTenant.js';
import { NotFound } from '../../core/errors/AppError.js';
import { formatDateOnly } from '../../core/utils/dates.js';
import { totalsOf } from '../cashbook/cash.js';
import { supplierBalances } from '../procurement/supplierLedger.service.js';
import { adminId, auditAdmin } from './platformAdmin.shared.js';

export type CompanySection = 'projects' | 'team' | 'activity';

const VIEW_AUDIT_EVERY_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** Issued invoices — drafts and cancelled ones are not money owed. */
const BILLED = ['ISSUED', 'PARTLY_PAID', 'PAID'] as const;
const OPEN = ['ISSUED', 'PARTLY_PAID'] as const;

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const day = (d: Date | null | undefined) => (d ? formatDateOnly(d) : null);
const str = (v: bigint | null | undefined) => (v ?? 0n).toString();

/** Runs `read` for an existing company and records the look in its audit log. */
async function look<T>(tenantId: string, section: CompanySection, read: (tx: Tx) => Promise<T>): Promise<T> {
  return prismaAdmin.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw new NotFound('TENANT_NOT_FOUND', 'Company not found');
    const recent = await tx.auditLog.findFirst({
      where: {
        tenantId,
        actorType: 'PLATFORM_ADMIN',
        actorId: adminId(),
        action: 'admin.company_data_viewed',
        createdAt: { gte: new Date(Date.now() - VIEW_AUDIT_EVERY_MS) },
        details: { path: ['section'], equals: section },
      },
      select: { id: true },
    });
    if (!recent) await auditAdmin(tx, { tenantId, action: 'admin.company_data_viewed', entityType: 'Tenant', entityId: tenantId, details: { section } });
    return read(tx);
  });
}

/** Per project: money billed / received / still owed (issued invoices, cleared payments). */
async function projectMoney(tx: Tx, tenantId: string) {
  const [billed, open, received] = await Promise.all([
    tx.invoice.groupBy({ by: ['projectId'], where: { tenantId, status: { in: [...BILLED] } }, _sum: { totalPaisa: true } }),
    tx.invoice.groupBy({ by: ['projectId'], where: { tenantId, status: { in: [...OPEN] } }, _sum: { balancePaisa: true } }),
    tx.clientPayment.groupBy({ by: ['projectId'], where: { tenantId, status: 'CLEARED' }, _sum: { amountPaisa: true } }),
  ]);
  const of = <R extends { projectId: string }>(rows: R[], pick: (r: R) => bigint | null | undefined) => new Map(rows.map((r) => [r.projectId, pick(r) ?? 0n]));
  return {
    billed: of(billed, (r) => r._sum.totalPaisa),
    outstanding: of(open, (r) => r._sum.balancePaisa),
    received: of(received, (r) => r._sum.amountPaisa),
  };
}

export function companyProjects(tenantId: string) {
  return look(tenantId, 'projects', async (tx) => {
    const projects = await tx.project.findMany({
      where: { tenantId },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        _count: { select: { userAccess: true, projectWorkers: { where: { isActive: true } }, dailyLogs: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    const money = await projectMoney(tx, tenantId);
    const lastLogs = await tx.dailyLog.groupBy({ by: ['projectId'], where: { tenantId }, _max: { logDate: true } });
    const lastLog = new Map(lastLogs.map((l) => [l.projectId, l._max.logDate]));
    // Running work first, then drafts, then finished ones — newest first within each.
    const rank = (s: string) => ['ACTIVE', 'CLOSEOUT', 'READ_ONLY', 'DRAFT', 'HANDED_OVER', 'CLOSED'].indexOf(s);
    projects.sort((x, y) => rank(x.status) - rank(y.status) || y.createdAt.getTime() - x.createdAt.getTime());
    return projects.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      client: p.client,
      city: p.city,
      siteAddress: p.siteAddress,
      startDate: day(p.startDate),
      endDate: day(p.endDate),
      contractValuePaisa: p.contractValuePaisa === null ? null : p.contractValuePaisa.toString(),
      billedPaisa: str(money.billed.get(p.id)),
      receivedPaisa: str(money.received.get(p.id)),
      outstandingPaisa: str(money.outstanding.get(p.id)),
      teamMembers: p._count.userAccess,
      activeWorkers: p._count.projectWorkers,
      dailyLogs: p._count.dailyLogs,
      lastDailyLog: day(lastLog.get(p.id)),
      createdAt: p.createdAt.toISOString(),
    }));
  });
}

export function companyTeam(tenantId: string) {
  return look(tenantId, 'team', async (tx) => {
    const [users, access, devices, pendingInvites] = await Promise.all([
      tx.user.findMany({ where: { tenantId, isSystem: false }, orderBy: [{ status: 'asc' }, { role: 'asc' }, { name: 'asc' }] }),
      tx.userProjectAccess.groupBy({ by: ['userId'], where: { tenantId }, _count: { _all: true } }),
      tx.device.findMany({ where: { tenantId }, include: { user: { select: { id: true, name: true, role: true } } }, orderBy: [{ lastActiveAt: 'desc' }] }),
      tx.invitation.count({ where: { tenantId, status: 'PENDING' } }),
    ]);
    const projectsOf = new Map(access.map((a) => [a.userId, a._count._all]));
    return {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        phone: u.phone,
        email: u.email,
        status: u.status,
        canSeeFinancials: u.canSeeFinancials,
        projects: u.role === 'THEKEDAR' ? null : (projectsOf.get(u.id) ?? 0),
        lastLoginAt: iso(u.lastLoginAt),
        createdAt: u.createdAt.toISOString(),
      })),
      devices: devices.map((d) => ({
        id: d.id,
        user: d.user,
        platform: d.platform,
        model: d.model,
        appVersion: d.appVersion,
        lastActiveAt: d.lastActiveAt.toISOString(),
        lastSyncAt: iso(d.lastSyncAt),
        pendingUploads: d.pendingUploads,
        revoked: d.revokedAt !== null,
      })),
      pendingInvites,
    };
  });
}

export function companyActivity(tenantId: string, now = new Date()) {
  return look(tenantId, 'activity', async (tx) => {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const [byStatus, workers, suppliers, attendance, purchases, dispatches, expenses, usage, dailyLogs, invoices, payments, lastUserAction, lastLogin] = await Promise.all([
      tx.project.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
      tx.worker.count({ where: { tenantId, isActive: true } }),
      tx.supplier.findMany({ where: { tenantId }, select: { id: true } }),
      tx.attendance.count({ where: { tenantId, date: { gte: since } } }),
      tx.purchase.aggregate({ where: { tenantId, purchaseDate: { gte: since } }, _count: { _all: true }, _sum: { totalPaisa: true } }),
      tx.dispatch.count({ where: { tenantId, dispatchedAt: { gte: since } } }),
      tx.cashEntry.aggregate({ where: { tenantId, type: 'EXPENSE', occurredAt: { gte: since } }, _count: { _all: true }, _sum: { amountPaisa: true } }),
      tx.materialUsage.count({ where: { tenantId, usageDate: { gte: since } } }),
      tx.dailyLog.count({ where: { tenantId, logDate: { gte: since } } }),
      tx.invoice.aggregate({ where: { tenantId, status: { in: [...BILLED] }, issueDate: { gte: since } }, _count: { _all: true }, _sum: { totalPaisa: true } }),
      tx.clientPayment.aggregate({ where: { tenantId, status: 'CLEARED', receivedOn: { gte: since } }, _count: { _all: true }, _sum: { amountPaisa: true } }),
      tx.auditLog.findFirst({ where: { tenantId, actorType: 'USER' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      tx.user.aggregate({ where: { tenantId }, _max: { lastLoginAt: true } }),
    ]);

    // Money right now (same definitions as the company's own dashboard).
    const money = await projectMoney(tx, tenantId);
    const total = (m: Map<string, bigint>) => [...m.values()].reduce((s, v) => s + v, 0n);
    const owed = [...(await supplierBalances(tx, tenantId, suppliers.map((s) => s.id), now)).values()].reduce((s, b) => s + (b.balancePaisa > 0n ? b.balancePaisa : 0n), 0n);
    const accounts = await tx.cashAccount.findMany({ where: { tenantId, isActive: true }, select: { id: true } });
    const cash = [...(await totalsOf(tx, tenantId, accounts.map((a) => a.id))).values()].reduce((s, t) => s + t.balancePaisa, 0n);

    return {
      asOf: now.toISOString(),
      lastActivityAt: iso(lastUserAction?.createdAt),
      lastLoginAt: iso(lastLogin._max.lastLoginAt),
      projectsByStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
      activeWorkers: workers,
      last30Days: {
        from: formatDateOnly(since),
        hazriMarks: attendance,
        purchases: { count: purchases._count._all, totalPaisa: str(purchases._sum.totalPaisa) },
        dispatches,
        kharcha: { count: expenses._count._all, totalPaisa: str(-(expenses._sum.amountPaisa ?? 0n)) },
        materialUsageEntries: usage,
        dailyLogs,
        invoicesIssued: { count: invoices._count._all, totalPaisa: str(invoices._sum.totalPaisa) },
        paymentsReceived: { count: payments._count._all, totalPaisa: str(payments._sum.amountPaisa) },
      },
      money: {
        billedPaisa: str(total(money.billed)),
        receivedPaisa: str(total(money.received)),
        receivablesPaisa: str(total(money.outstanding)),
        supplierUdhaarPaisa: str(owed),
        cashWithSiteStaffPaisa: str(cash),
      },
    };
  });
}
