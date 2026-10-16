/**
 * Step 11 seed: the platform estimation rulebook v1 (both regions, PUBLISHED, every value
 * PENDING_ENGINEER_REVIEW — the same rows migration 20261101090000_estimation_rulebook inserts,
 * re-created here because test resets truncate every table) and Malik & Sons' estimates for
 * "DHA Phase 6 · 10 Marla":
 *   - company rulebook value: contingency 7 % (platform 5 %)
 *   - Rev 1 APPROVED (made and approved by Khalid before the company contingency changed)
 *   - Rev 2 DRAFT (with the 7 % contingency; one line overridden by Bilal with a note)
 * Idempotent: rulebook rows are upserted; estimates are only made when the project has none.
 * Estimates are generated through the real engine inside a tenant transaction (RLS applies).
 */
import { withTenant } from '../src/core/db/withTenant.js';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';
import { RULEBOOK_PARAMS, RULEBOOK_REGIONS } from '../src/modules/estimate/rulebookDefs.js';
import { approveInTx, effectivePrice, generateInTx, recomputeTotals } from '../src/modules/estimate/revisions.service.js';

const RULEBOOK_IDS = { PUNJAB_KP: '01920000-0000-7000-8000-00000000b001', KARACHI_SINDH: '01920000-0000-7000-8000-00000000b002' } as const;

export async function seedRulebook(db: PrismaClient) {
  for (const region of RULEBOOK_REGIONS) {
    const existing = await db.rulebook.findUnique({ where: { region_version: { region, version: 1 } } });
    if (existing) continue;
    await db.rulebook.create({
      data: {
        id: RULEBOOK_IDS[region],
        region,
        version: 1,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        notes: 'v1 — built-in Pakistani rules of thumb, every value pending civil-engineer review',
        parameters: {
          create: RULEBOOK_PARAMS.map((d, i) => ({
            key: d.key,
            group: d.group,
            label: d.label.en,
            labelRoman: d.label.roman,
            labelUrdu: d.label.ur,
            description: d.description,
            unit: d.unit,
            value: new Prisma.Decimal(d.value[region]),
            safeMin: new Prisma.Decimal(d.safeMin),
            safeMax: new Prisma.Decimal(d.safeMax),
            reviewStatus: 'PENDING_ENGINEER_REVIEW' as const,
            sortOrder: i + 1,
          })),
        },
      },
    });
  }
}

export async function seedMalikEstimates(db: PrismaClient, t: { tenantId: string; ownerId: string; bilalId: string; dhaProjectId: string }) {
  await seedRulebook(db);
  if (await db.estimate.count({ where: { projectId: t.dhaProjectId } })) return;
  const owner = { tenantId: t.tenantId, userId: t.ownerId };
  const bilal = { tenantId: t.tenantId, userId: t.bilalId };
  await withTenant(
    t.tenantId,
    async (tx) => {
      // Rev 1: made and approved in March, before construction started
      const rev1 = await generateInTx(tx, owner, t.dhaProjectId, 'First estimate for the owner meeting', { audit: false });
      const e1 = await tx.estimate.findUniqueOrThrow({ where: { id: rev1 } });
      await approveInTx(tx, owner, e1, {}, { audit: false });
      await tx.estimate.update({ where: { id: rev1 }, data: { generatedAt: new Date('2026-03-02T10:00:00+05:00'), approvedAt: new Date('2026-03-04T16:30:00+05:00') } });

      // The company now keeps 7 % contingency
      await tx.companyRulebookOverride.create({
        data: { tenantId: t.tenantId, parameterKey: 'contingencyPercent', value: new Prisma.Decimal(7), note: 'Steel and cement prices keep moving — keep more in hand', updatedById: t.ownerId },
      });

      // Rev 2: DRAFT with Bilal's site measurement on the ground-floor bricks
      const rev2 = await generateInTx(tx, bilal, t.dhaProjectId, 'Updated after the price-list revision', { audit: false });
      const line = await tx.estimateLine.findFirst({ where: { estimateId: rev2, kind: 'MATERIAL', material: 'bricks', stageKey: 'GF_STRUCTURE' } });
      if (line) {
        const overrideQuantity = new Prisma.Decimal(Math.ceil((Number(line.quantityWithWastage) * 1.03) / 100) * 100);
        const priced = effectivePrice({ ...line, overrideQuantity, overrideRatePaisa: null });
        await tx.estimateLine.update({
          where: { id: line.id },
          data: {
            overrideQuantity,
            overrideNote: 'Site count: extra bricks for the stair walls and boundary returns',
            overriddenById: t.bilalId,
            overriddenAt: new Date(),
            rateQuantity: priced.rateQuantity,
            amountPaisa: priced.amountPaisa,
          },
        });
        await recomputeTotals(tx, rev2);
      }
    },
    { timeout: 60_000 },
  );
}
