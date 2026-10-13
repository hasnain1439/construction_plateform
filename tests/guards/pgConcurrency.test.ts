import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { inSequence } from '../../src/core/db/inSequence.js';
import { prismaAdmin, SerialPgClient } from '../../src/core/db/prisma.js';
import { withTenant } from '../../src/core/db/withTenant.js';
import { useFreshDatabase } from '../helpers.js';
import { takePgConcurrencyViolations } from '../setup/pgConcurrency.js';

const url = process.env['DATABASE_ADMIN_URL'];

const seeded = useFreshDatabase();

describe('one query at a time per pg connection', () => {
  it('the test guard notices two queries sent together on one plain pg client', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await Promise.all([client.query('SELECT pg_sleep(0.05)'), client.query('SELECT 1')]);
    } finally {
      await client.end();
    }
    const found = takePgConcurrencyViolations(); // taken here so this test itself passes
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]).toContain('SELECT 1');
  });

  it('SerialPgClient sends them one after another, in order, and keeps errors per query', async () => {
    const client = new SerialPgClient({ connectionString: url });
    await client.connect();
    try {
      const [a, b, c] = await Promise.allSettled([
        client.query('SELECT pg_sleep(0.05), 1 AS n'),
        client.query('SELECT nope_not_a_column'),
        client.query('SELECT 3 AS n'),
      ]);
      expect(a.status === 'fulfilled' && a.value.rows[0].n).toBe(1);
      expect(b.status).toBe('rejected');
      expect(c.status === 'fulfilled' && c.value.rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
    expect(takePgConcurrencyViolations()).toEqual([]);
  });

  it("Prisma includes with several relations inside a transaction don't overlap", async () => {
    const tenants = await prismaAdmin.$transaction((tx) =>
      tx.tenant.findMany({ include: { users: true, subscription: true, settings: true }, take: 3 }),
    );
    expect(tenants.length).toBeGreaterThan(0);
    expect(takePgConcurrencyViolations()).toEqual([]);
  });

  it('inSequence returns a typed tuple and runs the tasks one by one', async () => {
    const tenant = seeded().malik;
    const order: string[] = [];
    const [users, count] = await withTenant(tenant.id, (tx) =>
      inSequence([
        async () => {
          order.push('a:start');
          const rows = await tx.user.findMany();
          order.push('a:end');
          return rows;
        },
        async () => {
          order.push('b:start');
          return tx.user.count();
        },
      ]),
    );
    expect(users.length).toBe(count);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(takePgConcurrencyViolations()).toEqual([]);
  });
});
