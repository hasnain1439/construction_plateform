/**
 * Step 12 seed: Malik & Sons' quotes in every pipeline state, priced by the real quick-mode engine
 * (company rulebook + price list) inside a tenant transaction (RLS applies):
 *   Q-…-0001 WON          Ahmed Raza · DHA Phase 6 · 10 Marla — Rev 2 negotiated to Rs 1,85,00,000,
 *                          linked to the existing project MSB-2026-012 (createdFromQuoteId set)
 *   Q-…-0002 LOST         Farah Naz · Askari 11 · 5 Marla — competitor cheaper
 *   Q-…-0003 SENT         Hamid Ali · Valencia · 1 Kanal — sent 8 days ago, no reply (follow-up list)
 *   Q-…-0004 NEGOTIATION  Waqas Butt (new client) · Bahria Orchard · 8 Marla — Rev 2 at a lower margin
 *   Q-…-0005 DRAFT        Nadia Hussain (new client) · Wapda Town · 7 Marla — labour only
 *   Q-…-0006 EXPIRED      Usman Tariq Sheikh · Gulberg · 1 Kanal — validity ran out
 * Idempotent: nothing is written when the company already has quotes.
 */
import { nextNumber } from '../src/core/db/counters.js';
import { withTenant, type Tx } from '../src/core/db/withTenant.js';
import { Prisma, type PrismaClient, type QuoteLostReason, type QuoteStatus } from '../src/generated/prisma/client.js';
import { computeQuote } from '../src/modules/sales/quote.compute.js';
import { QUOTE_NUMBER_FORMAT, revisionData } from '../src/modules/sales/sales.service.js';
import type { QuoteInputsInput } from '../src/modules/sales/sales.schema.js';

const DAY = 86_400_000;
const ago = (days: number, hour = 11) => {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hour - 5, 0, 0, 0); // hour:00 PKT
  return d;
};
const dateOnly = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

interface SeedQuote {
  client: string;
  title: string;
  siteAddress: string;
  status: QuoteStatus;
  createdDaysAgo: number;
  sentDaysAgo?: number;
  lastActivityDaysAgo: number;
  validDays?: number;
  revisions: Array<{ inputs: QuoteInputsInput; note?: string; by: 'owner' | 'bilal' }>;
  lost?: { reason: QuoteLostReason; note: string };
  negotiation?: string;
  wonProjectId?: string;
  fixed?: { createdAt: Date; sentAt: Date; wonAt: Date };
}

