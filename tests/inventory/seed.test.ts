import { describe, expect, it } from 'vitest';
import { seedMalikInventory } from '../../prisma/seedInventory.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase } from '../helpers.js';
import { api, owner, storeOf, supplierId } from './fixtures.js';

const seeded = useFreshDatabase();

async function seedInventory() {
  const s = seeded();
  return seedMalikInventory(prismaAdmin, {
    tenantId: s.malik.id,
    ownerId: s.users.khalid.id,
    bilalId: s.users.bilal.id,
    rafaqatId: s.users.rafaqatMalik.id,
    projects: s.projects,
  });
}

describe('procurement & inventory seed', () => {
  it('builds the Malik & Sons demo: balances, store average ≈ 1,453, gate passes, shortages', async () => {
    expect(await seedInventory()).toEqual({ skipped: false });
    expect(await seedInventory()).toEqual({ skipped: true }); // idempotent

    const t = seeded().malik.id;
    const auth = await owner();
    const balance = async (name: string) => (await api().get(`/api/v1/suppliers/${await supplierId(t, name)}`).set(auth)).body.data.udhaarBalancePaisa;
    expect(await balance('Al-Madina Cement Agency')).toBe('74000000');
    expect(await balance('Ittefaq Steel Traders')).toBe('121000000');
    expect(await balance('Chaudhry Bricks Kiln')).toBe('32500000');
    expect(await balance('Bilal Traders')).toBe('11500000');
    expect(await balance('Punjab Shuttering Yard')).toBe('8600000');

    const { store } = await storeOf(t);
    const stock = (await api().get(`/api/v1/stores/${store.id}/stock`).set(auth)).body.data;
    const row = (name: string) => stock.items.find((i: { material: { name: string } }) => i.material.name === name);
    expect(row('Cement OPC')).toMatchObject({ inStore: 216, inTransit: 100, avgRatePaisa: '145302', minQty: 200, lowStock: false });
    expect(row('Clay bricks Class-1')).toMatchObject({ inStore: 11950 });
    expect(row('Steel Grade-60 #4')).toMatchObject({ inStore: 1, inTransit: 1 });
    expect(row('Chenab sand')).toMatchObject({ inStore: 0, lowStock: true });
    expect(stock.summary).toMatchObject({ lowStockCount: 2, dispatchesOnTheWay: 2 });

    const gps = (await api().get('/api/v1/dispatches?limit=10').set(auth)).body.data.map((d: { number: string; status: string }) => [d.number, d.status]);
    expect(gps.sort()).toEqual([
      ['GP-0140', 'RECEIVED'],
      ['GP-0141', 'CANCELLED'],
      ['GP-0142', 'RECEIVED_WITH_SHORTAGE'],
      ['GP-0143', 'ON_THE_WAY'],
      ['GP-0144', 'ON_THE_WAY'],
    ]);
    const shortages = (await api().get('/api/v1/shortages?status=OPEN').set(auth)).body;
    expect(shortages.data.map((x: { kind: string; qty: number }) => [x.kind, x.qty]).sort()).toEqual([
      ['DAMAGED', 200],
      ['DISPATCH_SHORT', 10],
    ]);

    const purchases = (await api().get('/api/v1/purchases?limit=20').set(auth)).body.data.map((p: { challanNo: string; status: string }) => [p.challanNo, p.status]);
    expect(purchases.sort()).toEqual([
      ['BT-451', 'RECEIVED'],
      ['CB-1150', 'SAVED'],
      ['CB-1190', 'PENDING_RECEIPT'],
      ['CH-2198', 'SAVED'],
      ['CH-2231', 'SAVED'],
      ['IT-8812', 'SAVED'],
    ]);
    const payments = (await api().get('/api/v1/supplier-payments?status=BOUNCED').set(auth)).body.data;
    expect(payments).toEqual([expect.objectContaining({ chequeNo: '00412377', status: 'BOUNCED' })]);

    const counts = (await api().get(`/api/v1/stock-counts?locationId=${store.id}`).set(auth)).body.data;
    expect(counts[0]).toMatchObject({ number: 'SC-0001', items: [{ difference: -4, reason: 'HARDENED_IN_RAIN' }, { difference: -50, reason: 'BREAKAGE' }] });

    const dha = (await api().get(`/api/v1/projects/${seeded().projects.dha.id}/stock`).set(auth)).body.data;
    const cement = dha.items.find((i: { material: { name: string } }) => i.material.name === 'Cement OPC');
    expect(cement.receivedContractor).toBe(190);
    expect(cement.inStock).toBe(190 - cement.used);
  });
});
