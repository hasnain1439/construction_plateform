/**
 * Act-as sessions: a platform super admin opening one company ("Company data").
 *
 * - Start needs a reason (5–300) and creates a READ_ONLY session for `durationMinutes` (default
 *   60). The admin's other live sessions end (one company at a time). Every active owner of the
 *   company gets an in-app notification and, when they have an email, a mail:
 *   "Platform support accessed your account: <reason>".
 * - WRITE needs a second reason (POST /:id/mode); switching back to READ_ONLY needs none.
 * - A session ends at expiresAt by itself (checked on every act-as request) or with POST /:id/end.
 * - Every step is audited in the company's audit log (admin name + reason in details).
 */
import { logger } from '../../config/logger.js';
import { prismaAdmin } from '../../core/db/prisma.js';
import { withTenant } from '../../core/db/withTenant.js';
import { Conflict, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { langOf, tr } from '../../core/i18n/index.js';
import { trySendMail } from '../auth/mail.provider.js';
import * as alerts from '../notifications/alerts.js';
import { adminId, auditAdmin } from './platformAdmin.shared.js';
import type { ActAsModeInput, ActAsSessionsQuery, StartActAsInput } from './platformAdmin.schema.js';

const MINUTE = 60_000;
const include = {
  admin: { select: { id: true, name: true, email: true } },
  tenant: { select: { id: true, name: true, slug: true } },
} as const;
type Row = Prisma.ActAsSessionGetPayload<{ include: typeof include }>;

export type ActAsStatus = 'ACTIVE' | 'EXPIRED' | 'ENDED';

export function statusOf(s: { endedAt: Date | null; expiresAt: Date }, now = new Date()): ActAsStatus {
  if (s.endedAt) return 'ENDED';
  return s.expiresAt <= now ? 'EXPIRED' : 'ACTIVE';
}

export function sessionDto(s: Row, now = new Date()) {
  const status = statusOf(s, now);
  return {
    id: s.id,
    tenant: s.tenant,
    admin: s.admin,
    reason: s.reason,
    mode: s.mode,
    writeReason: s.writeReason,
    writeEnabledAt: s.writeEnabledAt?.toISOString() ?? null,
    startedAt: s.startedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    status,
    secondsLeft: status === 'ACTIVE' ? Math.max(0, Math.floor((s.expiresAt.getTime() - now.getTime()) / 1000)) : 0,
  };
}

const live = (now: Date): Prisma.ActAsSessionWhereInput => ({ endedAt: null, expiresAt: { gt: now } });

async function findSession(id: string): Promise<Row> {
  const s = await prismaAdmin.actAsSession.findUnique({ where: { id }, include });
  if (!s) throw new NotFound('ACT_AS_SESSION_NOT_FOUND', 'Support session not found');
  return s;
}

export async function startSession(input: StartActAsInput) {
  const me = adminId();
  const now = new Date();
  const tenant = await prismaAdmin.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true, name: true } });
  if (!tenant) throw new NotFound('TENANT_NOT_FOUND', 'Company not found');

  const session = await prismaAdmin.$transaction(async (tx) => {
    const admin = await tx.platformAdmin.findUniqueOrThrow({ where: { id: me }, select: { name: true } });
    // One company at a time: the admin's other live sessions end now.
    const previous = await tx.actAsSession.findMany({ where: { adminId: me, ...live(now) }, select: { id: true, tenantId: true } });
    if (previous.length) {
      await tx.actAsSession.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { endedAt: now } });
      for (const p of previous) {
        await auditAdmin(tx, { tenantId: p.tenantId, action: 'admin.act_as_ended', entityType: 'ActAsSession', entityId: p.id, details: { adminName: admin.name, endedBy: 'NEW_SESSION' } });
      }
    }
    const created = await tx.actAsSession.create({
      data: { adminId: me, tenantId: tenant.id, reason: input.reason, mode: 'READ_ONLY', startedAt: now, expiresAt: new Date(now.getTime() + input.durationMinutes * MINUTE) },
      include,
    });
    await auditAdmin(tx, {
      tenantId: tenant.id,
      action: 'admin.act_as_started',
      entityType: 'ActAsSession',
      entityId: created.id,
      details: { adminName: admin.name, reason: input.reason, mode: 'READ_ONLY', expiresAt: created.expiresAt.toISOString() },
    });
    return created;
  });

  await notifyOwners(session);
  return sessionDto(session);
}

