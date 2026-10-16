/**
 * Step 14 seed: the material story of Malik & Sons' "DHA Phase 6 · 10 Marla" so the Control pages
 * have something to say. Runs after the stock demo and the schedule (prisma/seedSchedule.ts):
 *
 *   - one site purchase per supplier for every milestone already worked (paid from the bank, so
 *     no new udhaar) and one usage entry linked to the milestone, dated on the milestone's actual
 *     start / end: the APPROVED estimate quota × the work done × a site factor —
 *       cement × 1.06 on the ground-floor slab (extra lenter cement) → with the stock demo's
 *       usage the project is ~15 % OVER on cement (MATERIAL_OVERUSE, WARNING)
 *       bricks × 1.03, sand × 0.97, steel × 1.03, the rest × 1.00 (on track)
 *     prices: cement 2 % and steel 4 % above the estimate rate (price variance), others at it.
 *   - the first-floor slab is promised to the owner within 5 team-days (two shuttering teams):
 *     its effort drops to 5, the plan is recomputed (plan version + 1) and the slab — 20 % done —
 *     is now behind its plan (MILESTONE_BEHIND_PLAN).
 *   - the alert engine runs once for the project (alerts + notifications as the daily job would).
 * Every document goes through the real services (stock ledger, supplier ledger, audit).
 * Idempotent / guarded: skipped without a schedule or the stock demo, or when already applied.
 */
import { Prisma } from '../src/core/db/prisma.js';
import { withTenant, type Tx } from '../src/core/db/withTenant.js';
import { todayIn } from '../src/core/utils/dates.js';
import { uuidv7 } from '../src/core/utils/uuid.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { storage } from '../src/modules/attachments/storage.provider.js';
import { evaluateProject } from '../src/modules/control/alerts/engine.js';
import { loadApprovedEstimate } from '../src/modules/control/estimate.js';
import { D, type Actor } from '../src/modules/inventory/stock.js';
import { recordUsageTx } from '../src/modules/inventory/usage.service.js';
import { createPurchaseTx, receivePurchaseTx } from '../src/modules/procurement/purchases.service.js';
import { recomputePlan } from '../src/modules/schedule/schedule.shared.js';

export const CONTROL_SEED_NOTE = 'Material for this milestone (site record)';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const at = (date: string, hourPkt = 11) => new Date(`${date}T${String(hourPkt - 5).padStart(2, '0')}:00:00.000Z`);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Site factor per material name (quantity used ÷ estimate quota for the work done). */
const QTY_FACTOR: Record<string, number> = { 'Clay bricks Class-1': 1.03, 'Chenab sand': 0.97, 'Steel Grade-60 #4': 1.03 };
/** Price paid ÷ estimate rate. */
const PRICE_FACTOR: Record<string, number> = { 'Cement OPC': 1.02, 'Steel Grade-60 #4': 1.04 };
const SUPPLIER_OF: Record<string, string> = {
  'Cement OPC': 'Al-Madina Cement Agency',
  'Steel Grade-60 #4': 'Ittefaq Steel Traders',
  'Clay bricks Class-1': 'Chaudhry Bricks Kiln',
};
const DEFAULT_SUPPLIER = 'Bilal Traders';

export interface ControlSeedInput {
  tenantId: string;
  ownerId: string;
  rafaqatId: string;
  dhaProjectId: string;
}

