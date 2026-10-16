/**
 * Step 14 · the alert rule registry. A rule says what it finds (evaluate), how bad it is, who may
 * receive / see it (permission + money permissions, project scope), where it links to, how it is
 * deduplicated and when it runs. The engine (engine.ts) stores findings as ControlAlert rows and
 * notifies; rules never write anything themselves.
 *
 * Plug-in rules (Step 16 part 2 · EQUIPMENT_IDLE): call `registerAlertRule({...})` from your module
 * with an `evaluate` function and import that file once from ./rules/index.ts. Registering a rule
 * key that already exists replaces it (the placeholder becomes the real rule). Rule keys are plain
 * strings in the database — no migration needed.
 */
import type { Tx } from '../../../core/db/withTenant.js';
import type { NotificationSeverity, Project } from '../../../generated/prisma/client.js';
import type { NotificationTextKey, NotificationParams } from '../../notifications/texts.js';
import type { ControlSettings } from '../control.shared.js';

export type AlertTrigger = 'DAILY' | 'ON_WRITE' | 'DAILY_AND_ON_WRITE' | 'EXTERNAL_JOB';

/** One thing a rule found (one ControlAlert row per dedupeKey). */
export interface Finding {
  /** Stable key, unique per tenant, e.g. `MATERIAL_OVERUSE:<projectId>:<materialId>`. */
  dedupeKey: string;
  refType: string;
  refId: string | null;
  severity: NotificationSeverity;
  /** Notification text (core/i18n catalogue `notif.<key>.title/body`) — never money. */
  text: { key: NotificationTextKey; params: NotificationParams };
  /** Rule numbers for the UI (quantities / percentages / dates — never money). */
  details: Record<string, string | number | boolean | null>;
  /** Overrides the rule's link (e.g. a rental page). */
  actionUrl?: string;
}

export interface RuleContext {
  tx: Tx;
  tenantId: string;
  project: Project;
  settings: ControlSettings;
  /** YYYY-MM-DD, Asia/Karachi */
  today: string;
  now: Date;
  /** Per-project memo (plan, estimate, variance …) shared by the rules of one evaluation. */
  memo: Map<string, unknown>;
}

export interface AlertRule {
  rule: string;
  source: 'CONTROL' | 'EXTERNAL';
  trigger: AlertTrigger;
  /** Default severity (findings may escalate). */
  severity: NotificationSeverity;
  /** Who receives / sees it: holders of this key with the project in scope (the owner always). */
  permission: string;
  /** Also needed to receive / see it (e.g. money-derived alerts). */
  moneyPermissions: string[];
  /** Company setting the threshold comes from (null = none). */
  thresholdSetting: keyof ControlSettings | 'missingLogAlertTime' | 'equipmentIdleDays' | null;
  /** While OPEN, a recipient is notified again after this many hours. */
  renotifyHours: number;
  /** How the dedupe key is built (documentation). */
  dedupeKey: string;
  actionUrl: (projectId: string) => string;
  description: string;
  /** Missing → the rule is listed but not evaluated (EXTERNAL jobs, plug-in placeholders). */
  evaluate?: (ctx: RuleContext) => Promise<Finding[]>;
  /** Placeholder waiting for its plug-in (status PENDING_PLUGIN). */
  placeholder?: boolean;
  /**
   * false = the engine keeps the ControlAlert row (dashboard, summary, lists) but sends no
   * notification, because the module that owns the detection already notifies (Step 16
   * EQUIPMENT_IDLE: its own `equipment-idle` job + `alerts.equipmentIdle`). Default true.
   */
  notify?: boolean;
}

const rules = new Map<string, AlertRule>();

export function registerAlertRule(rule: AlertRule): void {
  // A placeholder never replaces a real rule (imports run before the built-ins register).
  if (rule.placeholder && rules.get(rule.rule) && !rules.get(rule.rule)!.placeholder) return;
  rules.set(rule.rule, rule);
}

export function alertRule(key: string): AlertRule | undefined {
  return rules.get(key);
}

export function alertRules(): AlertRule[] {
  return [...rules.values()];
}

/** Rules the engine evaluates (with an `evaluate`). */
export function evaluableRules(keys?: string[]): AlertRule[] {
  return alertRules().filter((r) => r.evaluate && (!keys || keys.includes(r.rule)));
}

export function ruleStatus(r: AlertRule, settings: Pick<ControlSettings, 'controlAlertsEnabled'>): 'ACTIVE' | 'DISABLED' | 'PENDING_PLUGIN' {
  if (r.placeholder) return 'PENDING_PLUGIN';
  if (r.source === 'CONTROL' && !settings.controlAlertsEnabled) return 'DISABLED';
  return 'ACTIVE';
}
