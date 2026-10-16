/**
 * Step 14 · daily control alert check (06:30 Asia/Karachi, after the equipment accrual and the
 * billing job so costs are current). For every ACTIVE company with control alerts on, every
 * ACTIVE / CLOSEOUT project is evaluated by the alert engine (modules/control/alerts/engine.ts):
 * material overuse, milestone behind plan / late, quota exhausted, spend ahead of progress and any
 * plug-in rule (Step 16 EQUIPMENT_IDLE). One transaction per project (tenant RLS context); a
 * failing project is logged and skipped. Safe to repeat: findings update their open alert,
 * notifications are deduplicated per alert and user.
 */
import { logger } from '../config/logger.js';
import { prismaAdmin } from '../core/db/prisma.js';
import { withTenant } from '../core/db/withTenant.js';
import { addResult, emptyResult, evaluateProject, type EngineResult } from '../modules/control/alerts/engine.js';
import { controlSettings } from '../modules/control/control.shared.js';

export async function runControlAlerts(now = new Date(), only?: { tenantId?: string }): Promise<{ companies: string[]; projects: number; opened: number; updated: number; resolved: number; notified: number; failed: number }> {
  const tenants = await prismaAdmin.tenantSettings.findMany({ where: { controlAlertsEnabled: true, tenant: { status: 'ACTIVE' }, ...(only?.tenantId ? { tenantId: only.tenantId } : {}) }, select: { tenantId: true } });
  let total: EngineResult = emptyResult();
  let failed = 0;
  const companies: string[] = [];
  for (const t of tenants) {
    const projects = await prismaAdmin.project.findMany({ where: { tenantId: t.tenantId, status: { in: ['ACTIVE', 'CLOSEOUT'] } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    if (!projects.length) continue;
    companies.push(t.tenantId);
    const memo = new Map<string, unknown>();
    for (const p of projects) {
      try {
        const r = await withTenant(
          t.tenantId,
          async (tx) => {
            const project = await tx.project.findUniqueOrThrow({ where: { id: p.id } });
            return evaluateProject(tx, t.tenantId, project, { now, actorId: null, settings: await controlSettings(tx, t.tenantId), memo });
          },
          { timeout: 120_000 },
        );
        total = addResult(total, r);
      } catch (err) {
        failed += 1;
        logger.error({ err, job: 'control-alerts', tenantId: t.tenantId, projectId: p.id }, 'control alert check failed for a project');
      }
    }
  }
  return { companies, projects: total.projects, opened: total.opened, updated: total.updated, resolved: total.resolved, notified: total.notified, failed };
}