export async function seedMalikControl(db: PrismaClient, t: ControlSeedInput): Promise<{ skipped: boolean }> {
  const schedule = await db.schedule.findFirst({ where: { projectId: t.dhaProjectId }, select: { id: true } });
  if (!schedule) return { skipped: true };
  if (!(await db.purchase.count({ where: { tenantId: t.tenantId } }))) return { skipped: true }; // no stock demo
  if (await db.materialUsage.count({ where: { tenantId: t.tenantId, projectId: t.dhaProjectId, note: CONTROL_SEED_NOTE } })) return { skipped: true };

  const owner: Actor = { tenantId: t.tenantId, userId: t.ownerId, role: 'THEKEDAR', seesRates: true, seesFinancials: true };
  const munshi: Actor = { tenantId: t.tenantId, userId: t.rafaqatId, role: 'MUNSHI', seesRates: false, seesFinancials: false };
  const today = todayIn('Asia/Karachi');

  await withTenant(
    t.tenantId,
    async (tx: Tx) => {
      const estimate = await loadApprovedEstimate(tx, t.tenantId, t.dhaProjectId);
      if (!estimate) return;
      const milestones = await tx.milestone.findMany({ where: { scheduleId: schedule.id, actualStart: { not: null } }, include: { quotas: true, stage: { select: { stageKey: true } } }, orderBy: { sortOrder: 'asc' } });
      const materialIds = [...new Set(milestones.flatMap((m) => m.quotas.map((q) => q.materialId)).filter((x): x is string => Boolean(x)))];
      const mats = new Map((await tx.material.findMany({ where: { tenantId: t.tenantId, id: { in: materialIds } }, select: { id: true, name: true, unit: true } })).map((m) => [m.id, m]));
      const suppliers = new Map((await tx.supplier.findMany({ where: { tenantId: t.tenantId } })).map((s) => [s.name, s.id]));
      let n = 0;
      for (const m of milestones) {
        const share = m.status === 'DONE' || m.status === 'CURING' ? 1 : m.progressPercent / 100;
        if (share <= 0) continue;
        const items: Array<{ materialId: string; name: string; qty: number; ratePaisa: bigint }> = [];
        for (const q of m.quotas) {
          const mat = q.materialId ? mats.get(q.materialId) : undefined;
          const rate = q.materialId ? estimate.rates.get(q.materialId) : undefined;
          if (!mat || !rate || q.ownerSupplied || mat.unit !== q.unit) continue;
          const factor = mat.name === 'Cement OPC' ? (m.key === 'GF_STRUCTURE.SLAB' ? 1.06 : 1) : (QTY_FACTOR[mat.name] ?? 1);
          const qty = mat.unit === 'nos' ? Math.round(Number(q.plannedQty) * share * factor) : r3(Number(q.plannedQty) * share * factor);
          if (qty <= 0) continue;
          const existing = items.find((i) => i.materialId === mat.id);
          if (existing) existing.qty = mat.unit === 'nos' ? existing.qty + qty : r3(existing.qty + qty);
          else items.push({ materialId: mat.id, name: mat.name, qty, ratePaisa: BigInt(Math.round(rate.ratePaisa * (PRICE_FACTOR[mat.name] ?? 1))) });
        }
        if (!items.length) continue;
        const start = m.actualStart!.toISOString().slice(0, 10);
        const end = (m.actualEnd?.toISOString().slice(0, 10) ?? start) > today ? today : (m.actualEnd?.toISOString().slice(0, 10) ?? start);
        const bySupplier = new Map<string, typeof items>();
        for (const i of items) {
          const s = SUPPLIER_OF[i.name] ?? DEFAULT_SUPPLIER;
          bySupplier.set(s, [...(bySupplier.get(s) ?? []), i]);
        }
        for (const [supplierName, list] of bySupplier) {
          const supplierId = suppliers.get(supplierName);
          if (!supplierId) continue;
          n += 1;
          const challanAttachmentId = uuidv7();
          let key = `${t.tenantId}/2026/10/${challanAttachmentId}.png`;
          try {
            key = await storage().put(key, PNG, 'image/png');
          } catch {
            // keep the key; only the challan preview is missing
          }
          await tx.attachment.create({
            data: { id: challanAttachmentId, tenantId: t.tenantId, kind: 'CHALLAN', storageKey: key, fileName: `S14-${n}.png`, mimeType: 'image/png', sizeBytes: PNG.length, uploadedById: t.ownerId },
          });
          const p = await createPurchaseTx(
            tx,
            owner,
            {
              supplierId,
              deliverTo: 'SITE',
              projectId: t.dhaProjectId,
              challanNo: `S14-${String(n).padStart(3, '0')}`,
              purchaseDate: start,
              paymentMode: 'CASH',
              paidFrom: 'BANK',
              challanAttachmentId,
              note: `For ${m.name}`,
              items: list.map((i) => ({ materialId: i.materialId, challanQty: D(i.qty), ratePaisa: i.ratePaisa })),
            },
            { at: at(start, 9) },
          );
          await receivePurchaseTx(tx, munshi, p.id, { items: list.map((i) => ({ materialId: i.materialId, countedQty: D(i.qty) })) }, { at: at(start, 12) });
        }
        await recordUsageTx(
          tx,
          munshi,
          t.dhaProjectId,
          { usageDate: end, milestoneId: m.id, note: CONTROL_SEED_NOTE, items: items.map((i) => ({ materialId: i.materialId, qty: new Prisma.Decimal(i.qty) })) },
          { at: at(end, 18) },
        );
      }

      // First-floor slab promised within 5 team-days → behind its plan.
      const slab = milestones.find((m) => m.key === 'F1_STRUCTURE.SLAB' && m.status === 'IN_PROGRESS');
      if (slab && Number(slab.workDays) > 5) {
        await tx.milestone.update({ where: { id: slab.id }, data: { workDays: new Prisma.Decimal(5) } });
        await recomputePlan(tx, { tenantId: t.tenantId, userId: t.ownerId }, schedule.id, { reason: 'MILESTONE_EDITED', note: 'Lenter promised to the owner within the week (two shuttering teams)' });
      }

      // The daily alert check, once (alerts + notifications).
      const project = await tx.project.findUniqueOrThrow({ where: { id: t.dhaProjectId } });
      await evaluateProject(tx, t.tenantId, project, { actorId: null });
    },
    { timeout: 180_000 },
  );
  return { skipped: false };
}
