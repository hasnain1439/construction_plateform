/**
 * Step 15 seed: change orders of Malik & Sons' "DHA Phase 6 · 10 Marla" (needs the billing demo —
 * the first one is billed on its own VARIATION invoice):
 *   CO-001  Extra bathroom tiles (2nd bathroom, full height)  APPROVED (WhatsApp screenshot) → BILLED
 *           on an issued VARIATION invoice; +3 working days → revised contract / end date
 *   CO-002  Extra electrical points in the lounge + 2 bedrooms  SENT (waiting for the owner)
 *   CO-003  Skylight above the stairs — DRAFT made from Rafaqat's site instruction SI-001 (CONVERTED)
 *   SI-002  Owner asked for a second gate — still NEW for the office
 * Everything goes through the module services. Idempotent: skipped when the project has change orders.
 */
import { withTenant, type Tx } from '../src/core/db/withTenant.js';
import { Prisma } from '../src/core/db/prisma.js';
import { dateOnly, todayIn } from '../src/core/utils/dates.js';
import { uuidv7 } from '../src/core/utils/uuid.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { storage } from '../src/modules/attachments/storage.provider.js';
import type { BillingActor } from '../src/modules/billing/billing.shared.js';
import { issueTx, writeLines, writeTotals } from '../src/modules/billing/invoices.service.js';
import { createTx as createChangeOrderTx } from '../src/modules/change-orders/changeOrders.service.js';
import type { CoActor } from '../src/modules/change-orders/changeOrders.shared.js';
import { convertTx, createTx as createInstructionTx } from '../src/modules/change-orders/siteInstructions.service.js';
import { changeOrderCode, syncScheduleDays } from '../src/modules/change-orders/totals.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const daysAgo = (n: number) => new Date(Date.parse(`${todayIn('Asia/Karachi')}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const at = (date: string, hourPkt = 11) => new Date(`${date}T${String(hourPkt - 5).padStart(2, '0')}:00:00.000Z`);
const D = (v: number) => new Prisma.Decimal(v);

export interface ChangeOrderSeedInput {
  tenantId: string;
  ownerId: string;
  bilalId: string;
  rafaqatId: string;
  dhaProjectId: string;
}

async function photo(tx: Tx, tenantId: string, userId: string, name: string) {
  const id = uuidv7();
  let key = `${tenantId}/2026/10/${id}.png`;
  try {
    key = await storage().put(key, PNG, 'image/png');
  } catch {
    // keep the key; only the preview is missing
  }
  await tx.attachment.create({ data: { id, tenantId, kind: 'SITE_PHOTO', storageKey: key, fileName: name, mimeType: 'image/png', sizeBytes: PNG.length, uploadedById: userId } });
  return id;
}

