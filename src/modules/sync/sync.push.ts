/**
 * POST /sync/push — applies the phone's outbox through the SAME services (and permission
 * checks) as the REST API.
 *
 * - In order; each mutation in its own transaction, recorded in SyncIdMap in that transaction.
 * - APPLIED (serverId) · DUPLICATE (same clientId seen before → same serverId, nothing done) ·
 *   REJECTED (permanent business error: code / message / details) · RETRY (transient — busy
 *   database, unexpected error; the phone tries again later).
 * - After a RETRY everything that follows is RETRY too (order matters on the phone).
 * - A mutation whose `dependsOn` was REJECTED is REJECTED with DEPENDENCY_REJECTED.
 * - Payload ids may be the clientId of an earlier mutation or of an attachment uploaded with a
 *   clientId; they are replaced by the server ids before the service runs.
 */
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import { AppError, BadRequest } from '../../core/errors/AppError.js';
import { Prisma } from '../../core/db/prisma.js';
import type { Prisma as P } from '../../generated/prisma/client.js';
import { acknowledgeTx, createExpenseTx, requestTopupTx } from '../cashbook/cashbook.service.js';
import { expenseBody, topupBody } from '../cashbook/cashbook.schema.js';
import { upsertTx as upsertDailyLogTx } from '../dailylogs/dailylogs.service.js';
import { dailyLogBody } from '../dailylogs/dailylogs.schema.js';
import { receiveDispatchTx } from '../dispatch/dispatches.service.js';
import { createOwnerDeliveryTx } from '../dispatch/ownerDeliveries.service.js';
import { ownerDeliveryBody, receiveDispatchBody } from '../dispatch/dispatch.schema.js';
import { createCountTx } from '../inventory/counts.service.js';
import { actor as stockActor, type Actor } from '../inventory/stock.js';
import { stockCountBody, usageBody } from '../inventory/inventory.schema.js';
import { recordUsageTx } from '../inventory/usage.service.js';
import { createAdvanceTx } from '../labor/advances.service.js';
import { assignWorkerTx } from '../labor/assignments.service.js';
import { markAttendanceTx } from '../labor/attendance.service.js';
import { advanceBody, assignWorkerBody, attendanceBody, generateBody, measurementBody, payBody } from '../labor/labor.schema.js';
import { recordMeasurementTx } from '../labor/measurements.service.js';
import { generateTx, payTx, submitTx } from '../labor/settlements.service.js';
import { createWorkerBody } from '../master-data/master-data.schema.js';
import { createWorkerTx } from '../master-data/workers.service.js';
import { createPurchaseTx, receivePurchaseTx } from '../procurement/purchases.service.js';
import { createPurchaseBody, receivePurchaseBody } from '../procurement/procurement.schema.js';
import { sessionDevice, syncActor } from './sync.pull.js';
import type { PushInput } from './sync.schema.js';

const id = z.uuid();
type Handler = { ref?: z.ZodObject; body: z.ZodType; run: (tx: Tx, a: Actor, ref: Record<string, string>, body: never) => Promise<unknown> };

/** Pulls the new entity's id out of whatever the service returned. */
function serverIdOf(result: unknown): string | null {
  const r = result as { id?: unknown; data?: { id?: unknown }; dispatch?: { id?: unknown }; purchase?: { id?: unknown } } | null;
  const v = r?.data?.id ?? r?.id ?? r?.dispatch?.id ?? r?.purchase?.id;
  return typeof v === 'string' ? v : null;
}

const project = z.object({ projectId: id });

