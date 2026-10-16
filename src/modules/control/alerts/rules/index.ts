/**
 * Step 14 · registers every alert rule once (imported by the engine).
 *
 * ── EQUIPMENT_IDLE (Step 16 part 2) — wired: see equipmentIdle.ts (the snippet below is what it does) ──────────────────────────────────
 * Step 16 part 2 owns the detection and the notifications: `idleRentals(tx, tenantId, today, opts)`
 * / `runIdleCheckTx` / `projectActivity` in src/modules/equipment/idle.ts, the `equipmentIdle`
 * alert (EQUIPMENT_IDLE notification, EQUIPMENT_IDLE_DEDUPE_MS) and the daily job `equipment-idle`
 * (09:00 PKT, setting TenantSettings.equipmentIdleDays). Do NOT duplicate any of that here. The
 * control rule only WRAPS `idleRentals` so the idle rentals also appear as ControlAlert rows
 * (dashboard, control summary, project alert lists); the placeholder has `notify: false`, so the
 * engine sends no second notification. Wiring (one file, `equipmentIdle.ts` next to this one):
 *
 *   import { idleRentals } from '../../../equipment/idle.js';
 *   import { registerAlertRule } from '../registry.js';
 *   import { equipmentIdlePlaceholder } from './builtin.js';
 *   registerAlertRule({
 *     ...equipmentIdlePlaceholder,
 *     placeholder: false,
 *     evaluate: async (ctx) =>
 *       (await idleRentals(ctx.tx, ctx.tenantId, ctx.today, { projectId: ctx.project.id })).map((r) => ({
 *         dedupeKey: `EQUIPMENT_IDLE:${r.rental.id}`,          // one alert per rental
 *         refType: 'RENTAL', refId: r.rental.id,
 *         severity: 'WARNING',
 *         text: { key: 'controlEquipmentIdle', params: { project: ctx.project.name, equipment: r.equipment.name, qty: r.qty, days: r.idleDays } },
 *         details: { rentalId: r.rental.id, equipmentId: r.equipment.id, qty: r.qty, idleDays: r.idleDays }, // never money
 *         actionUrl: `/equipment/rentals/${r.rental.id}`,
 *       })),
 *   });
 *
 * (field names follow the Step 16 contract `[{ rental, project, equipment, qty, idleDays }]` —
 * adjust to idleRentals' actual return), then add `import './equipmentIdle.js';` below the marker.
 * The real rule replaces the placeholder (a placeholder never replaces a real rule).
 */
import { registerAlertRule } from '../registry.js';
import { equipmentIdlePlaceholder, materialOveruse, milestoneBehindPlan, missingDailyLog, quotaExhausted, spendAheadOfProgress, stageReadyUnbilled } from './builtin.js';

let done = false;

export function registerBuiltinRules(): void {
  if (done) return;
  done = true;
  for (const r of [materialOveruse, milestoneBehindPlan, quotaExhausted, spendAheadOfProgress, equipmentIdlePlaceholder, missingDailyLog, stageReadyUnbilled]) registerAlertRule(r);
}

registerBuiltinRules();
// ─── Plug-in rules (one import per module) ───────────────────────────────────
import './equipmentIdle.js'; // Step 16 part 2: EQUIPMENT_IDLE wraps idleRentals() (notify: false)
