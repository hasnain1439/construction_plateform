/**
 * Fails a test when two queries run at the same time on one `pg` connection — e.g.
 * `Promise.all([tx.a.findMany(), tx.a.count()])` inside a transaction. pg 8 only prints
 * "Calling client.query() when the client is already executing a query is deprecated"
 * (once per process, through util.deprecate → process.emitWarning) and pg 9 will throw.
 *
 * Loaded for every test file through `setupFiles` in vitest.config.ts. The check wraps
 * `Client.prototype.query`, so every occurrence is caught, not just the first one per process,
 * and it is stricter than pg: pg only warns once a THIRD query queues up (`_queryQueue.length > 0`);
 * we flag the second one already (a query is still running: `_activeQuery` set).
 * A `process.on('warning')` listener for pg's message is a second net.
 */
import pg from 'pg';
import { afterEach } from 'vitest';

const MESSAGE = 'client.query() when the client is already executing a query';
const violations: string[] = [];

type QueueClient = { _queryQueue?: unknown[]; _activeQuery?: unknown; pipeline?: boolean };
type Patched = typeof pg.Client.prototype.query & { __concurrencyGuard?: true };

const proto = pg.Client.prototype as { query: Patched };
if (!proto.query.__concurrencyGuard) {
  const original = proto.query;
  const guarded = function (this: QueueClient, ...args: unknown[]) {
    if (!this.pipeline && (this._activeQuery != null || (this._queryQueue?.length ?? 0) > 0)) {
      const first = args[0];
      const text = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text;
      violations.push(`concurrent query on one pg connection: ${String(text ?? '<query object>').slice(0, 200)}\n${new Error().stack ?? ''}`);
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as Patched;
  guarded.__concurrencyGuard = true;
  proto.query = guarded;
}

process.on('warning', (warning) => {
  if (warning.message.includes(MESSAGE)) violations.push(`pg warning: ${warning.message}\n${warning.stack ?? ''}`);
});

afterEach(() => {
  if (violations.length === 0) return;
  const found = violations.splice(0);
  throw new Error(`pg: ${found.length} query/queries started while the connection was busy (parallel queries on one transaction?)\n\n${found[0]}`);
});

/** For the guard's own test. */
export function takePgConcurrencyViolations(): string[] {
  return violations.splice(0);
}
