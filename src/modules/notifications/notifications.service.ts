/**
 * In-app notifications (+ SMS for critical ones). Other modules call `notify(tx, …)` inside
 * their transaction, so a notification exists exactly when the change it describes does.
 *
 * Rules
 *   - recipients: a list of 'THEKEDAR' (every active owner), { userIds } or the project team by
 *     role ({ projectRoles, projectId }).
 *   - the person who caused it is skipped (except CRITICAL ones).
 *   - a MUNSHI only ever gets site notifications (MUNSHI_TYPES) — never money ones; a PM
 *     without financials never gets billing / subscription ones.
 *   - dedupe: the same (type, refId, user) at most once per 24 h.
 *   - `sms` sends an SMS for CRITICAL notifications (text = the type's SMS text / the body in the
 *     recipient's language, or the given string).
 *   - language: `text` (key + params, notifications/texts.ts) is rendered per recipient in their
 *     `User.language` and stored with the row, so the inbox can re-render it in the reader's
 *     current language. `title` / `body` are only for callers without a text key (tests).
 */
import { logger } from '../../config/logger.js';
import { getCtx } from '../../core/context/requestContext.js';
import { inSequence } from '../../core/db/inSequence.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { NotFound } from '../../core/errors/AppError.js';
import type { NotificationSeverity, NotificationType, Prisma, UserRole } from '../../generated/prisma/client.js';
import { langOf, type Lang } from '../../core/i18n/index.js';
import { smsProvider } from '../auth/sms.provider.js';
import * as repo from './notifications.repository.js';
import type { NotificationsQuery } from './notifications.schema.js';
import { renderNotification, type NotificationText } from './texts.js';

export type Recipient = 'THEKEDAR' | { userIds: string[] } | { projectRoles: UserRole[]; projectId: string };

export interface NotifyInput {
  tenantId: string;
  recipients: Recipient[];
  type: NotificationType;
  severity: NotificationSeverity;
  /** The text in every language (preferred). */
  text?: NotificationText;
  /** Fixed text (no key) — used when `text` is not given. */
  title?: string;
  body?: string;
  projectId?: string | null;
  ref: { type: string; id: string };
  actionUrl?: string | null;
  sms?: boolean | string;
  /** Who caused it (skipped as a recipient unless CRITICAL). Defaults to the request's user. */
  actorId?: string | null;
  /** Backdated creation (seed). */
  at?: Date;
  /** Dedupe window (default 24 h); a once-a-day job uses its own "already today" check and a shorter window. */
  dedupeMs?: number;
}

/** Site notifications a MUNSHI may receive (nothing with company money in it). */
export const MUNSHI_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>(['DISPATCH_CREATED', 'FLOAT_SENT', 'SETTLEMENT_RETURNED']);
/** Notifications about owner money / the subscription — billing.view only. */
export const FINANCIAL_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'INVOICE_OVERDUE',
  'CHEQUE_BOUNCED',
  'STAGE_READY_UNBILLED',
  'PREVIOUS_STAGE_UNPAID',
  'SUBSCRIPTION_RENEWAL',
  'SUBSCRIPTION_PAYMENT_APPROVED',
  'SUBSCRIPTION_PAYMENT_REJECTED',
  'RETENTION_RELEASE_DUE',
]);

export const DEDUPE_MS = 24 * 3_600_000;

export function mayReceive(user: { role: UserRole; canSeeFinancials: boolean }, type: NotificationType): boolean {
  if (user.role === 'MUNSHI') return MUNSHI_TYPES.has(type);
  if (user.role === 'PM' && !user.canSeeFinancials) return !FINANCIAL_TYPES.has(type);
  return true;
}

async function resolveRecipients(tx: Tx, tenantId: string, recipients: Recipient[]) {
  const ors: Prisma.UserWhereInput[] = [];
  for (const spec of recipients) {
    if (spec === 'THEKEDAR') ors.push({ role: 'THEKEDAR' });
    else if ('userIds' in spec) {
      const ids = spec.userIds.filter(Boolean);
      if (ids.length) ors.push({ id: { in: ids } });
    } else {
      if (spec.projectRoles.includes('THEKEDAR')) ors.push({ role: 'THEKEDAR' });
      const site = spec.projectRoles.filter((r) => r !== 'THEKEDAR');
      if (site.length) ors.push({ role: { in: site }, projectAccess: { some: { projectId: spec.projectId } } });
    }
  }
  if (!ors.length) return [];
  return repo.activeUsers(tx, { tenantId, OR: ors });
}

