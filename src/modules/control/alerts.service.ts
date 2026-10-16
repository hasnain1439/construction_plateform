/**
 * Step 14 · control alerts API: list (project / company), the rule registry, run now, thresholds.
 * Alert texts are rendered in the reader's language from the stored key + params; they never
 * carry money. A caller sees an alert only for projects in their control.view scope and rules
 * whose permission + money permissions they hold (same test as the recipients).
 */
import { accessOf, assertPerm, scopeAll } from '../../core/auth/access.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import type { ControlAlert, Prisma } from '../../generated/prisma/client.js';
import type { Lang } from '../../core/i18n/index.js';
import { readerLang } from '../notifications/notifications.service.js';
import { renderNotification } from '../notifications/texts.js';
import { findProjectFor, projectScope } from '../projects/access.js';
import { addResult, emptyResult, evaluateProject, mayReceiveRule } from './alerts/engine.js';
import { alertRule, alertRules, ruleStatus } from './alerts/registry.js';
import type { AlertsQuery, ControlSettingsInput, ProjectAlertsQuery, RunAlertsInput } from './control.schema.js';
import { audit, CONTROL_MANAGE, CONTROL_VIEW, controlCaller, controlProject, controlSettings, type ControlCaller, type ControlSettings } from './control.shared.js';

type AlertRow = ControlAlert & { project: { id: string; code: string; name: string } | null };

export function alertDto(a: AlertRow, lang: Lang) {
  const text = renderNotification(lang, a.textKey, a.params);
  return {
    id: a.id,
    rule: a.rule,
    severity: a.severity,
    status: a.status,
    project: a.project,
    title: text?.title ?? a.rule,
    body: text?.body ?? '',
    refType: a.refType,
    refId: a.refId,
    details: a.details,
    actionUrl: a.actionUrl,
    openedAt: a.openedAt.toISOString(),
    lastSeenAt: a.lastSeenAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    notifiedAt: a.notifiedAt?.toISOString() ?? null,
    occurrences: a.occurrences,
  };
}

/** Rules (registry keys) whose alerts the caller may see on `projectId`. */
export function visibleRule(c: ControlCaller, rule: string, projectId: string | null, assigned: (p: string) => boolean): boolean {
  const r = alertRule(rule) ?? { permission: CONTROL_VIEW, moneyPermissions: [] };
  const a = accessOf(c);
  if (!a.has.has(CONTROL_VIEW) && !a.owner) return false;
  return mayReceiveRule(a, r, projectId, assigned);
}

const statusWhere = (s: 'OPEN' | 'RESOLVED' | 'ALL'): Prisma.ControlAlertWhereInput => (s === 'ALL' ? {} : { status: s });
const include = { project: { select: { id: true, code: true, name: true } } } as const;

async function assignedSet(tx: Tx, c: ControlCaller): Promise<Set<string>> {
  const rows = await tx.userProjectAccess.findMany({ where: { tenantId: c.tenantId, userId: c.userId }, select: { projectId: true } });
  return new Set(rows.map((r) => r.projectId));
}

/** Open alerts the caller may see (dashboard, summary). */
export async function visibleAlerts(tx: Tx, c: ControlCaller, where: Prisma.ControlAlertWhereInput, take?: number): Promise<AlertRow[]> {
  const mine = await assignedSet(tx, c);
  const rows = await tx.controlAlert.findMany({
    where: { tenantId: c.tenantId, ...where, project: projectScope(c, CONTROL_VIEW) },
    include,
    orderBy: [{ lastSeenAt: 'desc' }],
    take: 500,
  });
  const out = rows.filter((a) => visibleRule(c, a.rule, a.projectId, (p) => mine.has(p)));
  return take ? out.slice(0, take) : out;
}

export async function projectAlerts(projectId: string, query: ProjectAlertsQuery) {
  const c = controlCaller();
  return withTenant(c.tenantId, async (tx) => {
    const project = await controlProject(tx, c, projectId);
    const rows = await visibleAlerts(tx, c, { projectId: project.id, ...statusWhere(query.status) });
    const lang = await readerLang(tx, c.userId);
    return { items: rows.map((a) => alertDto(a, lang)) };
  });
}

export async function listAlerts(query: AlertsQuery) {
  const c = controlCaller();
  assertPerm(CONTROL_VIEW, c);
  return withTenant(c.tenantId, async (tx) => {
    if (query.projectId) await findProjectFor(tx, c, query.projectId, CONTROL_VIEW);
    const rows = await visibleAlerts(tx, c, {
      ...statusWhere(query.status),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.rule ? { rule: query.rule } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
    });
    const lang = await readerLang(tx, c.userId);
    const { skip, take } = skipTake(query);
    return { data: rows.slice(skip, skip + take).map((a) => alertDto(a, lang)), meta: pageMeta(query, rows.length) };
  });
}

