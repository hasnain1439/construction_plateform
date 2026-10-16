/**
 * Step 14 · the control alert engine. Evaluates registered rules for a project, keeps one
 * ControlAlert row per (tenant, dedupeKey) and notifies the people who may act on it.
 *
 *   new finding            → row OPEN + notification CONTROL_ALERT
 *   finding on an OPEN row → lastSeenAt / numbers / severity refreshed; notified again after the
 *                            rule's renotifyHours, or at once when it escalates to CRITICAL
 *   finding on a RESOLVED  → reopened (occurrences + 1) + notified
 *   OPEN row not found     → RESOLVED (only for the rules + project evaluated)
 *
 * Recipients are chosen by PERMISSION: active users holding the rule's permission with the project
 * in scope (ASSIGNED / ALL projects) and every money permission of the rule — the owner always.
 * The notification type CONTROL_ALERT never reaches a Munshi (notifications MUNSHI_TYPES).
 * Runs inside the caller's transaction (on-write triggers) or per project in the daily job.
 */
import type { Access } from '../../../core/auth/access.js';
import { loadAccess } from '../../../core/auth/accessLoader.js';
import { CATALOG_BY_KEY } from '../../../core/auth/permissionCatalog.js';
import type { Tx } from '../../../core/db/withTenant.js';
import type { ControlAlert, NotificationSeverity, Prisma, Project } from '../../../generated/prisma/client.js';
import { notify } from '../../notifications/notifications.service.js';
import { controlSettings, today as todayPk, type ControlSettings } from '../control.shared.js';
import { evaluableRules, type AlertRule, type Finding, type RuleContext } from './registry.js';
import './rules/index.js';

export interface EngineResult {
  projects: number;
  evaluated: number;
  opened: number;
  updated: number;
  resolved: number;
  notified: number;
  alertIds: string[];
}

export const emptyResult = (): EngineResult => ({ projects: 0, evaluated: 0, opened: 0, updated: 0, resolved: 0, notified: 0, alertIds: [] });

export function addResult(a: EngineResult, b: EngineResult): EngineResult {
  return {
    projects: a.projects + b.projects,
    evaluated: a.evaluated + b.evaluated,
    opened: a.opened + b.opened,
    updated: a.updated + b.updated,
    resolved: a.resolved + b.resolved,
    notified: a.notified + b.notified,
    alertIds: [...a.alertIds, ...b.alertIds],
  };
}

// ─── Recipients by permission ───────────────────────────────────────────────

interface Member {
  id: string;
  access: Access;
  projects: Set<string>;
}

async function members(tx: Tx, tenantId: string, memo: Map<string, unknown>): Promise<Member[]> {
  const hit = memo.get('members') as Member[] | undefined;
  if (hit) return hit;
  const users = await tx.user.findMany({
    where: { tenantId, status: 'ACTIVE', isSystem: false },
    select: { id: true, tenantId: true, role: true, roleId: true, canSeeFinancials: true, projectAccess: { select: { projectId: true } } },
  });
  const out: Member[] = [];
  for (const u of users) {
    out.push({ id: u.id, access: await loadAccess(tx, { id: u.id, tenantId: u.tenantId, role: u.role, roleId: u.roleId, canSeeFinancials: u.canSeeFinancials }), projects: new Set(u.projectAccess.map((p) => p.projectId)) });
  }
  memo.set('members', out);
  return out;
}

/** May this access see / receive alerts of `rule` on `projectId`? */
export function mayReceiveRule(a: Pick<Access, 'owner' | 'has' | 'scopes'>, rule: Pick<AlertRule, 'permission' | 'moneyPermissions'>, projectId: string | null, assigned: (projectId: string) => boolean): boolean {
  if (a.owner) return true;
  if (!a.has.has(rule.permission) || !rule.moneyPermissions.every((k) => a.has.has(k))) return false;
  if (!projectId || !CATALOG_BY_KEY.get(rule.permission)?.scoped) return true;
  return a.scopes[rule.permission] === 'ALL_PROJECTS' || assigned(projectId);
}