/** Creates the notifications; returns the recipients' user ids. Never throws for SMS failures. */
export async function notify(tx: Tx, input: NotifyInput): Promise<string[]> {
  const at = input.at ?? new Date();
  const actorId = input.actorId === undefined ? (tryUserId() ?? null) : input.actorId;
  const users = (await resolveRecipients(tx, input.tenantId, input.recipients)).filter(
    (u) => mayReceive(u, input.type) && (input.severity === 'CRITICAL' || u.id !== actorId),
  );
  if (!users.length) return [];
  const seen = await repo.alreadyNotified(
    tx,
    input.tenantId,
    input.type,
    input.ref.id,
    users.map((u) => u.id),
    new Date(at.getTime() - (input.dedupeMs ?? DEDUPE_MS)),
  );
  const fresh = users.filter((u) => !seen.has(u.id));
  if (!fresh.length) return [];
  const sendSms = Boolean(input.sms) && input.severity === 'CRITICAL';
  const texts = new Map(fresh.map((u) => [u.id, textFor(input, langOf(u.language))]));
  await tx.notification.createMany({
    data: fresh.map((u) => ({
      tenantId: input.tenantId,
      userId: u.id,
      type: input.type,
      severity: input.severity,
      title: texts.get(u.id)!.title,
      body: texts.get(u.id)!.body,
      textKey: input.text?.key ?? null,
      params: (input.text?.params ?? undefined) as Prisma.InputJsonValue | undefined,
      projectId: input.projectId ?? null,
      refType: input.ref.type,
      refId: input.ref.id,
      actionUrl: input.actionUrl ?? null,
      smsSentAt: sendSms ? at : null,
      createdAt: at,
    })),
  });
  if (sendSms) {
    for (const u of fresh) {
      const t = texts.get(u.id)!;
      const text = typeof input.sms === 'string' ? input.sms : (t.sms ?? t.body);
      await smsProvider().send({ to: u.phone, body: text, type: 'NOTIFICATION', tenantId: input.tenantId, lang: langOf(u.language) }).catch((err: unknown) => logger.warn({ err, type: input.type }, 'notification sms failed'));
    }
  }
  return fresh.map((u) => u.id);
}

function textFor(input: NotifyInput, lang: Lang): { title: string; body: string; sms: string | null } {
  const rendered = input.text ? renderNotification(lang, input.text.key, input.text.params) : null;
  if (rendered) return rendered;
  return { title: input.title ?? input.type, body: input.body ?? '', sms: null };
}

function tryUserId(): string | undefined {
  try {
    return getCtx().userId;
  } catch {
    return undefined;
  }
}

// ─── Inbox ──────────────────────────────────────────────────────────────────

function me() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

type Row = Awaited<ReturnType<typeof repo.listNotifications>>[number];

/** The reader's language (inbox / dashboard / sync render notifications in it). */
export async function readerLang(tx: Tx, userId: string): Promise<Lang> {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { language: true } });
  return langOf(u?.language);
}

/** Title / body in `lang` from the stored key + params; the stored text when there is no key. */
export function localizedText(n: { title: string; body: string; textKey: string | null; params: unknown }, lang: Lang): { title: string; body: string } {
  const r = renderNotification(lang, n.textKey, n.params);
  return r ? { title: r.title, body: r.body } : { title: n.title, body: n.body };
}

export const notificationDto = (n: Row, lang: Lang) => ({
  id: n.id,
  type: n.type,
  severity: n.severity,
  ...localizedText(n, lang),
  project: n.project,
  refType: n.refType,
  refId: n.refId,
  actionUrl: n.actionUrl,
  read: n.readAt !== null,
  readAt: n.readAt?.toISOString() ?? null,
  smsSent: n.smsSentAt !== null,
  createdAt: n.createdAt.toISOString(),
});

export async function listNotifications(query: NotificationsQuery) {
  const a = me();
  const where: Prisma.NotificationWhereInput = {
    tenantId: a.tenantId,
    userId: a.userId,
    ...(query.unreadOnly ? { readAt: null } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
  };
  return withTenant(a.tenantId, async (tx) => {
    const { skip, take } = skipTake(query);
    const [rows, total, lang] = await inSequence([() => repo.listNotifications(tx, where, skip, take), () => repo.countNotifications(tx, where), () => readerLang(tx, a.userId)]);
    return { data: rows.map((n) => notificationDto(n, lang)), meta: pageMeta(query, total) };
  });
}

export async function unreadCountTx(tx: Tx, tenantId: string, userId: string) {
  const rows = await tx.notification.groupBy({ by: ['severity'], where: { tenantId, userId, readAt: null }, _count: true });
  const of = (s: NotificationSeverity) => rows.find((r) => r.severity === s)?._count ?? 0;
  return { count: of('INFO') + of('WARNING') + of('CRITICAL'), critical: of('CRITICAL'), warning: of('WARNING') };
}

export async function unreadCount() {
  const a = me();
  return withTenant(a.tenantId, (tx) => unreadCountTx(tx, a.tenantId, a.userId));
}

export async function markRead(id: string) {
  const a = me();
  return withTenant(a.tenantId, async (tx) => {
    const n = await tx.notification.findFirst({ where: { tenantId: a.tenantId, id, userId: a.userId }, include: { project: { select: { id: true, code: true, name: true } } } });
    if (!n) throw new NotFound('NOTIFICATION_NOT_FOUND', 'Notification not found');
    const lang = await readerLang(tx, a.userId);
    if (n.readAt) return notificationDto(n, lang);
    const updated = await tx.notification.update({ where: { id: n.id }, data: { readAt: new Date() }, include: { project: { select: { id: true, code: true, name: true } } } });
    return notificationDto(updated, lang);
  });
}

export async function markAllRead() {
  const a = me();
  return withTenant(a.tenantId, async (tx) => {
    const { count } = await tx.notification.updateMany({ where: { tenantId: a.tenantId, userId: a.userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: count };
  });
}

/** Latest unread CRITICAL notifications of a user (dashboard alerts). */
export async function criticalUnread(tx: Tx, tenantId: string, userId: string, take = 10) {
  const rows = await tx.notification.findMany({
    where: { tenantId, userId, severity: 'CRITICAL', readAt: null },
    include: { project: { select: { id: true, code: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
  const lang = await readerLang(tx, userId);
  return rows.map((n) => notificationDto(n, lang));
}