export async function listRules() {
  const c = controlCaller();
  assertPerm(CONTROL_VIEW, c);
  return withTenant(c.tenantId, async (tx) => {
    const s = await controlSettings(tx, c.tenantId);
    const tenantSettings = await tx.tenantSettings.findUnique({ where: { tenantId: c.tenantId }, select: { missingLogAlertTime: true } });
    const value = (k: string | null) => {
      if (!k) return null;
      if (k in s) return s[k as keyof ControlSettings];
      if (k === 'missingLogAlertTime') return tenantSettings?.missingLogAlertTime ?? null;
      return null;
    };
    return alertRules().map((r) => ({
      rule: r.rule,
      source: r.source,
      trigger: r.trigger,
      severity: r.severity,
      permission: r.permission,
      moneyPermissions: r.moneyPermissions,
      threshold: r.thresholdSetting ? { setting: r.thresholdSetting, value: value(r.thresholdSetting) } : null,
      dedupe: { key: r.dedupeKey, renotifyHours: r.renotifyHours },
      actionUrl: r.actionUrl(':projectId'),
      status: ruleStatus(r, s),
      description: r.description,
    }));
  });
}

export async function runAlerts(input: RunAlertsInput) {
  const c = controlCaller();
  assertPerm(CONTROL_MANAGE, c);
  for (const r of input.rules ?? []) {
    const rule = alertRule(r);
    if (!rule || !rule.evaluate) throw new BadRequest('UNKNOWN_RULE', `"${r}" is not a rule the engine can run`, { rule: r });
  }
  return withTenant(
    c.tenantId,
    async (tx) => {
      const settings = await controlSettings(tx, c.tenantId);
      if (!settings.controlAlertsEnabled) throw new Conflict('ALERTS_DISABLED', 'Control alerts are switched off in Alerts & Limits');
      const projects = input.projectId
        ? [await findProjectFor(tx, c, input.projectId, CONTROL_VIEW)]
        : await tx.project.findMany({ where: { tenantId: c.tenantId, status: { in: ['ACTIVE', 'CLOSEOUT'] } }, orderBy: { createdAt: 'asc' } });
      let result = emptyResult();
      const memo = new Map<string, unknown>();
      const ranAt = new Date();
      for (const p of projects) result = addResult(result, await evaluateProject(tx, c.tenantId, p, { ...(input.rules ? { rules: input.rules } : {}), now: ranAt, actorId: null, settings, memo }));
      await audit(tx, c, 'control.alerts_run', 'Tenant', c.tenantId, { projectId: input.projectId ?? null, rules: input.rules ?? null, projects: result.projects, opened: result.opened, updated: result.updated, resolved: result.resolved, notified: result.notified });
      const rows = result.alertIds.length ? await tx.controlAlert.findMany({ where: { tenantId: c.tenantId, id: { in: result.alertIds } }, include, orderBy: { lastSeenAt: 'desc' } }) : [];
      const lang = await readerLang(tx, c.userId);
      return {
        ranAt: ranAt.toISOString(),
        projects: result.projects,
        evaluated: result.evaluated,
        opened: result.opened,
        updated: result.updated,
        resolved: result.resolved,
        notified: result.notified,
        alerts: rows.map((a) => alertDto(a, lang)),
      };
    },
    { timeout: 120_000 },
  );
}

// ─── Thresholds ─────────────────────────────────────────────────────────────

export async function getSettings() {
  const c = controlCaller();
  assertPerm(CONTROL_VIEW, c);
  return withTenant(c.tenantId, (tx) => controlSettings(tx, c.tenantId));
}

export async function updateSettings(input: ControlSettingsInput) {
  const c = controlCaller();
  assertPerm(CONTROL_MANAGE, c);
  return withTenant(c.tenantId, async (tx) => {
    const before = await controlSettings(tx, c.tenantId);
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<ControlSettings>;
    await tx.tenantSettings.upsert({ where: { tenantId: c.tenantId }, create: { tenantId: c.tenantId, ...data }, update: data });
    const after = await controlSettings(tx, c.tenantId);
    const changed = Object.keys(data) as Array<keyof ControlSettings>;
    await audit(tx, c, 'control.settings_update', 'TenantSettings', c.tenantId, {
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after[k]])),
    });
    return after;
  });
}

/** Unused-scope guard for the summary: does the caller see every project? */
export const seesAllProjects = (c: ControlCaller) => scopeAll(CONTROL_VIEW, c);