/** In-app notification + email to every active owner. Never fails the start. */
async function notifyOwners(s: Row): Promise<void> {
  try {
    await withTenant(s.tenantId, (tx) => alerts.platformSupportAccess(tx, { tenantId: s.tenantId, sessionId: s.id, adminName: s.admin.name, reason: s.reason }));
  } catch (err) {
    logger.error({ err, tenantId: s.tenantId }, 'act-as notification failed');
  }
  const owners = await prismaAdmin.user.findMany({
    where: { tenantId: s.tenantId, role: 'THEKEDAR', status: 'ACTIVE', isSystem: false, email: { not: null } },
    select: { name: true, email: true, language: true },
  });
  const until = s.expiresAt.toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit' });
  for (const o of owners) {
    // Each owner in their own language.
    const lang = langOf(o.language);
    await trySendMail({
      to: o.email!,
      type: 'SUPPORT_ACCESS',
      tenantId: s.tenantId,
      subject: tr(lang, 'mail.support.subject', { company: s.tenant.name }),
      text:
        `${tr(lang, 'mail.support.greeting', { name: o.name })}\n\n${tr(lang, 'notif.platformSupportAccess.body', { reason: s.reason, admin: s.admin.name })}\n\n` +
        `${tr(lang, 'mail.support.person', { admin: s.admin.name })}\n${tr(lang, 'mail.support.access')}\n${tr(lang, 'mail.support.until', { until })}\n\n` +
        tr(lang, 'mail.support.audit'),
    });
  }
}

export async function changeMode(id: string, input: ActAsModeInput) {
  const me = adminId();
  const s = await findSession(id);
  if (s.adminId !== me) throw new NotFound('ACT_AS_SESSION_NOT_FOUND', 'Support session not found');
  if (statusOf(s) !== 'ACTIVE') throw new Conflict('ACT_AS_SESSION_NOT_ACTIVE', 'This support session has ended or expired. Start a new one.');
  if (s.mode === input.mode) return sessionDto(s);
  const now = new Date();
  const updated = await prismaAdmin.$transaction(async (tx) => {
    const row = await tx.actAsSession.update({
      where: { id },
      data: input.mode === 'WRITE' ? { mode: 'WRITE', writeReason: input.reason!, writeEnabledAt: now } : { mode: 'READ_ONLY' },
      include,
    });
    await auditAdmin(tx, {
      tenantId: s.tenantId,
      action: 'admin.act_as_mode_changed',
      entityType: 'ActAsSession',
      entityId: id,
      details: { adminName: s.admin.name, from: s.mode, to: input.mode, reason: input.mode === 'WRITE' ? input.reason! : s.reason },
    });
    return row;
  });
  return sessionDto(updated);
}

/** Ends a session (idempotent). Any super admin may end any live session. */
export async function endSession(id: string) {
  const s = await findSession(id);
  if (s.endedAt) return sessionDto(s);
  const now = new Date();
  const updated = await prismaAdmin.$transaction(async (tx) => {
    const row = await tx.actAsSession.update({ where: { id }, data: { endedAt: now }, include });
    const me = await tx.platformAdmin.findUniqueOrThrow({ where: { id: adminId() }, select: { name: true } });
    await auditAdmin(tx, {
      tenantId: s.tenantId,
      action: 'admin.act_as_ended',
      entityType: 'ActAsSession',
      entityId: id,
      details: { adminName: me.name, endedBy: s.adminId === adminId() ? 'ADMIN' : 'OTHER_ADMIN', expiredBefore: s.expiresAt <= now },
    });
    return row;
  });
  return sessionDto(updated);
}

export async function getSession(id: string) {
  return sessionDto(await findSession(id));
}

export async function listSessions(query: ActAsSessionsQuery) {
  const now = new Date();
  const where: Prisma.ActAsSessionWhereInput = {
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.adminId ? { adminId: query.adminId } : {}),
    ...(query.active === true ? live(now) : query.active === false ? { OR: [{ endedAt: { not: null } }, { expiresAt: { lte: now } }] } : {}),
  };
  const { skip, take } = skipTake(query);
  const [rows, total] = await Promise.all([
    prismaAdmin.actAsSession.findMany({ where, include, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], skip, take }),
    prismaAdmin.actAsSession.count({ where }),
  ]);
  return { data: rows.map((r) => sessionDto(r, now)), meta: pageMeta(query, total) };
}
