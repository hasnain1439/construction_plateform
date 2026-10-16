/**
 * Step 14 × Step 16 part 2 · EQUIPMENT_IDLE plug-in rule.
 *
 * Wraps `idleRentals()` (src/modules/equipment/idle.ts) — the one idle detection — so idle rentals
 * also show up as ControlAlert rows (dashboard, control summary, project alert lists). Step 16 keeps
 * the notification: its own daily `equipment-idle` job sends EQUIPMENT_IDLE, so this rule keeps
 * `notify: false` (no second notification, no second job). Threshold = TenantSettings.equipmentIdleDays.
 * Texts / details never carry money (the daily rent stays behind fields.rates in the equipment module).
 */
import { idleRentals } from '../../../equipment/idle.js';
import { registerAlertRule, type AlertRule, type Finding } from '../registry.js';
import { equipmentIdlePlaceholder } from './builtin.js';

export const equipmentIdleRule: AlertRule = {
  ...equipmentIdlePlaceholder,
  placeholder: false,
  notify: false,
  evaluate: async (ctx) => {
    const rows = await idleRentals(ctx.tx, ctx.tenantId, ctx.today, { projectId: ctx.project.id });
    return rows
      .filter((r) => r.idle && r.project.id === ctx.project.id)
      .map(
        (r): Finding => ({
          dedupeKey: `EQUIPMENT_IDLE:${r.rental.id}`,
          refType: 'RENTAL',
          refId: r.rental.id,
          severity: 'WARNING',
          text: {
            key: 'controlEquipmentIdle',
            params: { project: ctx.project.name, equipment: r.items.map((i) => i.equipment.name).join(', '), qty: r.qty, days: r.idleDays },
          },
          details: { rentalId: r.rental.id, rentalNumber: r.rental.number, qty: r.qty, idleDays: r.idleDays, thresholdDays: r.thresholdDays, since: r.since, hasSchedule: r.hasSchedule },
          actionUrl: `/equipment/rentals/${r.rental.id}`,
        }),
      );
  },
};

registerAlertRule(equipmentIdleRule);
