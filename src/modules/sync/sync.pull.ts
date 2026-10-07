/**
 * GET /sync/pull — the phone's read model.
 *
 * - No cursor → a full snapshot of the caller's scope; `cursor` = the newest change already
 *   reflected in it.
 * - With a cursor → only rows whose SyncChange seq is above it (paged by `limit` change rows,
 *   `hasMore`), as upserts, plus tombstones for deleted rows the caller could see.
 * - `resetRequired` when the cursor is older than the retention watermark, or when the caller's
 *   project access changed (the scope itself moved) → the phone wipes and pulls a snapshot.
 *
 * Safe cursor: sequence numbers are taken at insert time but transactions commit in any order,
 * so a change is only handed out once it is SYNC_LAG old (longer than any transaction may run);
 * the cursor never passes a change that is younger. Tests run with no lag.
 */
import { isTest } from '../../config/env.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant, type Tx } from '../../core/db/withTenant.js';
import type { SyncChange } from '../../generated/prisma/client.js';
import { syncScope, TABLES, type SyncActor, type SyncRow, type SyncScope } from './sync.tables.js';

let SYNC_LAG_MS = isTest ? 0 : 30_000;
/** Tests / tools: how old a change must be before it is handed out. */
export const setSyncLag = (ms: number) => {
  SYNC_LAG_MS = ms;
};

export const DEFAULT_LIMIT = 500;

export function syncActor(): SyncActor & { sessionId: string } {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId!, role: ctx.role as SyncActor['role'], sessionId: ctx.sessionId! };
}

/** The device of the caller's session (tenantContext already refused a revoked one). */
export async function sessionDevice(tx: Tx, sessionId: string) {
  const session = await tx.session.findUnique({ where: { id: sessionId }, select: { device: true } });
  return session?.device ?? null;
}

type Changes = Record<string, { upserts: SyncRow[]; deletes: string[] }>;

async function dbNow(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
  return row!.now;
}

/** Highest seq that every older change is safely visible below. */
async function boundary(tx: Tx, cutoff: Date): Promise<bigint> {
  const young = await tx.syncChange.findFirst({ where: { changedAt: { gt: cutoff } }, orderBy: { seq: 'asc' }, select: { seq: true } });
  if (young) return young.seq - 1n;
  return (await tx.syncChange.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;
}

async function snapshot(tx: Tx, sc: SyncScope): Promise<Changes> {
  const out: Changes = {};
  for (const t of TABLES) out[t.name] = { upserts: await t.load(tx, sc), deletes: [] };
  return out;
}

/** May the caller learn that this row was deleted? (only rows of their scope / their own rows) */
function mayTombstone(c: Pick<SyncChange, 'projectId' | 'userId'>, sc: SyncScope) {
  if (c.userId) return c.userId === sc.a.userId;
  if (c.projectId) return sc.projectIds.includes(c.projectId);
  return true;
}

async function incremental(tx: Tx, sc: SyncScope, batch: SyncChange[]): Promise<Changes> {
  const out: Changes = {};
  for (const t of TABLES) {
    if (t.snapshotOnly) continue;
    const mine = batch.filter((c) => t.sources.includes(c.tableName));
    if (!mine.length) continue;
    if (t.refresh) {
      out[t.name] = { upserts: await t.load(tx, sc), deletes: [] };
      continue;
    }
    const ids = [...new Set(mine.map((c) => c.rowId))];
    const upserts = await t.load(tx, sc, ids);
    const found = new Set(upserts.map((r) => (t.name === 'site_stock' ? String(r['locationId']) : r.id)));
    const deletes = [...new Set(mine.filter((c) => c.op === 'DELETE' && !found.has(c.rowId) && mayTombstone(c, sc)).map((c) => c.rowId))];
    // A project leaving the caller's scope (handed over, closed) is removed from the phone.
    if (t.name === 'projects') {
      for (const id of ids) if (!found.has(id) && !sc.projectIds.includes(id) && (sc.a.role === 'THEKEDAR' || (await tx.userProjectAccess.count({ where: { userId: sc.a.userId, projectId: id } })))) deletes.push(id);
    }
    if (upserts.length || deletes.length) out[t.name] = { upserts, deletes: [...new Set(deletes)] };
  }
  return out;
}

export async function pull(query: { cursor?: string | undefined; limit?: number | undefined }) {
  const a = syncActor();
  const limit = query.limit ?? DEFAULT_LIMIT;
  return withTenant(a.tenantId, async (tx) => {
    const device = await sessionDevice(tx, a.sessionId);
    const now = await dbNow(tx);
    const cutoff = new Date(now.getTime() - SYNC_LAG_MS);
    const sc = await syncScope(tx, a);
    const base = { serverTime: now.toISOString(), hasMore: false, resetRequired: false };

    let result: typeof base & { cursor: string; changes: Changes };
    if (query.cursor === undefined) {
      const cursor = await boundary(tx, cutoff);
      result = { ...base, cursor: cursor.toString(), changes: await snapshot(tx, sc) };
    } else {
      const cursor = BigInt(query.cursor);
      const mark = (await tx.syncWatermark.findUnique({ where: { id: 1 } }))?.prunedThroughSeq ?? 0n;
      if (cursor < mark) {
        result = { ...base, resetRequired: true, cursor: query.cursor, changes: {} };
      } else {
        const rows = await tx.syncChange.findMany({ where: { seq: { gt: cursor } }, orderBy: { seq: 'asc' }, take: limit + 1 });
        const young = rows.findIndex((r) => r.changedAt.getTime() > cutoff.getTime());
        const eligible = young === -1 ? rows : rows.slice(0, young);
        const batch = eligible.slice(0, limit);
        const scopeMoved = batch.some((c) => c.tableName === 'UserProjectAccess' && c.userId === a.userId);
        result = scopeMoved
          ? { ...base, resetRequired: true, cursor: query.cursor, changes: {} }
          : {
              ...base,
              hasMore: eligible.length > limit,
              cursor: (batch.at(-1)?.seq ?? cursor).toString(),
              changes: await incremental(tx, sc, batch),
            };
      }
    }
    if (device) await tx.device.update({ where: { id: device.id }, data: { lastSyncAt: now, lastActiveAt: now } });
    return result;
  });
}