export const HANDLERS: Record<string, Handler> = {
  WORKER_CREATE: { body: createWorkerBody, run: (tx, a, _r, b) => createWorkerTx(tx, a, b) },
  PROJECT_WORKER_ASSIGN: { ref: project, body: assignWorkerBody, run: (tx, a, r, b) => assignWorkerTx(tx, a, r['projectId']!, b) },
  ATTENDANCE_UPSERT: { ref: project, body: attendanceBody, run: (tx, a, r, b) => markAttendanceTx(tx, a, r['projectId']!, b) },
  ADVANCE_CREATE: { ref: project, body: advanceBody, run: (tx, a, r, b) => createAdvanceTx(tx, a, r['projectId']!, b) },
  WORK_MEASUREMENT_CREATE: { ref: project, body: measurementBody, run: (tx, a, r, b) => recordMeasurementTx(tx, a, r['projectId']!, b) },
  SETTLEMENT_GENERATE: { ref: project, body: generateBody, run: (tx, a, r, b: { weekStart: string }) => generateTx(tx, a, r['projectId']!, b.weekStart) },
  SETTLEMENT_SUBMIT: { ref: z.object({ settlementId: id }), body: z.object({}), run: (tx, a, r) => submitTx(tx, a, r['settlementId']!) },
  SETTLEMENT_PAY: { ref: z.object({ settlementId: id }), body: payBody, run: (tx, a, r, b) => payTx(tx, a, r['settlementId']!, b) },
  DISPATCH_RECEIVE: { ref: z.object({ dispatchId: id }), body: receiveDispatchBody, run: (tx, a, r, b) => receiveDispatchTx(tx, a, r['dispatchId']!, b) },
  PURCHASE_RECEIVE: { ref: z.object({ purchaseId: id }), body: receivePurchaseBody, run: (tx, a, r, b) => receivePurchaseTx(tx, a, r['purchaseId']!, b) },
  OWNER_DELIVERY_CREATE: { ref: project, body: ownerDeliveryBody, run: (tx, a, r, b) => createOwnerDeliveryTx(tx, a, r['projectId']!, b) },
  MATERIAL_USAGE_CREATE: { ref: project, body: usageBody, run: (tx, a, r, b) => recordUsageTx(tx, a, r['projectId']!, b) },
  STOCK_COUNT_CREATE: { body: stockCountBody, run: (tx, a, _r, b) => createCountTx(tx, a, b) },
  CASH_EXPENSE_CREATE: { body: expenseBody, run: (tx, a, _r, b) => createExpenseTx(tx, a, b) },
  FLOAT_ACKNOWLEDGE: { ref: z.object({ entryId: id }), body: z.object({}), run: (tx, a, r) => acknowledgeTx(tx, a, r['entryId']!) },
  TOPUP_REQUEST_CREATE: { body: topupBody, run: (tx, a, _r, b) => requestTopupTx(tx, a, b) },
  DAILY_LOG_UPSERT: { ref: project, body: dailyLogBody, run: (tx, a, r, b) => upsertDailyLogTx(tx, a, r['projectId']!, b) },
  // A munshi's site purchase: the service makes it PENDING_RATE (no rates) and refuses the store.
  SITE_PURCHASE_CREATE: { body: createPurchaseBody, run: (tx, a, _r, b) => createPurchaseTx(tx, a, b) },
};
export const MUTATION_TYPES = Object.keys(HANDLERS) as [string, ...string[]];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every uuid string in a payload (values of keys ending in Id / Ids, at any depth). */
function referencedIds(value: unknown, out = new Set<string>(), key = ''): Set<string> {
  if (typeof value === 'string' && UUID.test(value) && /ids?$/i.test(key)) out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => referencedIds(v, out, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) referencedIds(v, out, k);
  return out;
}
function replaceIds(value: unknown, map: Map<string, string>, key = ''): unknown {
  if (typeof value === 'string' && /ids?$/i.test(key)) return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceIds(v, map, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'clientId' ? v : replaceIds(v, map, k)]));
  return value;
}

/** clientIds of earlier mutations / attachments → server ids. */
async function resolveIds(tx: Tx, tenantId: string, payload: Record<string, unknown>) {
  const ids = [...referencedIds(payload)];
  if (!ids.length) return payload;
  const map = new Map<string, string>();
  for (const r of await tx.syncIdMap.findMany({ where: { tenantId, clientId: { in: ids }, status: 'APPLIED', serverId: { not: null } } })) map.set(r.clientId, r.serverId!);
  for (const r of await tx.attachment.findMany({ where: { tenantId, clientId: { in: ids } }, select: { id: true, clientId: true } })) map.set(r.clientId!, r.id);
  return replaceIds(payload, map) as Record<string, unknown>;
}