export async function seedMalikQuotes(
  db: PrismaClient,
  t: { tenantId: string; ownerId: string; bilalId: string; clients: Record<string, { id: string }>; dhaProjectId: string },
) {
  if (await db.quote.count({ where: { tenantId: t.tenantId } })) return;
  const extra = [
    { name: 'Waqas Butt', phone: '+923335551122' },
    { name: 'Nadia Hussain', phone: '+923004447788' },
  ];
  const clients: Record<string, { id: string }> = { ...t.clients };
  for (const c of extra) {
    clients[c.name] = await db.client.upsert({ where: { tenantId_phone: { tenantId: t.tenantId, phone: c.phone } }, create: { tenantId: t.tenantId, ...c, createdById: t.ownerId }, update: {} });
  }

  const tenMarla: QuoteInputsInput = {
    plot: { unit: 'MARLA', size: 10, frontFt: 35, depthFt: 65 },
    coveredAreaSqft: 3950,
    floors: 2,
    mumty: true,
    basement: false,
    basementHeightFt: 10,
    structureType: 'FRAMED',
    contractType: 'GREY_OWNER_FINISHING',
  };
  const quotes: SeedQuote[] = [
    {
      client: 'Ahmed Raza',
      title: 'DHA Phase 6 · 10 Marla',
      siteAddress: 'House 214, Sector C, DHA Phase 6',
      status: 'WON',
      createdDaysAgo: 0,
      lastActivityDaysAgo: 0,
      fixed: { createdAt: new Date('2026-02-10T11:00:00+05:00'), sentAt: new Date('2026-02-12T16:00:00+05:00'), wonAt: new Date('2026-03-01T12:00:00+05:00') },
      revisions: [
        { inputs: tenMarla, note: 'First price for the owner meeting', by: 'owner' },
        { inputs: { ...tenMarla, finalPricePaisa: 1_850_000_000n }, note: 'Agreed Rs 1.85 crore after the site visit', by: 'owner' },
      ],
      wonProjectId: t.dhaProjectId,
    },
    {
      client: 'Farah Naz',
      title: 'Askari 11 · 5 Marla',
      siteAddress: 'Plot 31, Sector B, Askari 11',
      status: 'LOST',
      createdDaysAgo: 60,
      sentDaysAgo: 58,
      lastActivityDaysAgo: 45,
      revisions: [{ inputs: { plot: { unit: 'MARLA', size: 5, frontFt: 25, depthFt: 45 }, coveredAreaSqft: 2050, floors: 2, mumty: true, basement: false, basementHeightFt: 10, structureType: 'LOAD_BEARING', contractType: 'GREY_OWNER_FINISHING' }, by: 'bilal' }],
      lost: { reason: 'COMPETITOR_CHEAPER', note: 'Another builder quoted about Rs 300 per sq ft less' },
    },
    {
      client: 'Hamid Ali',
      title: 'Valencia · 1 Kanal',
      siteAddress: 'House 41, Block H, Valencia Town',
      status: 'SENT',
      createdDaysAgo: 9,
      sentDaysAgo: 8,
      lastActivityDaysAgo: 8,
      revisions: [{ inputs: { plot: { unit: 'KANAL', size: 1, frontFt: 50, depthFt: 90 }, coveredAreaSqft: 6200, floors: 2, mumty: true, basement: false, basementHeightFt: 10, structureType: 'FRAMED', contractType: 'FULL', marginPercent: 18 }, by: 'owner' }],
    },
    {
      client: 'Waqas Butt',
      title: 'Bahria Orchard · 8 Marla',
      siteAddress: 'Plot 118, Block E, Bahria Orchard',
      status: 'NEGOTIATION',
      createdDaysAgo: 12,
      sentDaysAgo: 6,
      lastActivityDaysAgo: 2,
      revisions: [
        { inputs: { plot: { unit: 'MARLA', size: 8, frontFt: 30, depthFt: 60 }, coveredAreaSqft: 3300, floors: 2, mumty: true, basement: false, basementHeightFt: 10, structureType: 'FRAMED', contractType: 'GREY_OWNER_FINISHING' }, by: 'bilal' },
        { inputs: { plot: { unit: 'MARLA', size: 8, frontFt: 30, depthFt: 60 }, coveredAreaSqft: 3300, floors: 2, mumty: true, basement: false, basementHeightFt: 10, structureType: 'FRAMED', contractType: 'GREY_OWNER_FINISHING', marginPercent: 15 }, note: 'Client asked for a better price — margin 15 %', by: 'owner' },
      ],
      negotiation: 'Client is comparing with one more builder; wants the price under Rs 1.3 crore',
    },
    {
      client: 'Nadia Hussain',
      title: 'Wapda Town · 7 Marla',
      siteAddress: 'House 9, Block K, Wapda Town',
      status: 'DRAFT',
      createdDaysAgo: 1,
      lastActivityDaysAgo: 1,
      revisions: [{ inputs: { plot: { unit: 'MARLA', size: 7, frontFt: 30, depthFt: 52.5 }, coveredAreaSqft: 2800, floors: 2, mumty: true, basement: false, basementHeightFt: 10, structureType: 'FRAMED', contractType: 'LABOR_ONLY' }, by: 'bilal' }],
    },
    {
      client: 'Usman Tariq Sheikh',
      title: 'Gulberg · 1 Kanal',
      siteAddress: 'House 77-B, Gulberg III',
      status: 'EXPIRED',
      createdDaysAgo: 42,
      sentDaysAgo: 40,
      lastActivityDaysAgo: 40,
      validDays: 15,
      revisions: [{ inputs: { plot: { unit: 'KANAL', size: 1, frontFt: 50, depthFt: 90 }, coveredAreaSqft: 7400, floors: 2, mumty: true, basement: true, basementHeightFt: 10, structureType: 'FRAMED', contractType: 'FULL' }, by: 'owner' }],
    },
  ];

  await withTenant(
    t.tenantId,
    async (tx: Tx) => {
      const log = (quoteId: string, action: string, at: Date, by: string | null, details: Prisma.InputJsonValue) =>
        tx.auditLog.create({ data: { tenantId: t.tenantId, actorType: by ? 'USER' : 'SYSTEM', actorId: by, action, entityType: 'Quote', entityId: quoteId, details, createdAt: at } });
      for (const s of quotes) {
        const comps = [];
        for (const r of s.revisions) comps.push(await computeQuote(tx, t.tenantId, r.inputs));
        const last = comps[comps.length - 1]!;
        const created = s.fixed?.createdAt ?? ago(s.createdDaysAgo, 10);
        const sent = s.fixed?.sentAt ?? (s.sentDaysAgo !== undefined ? ago(s.sentDaysAgo, 16) : null);
        const lastActivity = s.fixed?.wonAt ?? ago(s.lastActivityDaysAgo, 17);
        const validUntil = dateOnly(new Date((sent ?? created).getTime() + (s.validDays ?? 15) * DAY));
        const number = await nextNumber(tx, t.tenantId, QUOTE_NUMBER_FORMAT);
        const ownerOf = (by: 'owner' | 'bilal') => (by === 'owner' ? t.ownerId : t.bilalId);
        const q = await tx.quote.create({
          data: {
            tenantId: t.tenantId,
            number,
            clientId: clients[s.client]!.id,
            title: s.title,
            siteAddress: s.siteAddress,
            city: 'Lahore',
            status: s.status,
            validUntil,
            revision: comps.length,
            contractType: last.inputs.contractType,
            coveredAreaSqft: last.inputs.coveredAreaSqft,
            pricePaisa: last.pricePaisa ?? 0n,
            perSqftPaisa: last.perSqftPaisa,
            sentAt: sent,
            lastActivityAt: lastActivity,
            wonAt: s.status === 'WON' ? (s.fixed?.wonAt ?? lastActivity) : null,
            wonProjectId: s.wonProjectId ?? null,
            lostAt: s.lost ? lastActivity : null,
            lostReason: s.lost?.reason ?? null,
            lostNote: s.lost?.note ?? null,
            expiredAt: s.status === 'EXPIRED' ? new Date(validUntil.getTime() + DAY + 20 * 3_600_000) : null,
            createdById: ownerOf(s.revisions[0]!.by),
            createdAt: created,
          },
        });
        for (const [i, comp] of comps.entries()) {
          const r = s.revisions[i]!;
          const at = i === 0 ? created : new Date(Math.min(lastActivity.getTime(), (sent ?? created).getTime() + DAY));
          await tx.quoteRevision.create({ data: { ...revisionData(comp, t.tenantId, q.id, i + 1, r.note, ownerOf(r.by)), createdAt: at } });
          await log(q.id, i === 0 ? 'quote.create' : 'quote.revision', at, ownerOf(r.by), { number, revision: i + 1, pricePaisa: (comp.pricePaisa ?? 0n).toString() });
        }
        if (sent) await log(q.id, 'quote.send', sent, t.ownerId, { number, revision: comps.length, validUntil: validUntil.toISOString().slice(0, 10), from: 'DRAFT' });
        if (s.negotiation) await log(q.id, 'quote.negotiation', lastActivity, t.ownerId, { number, from: 'SENT', note: s.negotiation });
        if (s.lost) await log(q.id, 'quote.lost', lastActivity, t.bilalId, { number, from: 'SENT', reason: s.lost.reason, note: s.lost.note });
        if (s.status === 'EXPIRED') await log(q.id, 'quote.expire', q.expiredAt!, null, { number, from: 'SENT', validUntil: validUntil.toISOString().slice(0, 10) });
        if (s.status === 'WON' && s.wonProjectId) {
          await log(q.id, 'quote.won', lastActivity, t.ownerId, { number, from: 'SENT', revision: comps.length, projectId: s.wonProjectId, pricePaisa: (last.pricePaisa ?? 0n).toString() });
          await tx.project.update({ where: { id: s.wonProjectId }, data: { createdFromQuoteId: q.id } });
        }
      }
    },
    { timeout: 120_000 },
  );
}
