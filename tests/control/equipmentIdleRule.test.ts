/**
 * Step 14 × Step 16 part 2 · the EQUIPMENT_IDLE control rule wraps `idleRentals()` on the
 * shuttering demo (RNT-0002: 100 props at Johar Town, no milestone work for 12 days). The rule only
 * keeps ControlAlert rows (dashboard / summary / lists); Step 16's own `equipment-idle` job is the
 * one that notifies, so the engine sends no CONTROL_ALERT notification for it. Never money.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { useFreshDatabase, withSeedSnapshot } from '../helpers.js';
import { api, owner } from '../inventory/fixtures.js';

const seeded = useFreshDatabase();
beforeEach(async () => {
  await withSeedSnapshot('malik_shuttering', seeded());
});

const tenant = () => seeded().malik.id;
const johar = () => seeded().projects.johar.id;
const dha = () => seeded().projects.dha.id;

describe('EQUIPMENT_IDLE control rule (plug-in over equipment/idle.ts)', () => {
  it('is ACTIVE in the registry, opens one alert per idle rental, sends no second notification and resolves when the rental is no longer idle', async () => {
    const auth = await owner();
    const rules = (await api().get('/api/v1/control/alerts/rules').set(auth)).body.data as Array<{ rule: string; status: string; threshold: { setting: string; value: unknown } | null }>;
    expect(rules.find((r) => r.rule === 'EQUIPMENT_IDLE')).toMatchObject({ status: 'ACTIVE', threshold: { setting: 'equipmentIdleDays', value: 5 } });

    const rental = await prismaAdmin.equipmentRental.findFirstOrThrow({ where: { tenantId: tenant(), number: 'RNT-0002' } });
    const notifsBefore = await prismaAdmin.notification.count({ where: { tenantId: tenant() } });

    const run = await api().post('/api/v1/control/alerts/run').set(auth).send({ rules: ['EQUIPMENT_IDLE'] });
    expect(run.status, JSON.stringify(run.body).slice(0, 400)).toBe(200);
    expect(run.body.data).toMatchObject({ opened: 1, notified: 0 });
    const [alert] = run.body.data.alerts as Array<Record<string, unknown> & { project: { id: string }; details: Record<string, unknown> }>;
    expect(alert).toMatchObject({ rule: 'EQUIPMENT_IDLE', status: 'OPEN', severity: 'WARNING', refType: 'RENTAL', refId: rental.id, actionUrl: `/equipment/rentals/${rental.id}`, project: { id: johar() } });
    expect(alert.details).toMatchObject({ rentalNumber: 'RNT-0002', qty: 100, idleDays: 12, thresholdDays: 5 });
    expect(JSON.stringify(alert)).not.toMatch(/Paisa|Rs\s?\d/);
    // Step 16's job owns the notification: the engine adds none (no CONTROL_ALERT rows, nothing new at all)
    expect(await prismaAdmin.notification.count({ where: { tenantId: tenant(), type: 'CONTROL_ALERT' } })).toBe(0);
    expect(await prismaAdmin.notification.count({ where: { tenantId: tenant() } })).toBe(notifsBefore);
    // DHA (slab running) has no idle rental
    const dhaAlerts = (await api().get(`/api/v1/projects/${dha()}/control/alerts`).set(auth)).body.data.items as Array<{ rule: string }>;
    expect(dhaAlerts.filter((a) => a.rule === 'EQUIPMENT_IDLE')).toEqual([]);

    // a second run only refreshes it (same dedupe key)
    const again = await api().post('/api/v1/control/alerts/run').set(auth).send({ projectId: johar(), rules: ['EQUIPMENT_IDLE'] });
    expect(again.body.data).toMatchObject({ opened: 0, updated: 1, notified: 0 });

    // raise the threshold above 12 days → no longer idle → resolved
    await prismaAdmin.tenantSettings.update({ where: { tenantId: tenant() }, data: { equipmentIdleDays: 30 } });
    const after = await api().post('/api/v1/control/alerts/run').set(auth).send({ projectId: johar(), rules: ['EQUIPMENT_IDLE'] });
    expect(after.body.data).toMatchObject({ resolved: 1 });
    const row = await prismaAdmin.controlAlert.findFirstOrThrow({ where: { tenantId: tenant(), dedupeKey: `EQUIPMENT_IDLE:${rental.id}` } });
    expect(row.status).toBe('RESOLVED');
  });
});
