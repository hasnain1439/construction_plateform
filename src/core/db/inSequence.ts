/**
 * Runs queries one after another and returns their results as a tuple — the drop-in
 * replacement for `Promise.all([...])` inside a transaction.
 *
 * A transaction (`withTenant`, `$transaction`) holds ONE pg connection, and one connection
 * can only run one query at a time: `Promise.all([tx.a.findMany(), tx.a.count()])` makes pg
 * queue the second query behind the first (deprecated, removed in pg 9) without any speed-up.
 * Pass functions, not promises, so nothing starts before its turn:
 *
 *   const [rows, total] = await inSequence([() => tx.a.findMany(q), () => tx.a.count(q)]);
 *
 * Outside a transaction (the bare pool) `Promise.all` is fine — each query gets its own connection.
 */
export async function inSequence<T extends readonly unknown[]>(tasks: { readonly [K in keyof T]: () => PromiseLike<T[K]> }): Promise<T> {
  const results: unknown[] = [];
  for (const task of tasks as readonly (() => PromiseLike<unknown>)[]) results.push(await task());
  return results as unknown as T;
}