export async function recipientsFor(tx: Tx, tenantId: string, projectId: string, rule: AlertRule, memo: Map<string, unknown> = new Map()): Promise<string[]> {
  return (await members(tx, tenantId, memo)).filter((m) => mayReceiveRule(m.access, rule, projectId, (p) => m.projects.has(p))).map((m) => m.id);
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

const RANK: Record<NotificationSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const json = (v: unknown) => v as Prisma.InputJsonValue;

export interface EvaluateOptions {
  /** Only these rule keys (default: every evaluable rule). */
  rules?: string[];
  now?: Date;
  /** Who caused it (skipped as a recipient unless CRITICAL); null = the job. */
  actorId?: string | null;
  settings?: ControlSettings;
  /** Shared across projects of one run (members' access). */
  memo?: Map<string, unknown>;
}

export async function evaluateProject(tx: Tx, tenantId: string, project: Project, opts: EvaluateOptions = {}): Promise<EngineResult> {
  const result = emptyResult();
  const settings = opts.settings ?? (await controlSettings(tx, tenantId));
  if (!settings.controlAlertsEnabled) return result;
  const now = opts.now ?? new Date();
  const runMemo = opts.memo ?? new Map<string, unknown>();
  const ctx: RuleContext = { tx, tenantId, project, settings, today: todayPk(), now, memo: new Map() };
  result.projects = 1;
  for (const rule of evaluableRules(opts.rules)) {
    const findings = await rule.evaluate!(ctx);
    result.evaluated += findings.length;
    const existing = new Map(
      (await tx.controlAlert.findMany({ where: { tenantId, OR: [{ projectId: project.id, rule: rule.rule }, { dedupeKey: { in: findings.map((f) => f.dedupeKey) } }] } })).map((a) => [a.dedupeKey, a]),
    );
    const seen = new Set<string>();
    for (const f of findings) {
      if (seen.has(f.dedupeKey)) continue;
      seen.add(f.dedupeKey);
      const row = existing.get(f.dedupeKey);
      const data = {
        severity: f.severity,
        refType: f.refType,
        refId: f.refId,
        textKey: f.text.key,
        params: json(f.text.params),
        details: json(f.details),
        actionUrl: f.actionUrl ?? rule.actionUrl(project.id),
        lastSeenAt: now,
      };
      let alert: ControlAlert;
      let notifyNow: boolean;
      let dedupeMs = rule.renotifyHours * 3_600_000;
      if (!row) {
        alert = await tx.controlAlert.create({ data: { tenantId, projectId: project.id, rule: rule.rule, dedupeKey: f.dedupeKey, status: 'OPEN', openedAt: now, ...data } });
        result.opened += 1;
        notifyNow = true;
      } else if (row.status === 'RESOLVED') {
        alert = await tx.controlAlert.update({ where: { id: row.id }, data: { ...data, status: 'OPEN', resolvedAt: null, openedAt: now, occurrences: row.occurrences + 1 } });
        result.opened += 1;
        notifyNow = true;
        dedupeMs = 1; // a new occurrence is always news
      } else {
        alert = await tx.controlAlert.update({ where: { id: row.id }, data });
        result.updated += 1;
        const escalated = RANK[f.severity] > RANK[row.severity];
        if (escalated) dedupeMs = 1; // WARNING → CRITICAL is always news
        notifyNow = escalated || !row.notifiedAt || now.getTime() - row.notifiedAt.getTime() >= rule.renotifyHours * 3_600_000;
      }
      result.alertIds.push(alert.id);
      if (notifyNow && rule.notify !== false) {
        const to = await recipientsFor(tx, tenantId, project.id, rule, runMemo);
        const sent = to.length
          ? await notify(tx, {
              tenantId,
              recipients: [{ userIds: to }],
              type: 'CONTROL_ALERT',
              severity: f.severity,
              text: f.text,
              projectId: project.id,
              ref: { type: 'CONTROL_ALERT', id: alert.id },
              actionUrl: alert.actionUrl,
              ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
              at: now,
              dedupeMs,
            })
          : [];
        if (sent.length) {
          result.notified += sent.length;
          await tx.controlAlert.update({ where: { id: alert.id }, data: { notifiedAt: now } });
        }
      }
    }
    const stale = [...existing.values()].filter((a) => a.status === 'OPEN' && a.projectId === project.id && a.rule === rule.rule && !seen.has(a.dedupeKey));
    if (stale.length) {
      await tx.controlAlert.updateMany({ where: { id: { in: stale.map((a) => a.id) } }, data: { status: 'RESOLVED', resolvedAt: now } });
      result.resolved += stale.length;
    }
  }
  return result;
}

/**
 * On-write trigger (usage, milestone progress, stock count): evaluates `rules` for the project in
 * the caller's transaction (rules only read; the engine writes ControlAlert rows + notifications).
 */
export async function triggerControlAlerts(tx: Tx, tenantId: string, projectId: string, rules: string[], opts: { at?: Date } = {}): Promise<void> {
  if (opts.at) return; // back-dated (seed / import): the daily job catches up
  const project = await tx.project.findFirst({ where: { tenantId, id: projectId } });
  if (!project || (project.status !== 'ACTIVE' && project.status !== 'CLOSEOUT')) return;
  await evaluateProject(tx, tenantId, project, { rules });
}

export type { Finding };