export type PushStatus = 'APPLIED' | 'DUPLICATE' | 'REJECTED' | 'RETRY';
export interface PushResult {
  clientId: string;
  type: string;
  status: PushStatus;
  serverId: string | null;
  error: { code: string; message: string; details?: unknown } | null;
}

const zodDetails = (err: z.ZodError) => err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/** Permanent business errors (4xx except busy / rate-limited) are REJECTED; the rest RETRY. */
function classify(err: unknown): { status: 'REJECTED' | 'RETRY'; code: string; message: string; details?: unknown } {
  if (err instanceof AppError) {
    if (err.status >= 500 || err.status === 429 || err.code === 'SERVICE_BUSY') return { status: 'RETRY', code: err.code, message: err.message };
    return { status: 'REJECTED', code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { status: 'REJECTED', code: 'ALREADY_EXISTS', message: 'This already exists' };
  return { status: 'RETRY', code: 'TRANSIENT', message: 'Could not apply now — will try again' };
}

export async function push(input: PushInput, pendingHeader: string | undefined) {
  const s = syncActor();
  const a = stockActor();
  const device = await withTenant(a.tenantId, (tx) => sessionDevice(tx, s.sessionId));
  if (input.deviceId && device && input.deviceId !== device.clientDeviceId) throw new BadRequest('DEVICE_MISMATCH', 'This batch belongs to another device');
  const results: PushResult[] = [];
  const byClient = new Map<string, PushResult>();
  let retrying = false;

  for (const m of input.mutations) {
    const done = (r: Omit<PushResult, 'clientId' | 'type'>) => {
      const full = { clientId: m.clientId, type: m.type, ...r };
      results.push(full);
      byClient.set(m.clientId, full);
    };
    const reject = async (code: string, message: string, details?: unknown) => {
      await withTenant(a.tenantId, (tx) =>
        tx.syncIdMap.create({
          data: {
            tenantId: a.tenantId,
            clientId: m.clientId,
            entity: m.type,
            status: 'REJECTED',
            errorCode: code,
            errorMessage: message,
            ...(details !== undefined ? { errorDetails: details as P.InputJsonValue } : {}),
            deviceId: device?.id ?? null,
            userId: a.userId,
            deviceCreatedAt: m.deviceCreatedAt ? new Date(m.deviceCreatedAt) : null,
          },
        }),
      ).catch(() => undefined); // a concurrent retry already recorded it
      done({ status: 'REJECTED', serverId: null, error: { code, message, ...(details !== undefined ? { details } : {}) } });
    };

    if (retrying) {
      done({ status: 'RETRY', serverId: null, error: { code: 'EARLIER_RETRY', message: 'Waiting for an earlier entry' } });
      continue;
    }
    const seen = await withTenant(a.tenantId, (tx) => tx.syncIdMap.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: m.clientId } } }));
    if (seen) {
      done(
        seen.status === 'APPLIED'
          ? { status: 'DUPLICATE', serverId: seen.serverId, error: null }
          : { status: 'REJECTED', serverId: null, error: { code: seen.errorCode ?? 'REJECTED', message: seen.errorMessage ?? 'Rejected' } },
      );
      continue;
    }
    // Dependencies: rejected in this batch or before → rejected; not applied yet → wait.
    const deps = m.dependsOn ?? [];
    if (deps.length) {
      const known = await withTenant(a.tenantId, (tx) => tx.syncIdMap.findMany({ where: { tenantId: a.tenantId, clientId: { in: deps } }, select: { clientId: true, status: true } }));
      const status = (c: string) => byClient.get(c)?.status ?? (known.find((k) => k.clientId === c)?.status === 'APPLIED' ? 'APPLIED' : known.find((k) => k.clientId === c)?.status);
      if (deps.some((c) => status(c) === 'REJECTED')) {
        await reject('DEPENDENCY_REJECTED', 'An entry this one depends on was rejected', { dependsOn: deps.filter((c) => status(c) === 'REJECTED') });
        continue;
      }
      if (deps.some((c) => !['APPLIED', 'DUPLICATE'].includes(String(status(c))))) {
        retrying = true;
        done({ status: 'RETRY', serverId: null, error: { code: 'DEPENDENCY_PENDING', message: 'Waiting for an entry this one depends on' } });
        continue;
      }
    }

    const handler = HANDLERS[m.type]!;
    try {
      const serverId = await withTenant(a.tenantId, async (tx) => {
        const payload = await resolveIds(tx, a.tenantId, { ...m.payload, clientId: m.clientId, ...(m.deviceCreatedAt ? { deviceCreatedAt: m.deviceCreatedAt } : {}) });
        const ref = handler.ref ? handler.ref.parse(payload) : {};
        const body = handler.body.parse(payload) as never;
        const result = await handler.run(tx, a, ref as Record<string, string>, body);
        const sid = serverIdOf(result) ?? (Object.values(ref)[0] as string | undefined) ?? null;
        await tx.syncIdMap.create({
          data: {
            tenantId: a.tenantId,
            clientId: m.clientId,
            entity: m.type,
            serverId: sid,
            status: 'APPLIED',
            deviceId: device?.id ?? null,
            userId: a.userId,
            deviceCreatedAt: m.deviceCreatedAt ? new Date(m.deviceCreatedAt) : null,
          },
        });
        return sid;
      });
      done({ status: 'APPLIED', serverId, error: null });
    } catch (err) {
      if (err instanceof z.ZodError) {
        await reject('VALIDATION_ERROR', 'The entry is not valid', zodDetails(err));
        continue;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && String(err.meta?.['modelName'] ?? '').includes('SyncIdMap')) {
        const again = await withTenant(a.tenantId, (tx) => tx.syncIdMap.findUnique({ where: { tenantId_clientId: { tenantId: a.tenantId, clientId: m.clientId } } }));
        done({ status: 'DUPLICATE', serverId: again?.serverId ?? null, error: null });
        continue;
      }
      const c = classify(err);
      if (c.status === 'RETRY') {
        logger.warn({ err, type: m.type, clientId: m.clientId }, 'sync mutation will be retried');
        retrying = true;
        done({ status: 'RETRY', serverId: null, error: { code: c.code, message: c.message } });
      } else {
        await reject(c.code, c.message, c.details);
      }
    }
  }

  const pending = pendingHeader !== undefined && /^\d+$/.test(pendingHeader) ? Number(pendingHeader) : undefined;
  if (device) await withTenant(a.tenantId, (tx) => tx.device.update({ where: { id: device.id }, data: { lastSyncAt: new Date(), lastActiveAt: new Date(), ...(pending !== undefined ? { pendingUploads: pending } : {}) } }));
  const count = (st: PushStatus) => results.filter((r) => r.status === st).length;
  return { results, applied: count('APPLIED'), duplicates: count('DUPLICATE'), rejected: count('REJECTED'), retry: count('RETRY') };
}

/** Devices of the caller (every device for the owner) with their sync health. */
export async function status() {
  const a = syncActor();
  return withTenant(a.tenantId, async (tx) => {
    const devices = await tx.device.findMany({
      where: { tenantId: a.tenantId, ...(a.role === 'THEKEDAR' ? {} : { userId: a.userId }) },
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: [{ lastSyncAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    const out = [];
    for (const d of devices) {
      const rejected = await tx.syncIdMap.findMany({ where: { tenantId: a.tenantId, deviceId: d.id, status: 'REJECTED' }, orderBy: { createdAt: 'desc' }, take: 10 });
      out.push({
        id: d.id,
        user: d.user,
        platform: d.platform,
        model: d.model,
        appVersion: d.appVersion,
        revoked: d.revokedAt !== null,
        lastActiveAt: d.lastActiveAt.toISOString(),
        lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
        pendingUploads: d.pendingUploads,
        lastRejected: rejected.map((r) => ({ clientId: r.clientId, type: r.entity, code: r.errorCode, message: r.errorMessage, deviceCreatedAt: r.deviceCreatedAt?.toISOString() ?? null, at: r.createdAt.toISOString() })),
      });
    }
    return out;
  });
}