export async function seedMalikChangeOrders(db: PrismaClient, t: ChangeOrderSeedInput): Promise<{ skipped: boolean }> {
  if (await db.changeOrder.count({ where: { projectId: t.dhaProjectId } })) return { skipped: true };
  const all = { rates: true, amounts: true, profit: true, contract: true };
  const owner: CoActor = { tenantId: t.tenantId, userId: t.ownerId, role: 'THEKEDAR', fields: all };
  const bilal: CoActor = { tenantId: t.tenantId, userId: t.bilalId, role: 'PM', fields: { ...all, amounts: false, profit: false, contract: false } };
  const rafaqat = { tenantId: t.tenantId, userId: t.rafaqatId, role: 'MUNSHI' as const };
  await withTenant(
    t.tenantId,
    async (tx) => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: t.dhaProjectId } });
      if (project.status !== 'ACTIVE' && project.status !== 'CLOSEOUT') return;
      const tiles = await tx.material.findFirst({ where: { tenantId: t.tenantId, name: 'Floor tiles' }, select: { id: true } });
      const tileLaying = await tx.laborRate.findFirst({ where: { tenantId: t.tenantId, key: 'TILE_LAYING' }, select: { id: true } });
      const finishing = await tx.milestone.findFirst({ where: { tenantId: t.tenantId, projectId: project.id, key: 'FINISHING.TILES' }, select: { id: true } });

      // CO-001 — extra bathroom tiles: approved on WhatsApp, billed on its own invoice.
      const co1 = await createChangeOrderTx(tx, owner, project, {
        title: 'Extra bathroom tiles (2nd bathroom, full height)',
        description: 'Owner wants wall tiles up to the ceiling in bathroom 2 (was 4 ft dado).',
        type: 'ADDITION',
        markupPercent: D(10),
        daysImpact: 3,
        affectedMilestoneIds: finishing ? [finishing.id] : [],
        lines: [
          ...(tiles ? [{ kind: 'MATERIAL' as const, materialId: tiles.id, description: 'Wall tiles 12×24 (bathroom 2, above dado)', quantity: D(180) }] : []),
          tileLaying
            ? { kind: 'LABOUR' as const, laborRateId: tileLaying.id, description: 'Tile fixing (wall)', quantity: D(180) }
            : { kind: 'LABOUR' as const, description: 'Tile fixing (wall)', unit: 'sqft', quantity: D(180), ratePaisa: 4500n },
          { kind: 'OTHER' as const, description: 'Tile adhesive, grout and spacers', unit: 'job', quantity: D(1), ratePaisa: 1_200_000n },
        ],
      });
      const shot = await photo(tx, t.tenantId, t.ownerId, 'whatsapp-ok.png');
      await tx.changeOrder.update({
        where: { id: co1.id },
        data: {
          status: 'APPROVED',
          sentAt: at(daysAgo(12), 10),
          approvedOn: dateOnly(daysAgo(11)),
          approvedAt: at(daysAgo(11), 19),
          approvedById: t.ownerId,
          proofType: 'WHATSAPP_SCREENSHOT',
          proofAttachmentIds: [shot],
          billingMode: 'VARIATION',
          startedAt: at(daysAgo(9)),
          createdAt: at(daysAgo(12), 9),
        },
      });
      const lines = await tx.changeOrderLine.findMany({ where: { changeOrderId: co1.id }, orderBy: { sortOrder: 'asc' } });
      const ba: BillingActor = { tenantId: t.tenantId, userId: t.ownerId, role: 'THEKEDAR', seesFinancials: true, seesRates: true };
      const inv = await tx.invoice.create({ data: { tenantId: t.tenantId, projectId: project.id, clientId: project.clientId, type: 'VARIATION', notes: `${co1.code} · ${co1.title}`, createdById: t.ownerId, createdAt: at(daysAgo(6)) } });
      await writeLines(
        tx,
        t.tenantId,
        inv.id,
        lines.map((l) => ({ description: `${co1.code} · ${l.description}`, quantity: l.quantity, unit: l.unit, ratePaisa: l.priceRatePaisa, amountPaisa: l.priceAmountPaisa, sourceType: 'CHANGE_ORDER' as const, sourceId: co1.id })),
      );
      await writeTotals(tx, ba, inv.id);
      await issueTx(tx, ba, inv.id, { issueDate: daysAgo(5) }, { at: at(daysAgo(5)) });

      // CO-002 — extra electrical points: sent, waiting for the owner.
      const co2 = await createChangeOrderTx(tx, bilal, project, {
        title: 'Extra electrical points (lounge + 2 bedrooms)',
        description: '6 extra switch / socket points and 2 AC points requested during the site visit.',
        type: 'ADDITION',
        markupPercent: D(12),
        daysImpact: 1,
        lines: [
          { kind: 'OTHER', description: 'Switch / socket point (wiring, box, plate)', unit: 'point', quantity: D(6), ratePaisa: 350_000n },
          { kind: 'OTHER', description: 'AC point with 7/29 wire', unit: 'point', quantity: D(2), ratePaisa: 950_000n },
        ],
      });
      await tx.changeOrder.update({ where: { id: co2.id }, data: { status: 'SENT', sentAt: at(daysAgo(3), 16), createdAt: at(daysAgo(3), 12) } });

      // SI-001 (Rafaqat, from site) → CO-003 draft; SI-002 still new.
      const si1 = await createInstructionTx(
        tx,
        rafaqat,
        project.id,
        { note: 'Owner wants a skylight above the stairs instead of the plain slab', photoIds: [await photo(tx, t.tenantId, t.rafaqatId, 'stairs.png')] },
        { at: at(daysAgo(2), 15) },
      );
      await convertTx(tx, bilal, si1.data.id, { title: 'Skylight above the stairs', daysImpact: 2 });
      await createInstructionTx(tx, rafaqat, project.id, { note: 'Owner asked for a second gate on the back lane', photoIds: [await photo(tx, t.tenantId, t.rafaqatId, 'back-lane.png')] }, { at: at(daysAgo(1), 12) });

      await syncScheduleDays(tx, t.tenantId, project.id);
      if (co1.code !== changeOrderCode(1)) throw new Error('change order seed: unexpected numbering');
    },
    { timeout: 120_000 },
  );
  return { skipped: false };
}
