import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant } from '../../core/db/withTenant.js';
import { BadRequest, NotFound } from '../../core/errors/AppError.js';
import { pageMeta, skipTake } from '../../core/http/pagination.js';
import * as repo from './team.repository.js';
import type { DeviceDto, ListDevicesQuery } from './team.schema.js';

export async function listDevices(query: ListDevicesQuery) {
  const ctx = getCtx();
  return withTenant(ctx.tenantId!, async (tx) => {
    const where = { ...(query.userId ? { userId: query.userId } : {}), ...(query.platform ? { platform: query.platform } : {}) };
    const { skip, take } = skipTake(query);
    const rows = await repo.listDevices(tx, where, skip, take);
    const total = await repo.countDevices(tx, where);
    const currentId = await repo.currentDeviceId(tx, ctx.sessionId);

    const data: DeviceDto[] = rows.map((d) => ({
      id: d.id,
      user: d.user,
      platform: d.platform,
      model: d.model,
      appVersion: d.appVersion,
      lastActiveAt: d.lastActiveAt.toISOString(),
      lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
      pendingUploads: d.pendingUploads,
      revokedAt: d.revokedAt?.toISOString() ?? null,
      current: d.id === currentId,
    }));
    return { data, meta: pageMeta(query, total) };
  });
}

/** Signs a device out everywhere: it can't refresh until its user logs in again. */
export async function revokeDevice(id: string): Promise<{ id: string; revokedAt: string }> {
  const ctx = getCtx();
  const tenantId = ctx.tenantId!;
  return withTenant(tenantId, async (tx) => {
    const device = await repo.findDevice(tx, id);
    if (!device) throw new NotFound('DEVICE_NOT_FOUND', 'Device not found');
    if (id === (await repo.currentDeviceId(tx, ctx.sessionId))) {
      throw new BadRequest('CANNOT_REVOKE_CURRENT_DEVICE', 'You cannot revoke the device you are using. Log out instead.');
    }
    const now = new Date();
    const revokedAt = device.revokedAt ?? (await repo.revokeDevice(tx, id, now)).revokedAt!;
    const sessions = await repo.revokeDeviceSessions(tx, id, now);
    await writeAudit(tx, {
      tenantId,
      actorType: 'USER',
      actorId: ctx.userId!,
      action: 'device.revoke',
      entityType: 'Device',
      entityId: id,
      details: { userId: device.user.id, sessionsRevoked: sessions.count },
    });
    return { id, revokedAt: revokedAt.toISOString() };
  });
}
