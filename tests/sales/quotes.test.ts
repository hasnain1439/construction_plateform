/**
 * Step 12 · quotes: seed pipeline, numbering, quick estimate + price, customer PDF never shows
 * internal numbers, send / negotiation / lost (reason required) / won → pre-filled DRAFT project
 * (idempotent), expiry job, field gating and permissions, win / loss insights.
 * Seed (prisma/seedSales.ts): Q-…-0001 WON (DHA project), 0002 LOST, 0003 SENT 8 days ago,
 * 0004 NEGOTIATION, 0005 DRAFT (labour only), 0006 EXPIRED.
 */
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { setPdfRenderer } from '../../src/core/pdf/renderer.js';
import { rs } from '../../src/core/pdf/templates.js';
import { runQuoteExpiry } from '../../src/jobs/quoteExpiry.js';
import { api, bearer, grantFinancials, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);
const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric' }).format(new Date());

const INPUTS = {
  plot: { unit: 'MARLA', size: 8, frontFt: 30, depthFt: 60 },
  coveredAreaSqft: 3300,
  floors: 2,
  mumty: true,
  structureType: 'FRAMED',
  contractType: 'GREY_OWNER_FINISHING',
  marginPercent: 20,
};

type Stage = { label: string; percent: number; amountPaisa?: string };
type Rev = Record<string, unknown> & { pricePaisa?: string; costPaisa?: string; marginPaisa?: string; perSqftPaisa?: string; paymentStages: Stage[]; quantities: Record<string, number>; sections: Array<{ section: string; amountPaisa?: string }> };
type Detail = Record<string, unknown> & { id: string; number: string; status: string; revision: number; validUntil: string; latest: Rev; activity: Array<{ action: string }> };

async function createQuote(auth: Record<string, string>, extra: Record<string, unknown> = {}) {
  const res = await api()
    .post('/api/v1/quotes')
    .set(auth)
    .send({ clientId: seeded().clients['Farah Naz']!.id, title: 'Bahria Orchard · 8 Marla', siteAddress: 'Plot 118, Block E', city: 'Lahore', inputs: INPUTS, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as Detail;
}

describe('seeded pipeline', () => {
  it('six quotes in every state, numbered Q-YYYY-0001…0006; the WON one is linked to the DHA project', async () => {
    const auth = await owner();
    const res = await api().get('/api/v1/quotes?limit=50').set(auth);
    expect(res.status).toBe(200);
    const list = res.body.data as Array<{ number: string; status: string; wonProject: { id: string } | null; followUp: boolean; title: string }>;
    expect(list.map((q) => q.status).sort()).toEqual(['DRAFT', 'EXPIRED', 'LOST', 'NEGOTIATION', 'SENT', 'WON']);
    expect(list.map((q) => q.number).sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Q-${year}-000${n}`));
    const won = list.find((q) => q.status === 'WON')!;
    expect(won.wonProject?.id).toBe(seeded().projects.dha.id);
    expect((await prismaAdmin.project.findUniqueOrThrow({ where: { id: seeded().projects.dha.id } })).createdFromQuoteId).toBeTruthy();
    expect(list.filter((q) => q.followUp).map((q) => q.title)).toEqual(['Valencia · 1 Kanal']);
    const follow = await api().get('/api/v1/quotes?followUp=true').set(auth);
    expect(follow.body.data).toHaveLength(1);
  });
});

describe('create → quick estimate + price', () => {
  it('numbers the next quote, prices it with the engine: cost × 1.2 → Rs 1,000; stages add up to 100 % and the price; audited', async () => {
    const auth = await owner();
    const q = await createQuote(auth);
    expect(q).toMatchObject({ number: `Q-${year}-0007`, status: 'DRAFT', revision: 1 });
    const r = q.latest;
    const cost = BigInt(r.costPaisa!);
    expect(cost).toBeGreaterThan(0n);
    // grey structure, margin 20 %: price = cost × 1.2 rounded to the nearest Rs 1,000 (100,000 paisa)
    expect(Math.abs(Number(BigInt(r.pricePaisa!) - (cost * 12n) / 10n))).toBeLessThanOrEqual(50_000);
    expect(BigInt(r.pricePaisa!) % 100_000n).toBe(0n);
    expect(r.perSqftPaisa).toBe(String(Math.round(Number(r.pricePaisa) / 3300)));
    expect(BigInt(r.marginPaisa!)).toBe(BigInt(r.pricePaisa!) - cost);
    expect(r.paymentStages.reduce((a, s) => a + s.percent, 0)).toBe(100);
    expect(r.paymentStages.reduce((a, s) => a + BigInt(s.amountPaisa!), 0n)).toBe(BigInt(r.pricePaisa!));
    for (const k of ['cementBags', 'steelKg', 'bricks', 'sandCft', 'plasterSqft']) expect(r.quantities[k], k).toBeGreaterThan(0);
    expect(r.sections.map((s) => s.section)).toEqual(expect.arrayContaining(['CONCRETE', 'STEEL', 'MASONRY', 'SITE_OVERHEADS', 'CONTINGENCY']));
    // valid for the company quoteValidityDays (15)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
    expect(q.validUntil).toBe(new Date(Date.parse(`${today}T00:00:00Z`) + 15 * 86_400_000).toISOString().slice(0, 10));
    expect(await prismaAdmin.auditLog.count({ where: { action: 'quote.create', entityId: q.id } })).toBe(1);
    // the live preview gives the same numbers
    const prev = await api().post('/api/v1/quotes/preview').set(auth).send({ inputs: INPUTS });
    expect(prev.status).toBe(200);
    expect(prev.body.data.pricePaisa).toBe(r.pricePaisa);
    // the next quote takes the next number
    expect((await createQuote(auth)).number).toBe(`Q-${year}-0008`);
  });

  it('inline new client, negotiated price, bad inputs', async () => {
    const auth = await owner();
    const q = await createQuote(auth, { clientId: undefined, newClient: { name: 'Sajid Mehmood', phone: '0300-1112233' }, inputs: { ...INPUTS, finalPricePaisa: '1300000000' } });
    expect(q.latest).toMatchObject({ pricePaisa: '1300000000', priceOverridden: true });
    expect(await prismaAdmin.client.count({ where: { phone: '+923001112233' } })).toBe(1);
    const bad = await api().post('/api/v1/quotes').set(auth).send({ clientId: seeded().clients['Farah Naz']!.id, title: 'x', inputs: INPUTS });
    expect(bad.status).toBe(400);
  });
});

describe('PDFs', () => {
  it('the customer quotation never shows costs, overheads, contingency or margin; the internal costing does', async () => {
    const calls: string[] = [];
    setPdfRenderer({ async render(html) { calls.push(html); return Buffer.from('%PDF-1.4 test'); } });
    try {
      const auth = await owner();
      const q = await createQuote(auth);
      const r = q.latest;
      const cust = await api().get(`/api/v1/quotes/${q.id}/pdf?variant=customer&lang=en`).set(auth);
      expect(cust.status, JSON.stringify(cust.body)).toBe(200);
      const html = calls.at(-1)!;
      expect(html).toContain(rs(r.pricePaisa!));
      expect(html).toContain(rs(r.perSqftPaisa!));
      expect(html).toContain('100%');
      for (const hidden of [rs(r.costPaisa!), rs(r.marginPaisa!), rs(r.directCostPaisa as string), rs(r.overheadPaisa as string), rs(r.contingencyPaisa as string)]) expect(html).not.toContain(hidden);
      const text = html.replace(/<style[\s\S]*?<\/style>/g, ''); // CSS has margin-*
      for (const word of ['Margin', 'margin', 'Estimated cost', 'Direct cost', 'Contingency', 'Site overheads', 'Internal', 'Paisa']) expect(text).not.toContain(word);
      for (const s of r.sections) expect(html).not.toContain(rs(s.amountPaisa!));
      // QA-A-05: grey + owner finishing — paint / tiles are the owner's, not "Work included"
      expect(r.sections.find((s) => s.section === 'PAINT')?.amountPaisa).toBe('0');
      const included = /Work included<\/td><td>([^<]*)</.exec(html)![1]!;
      const byOwner = /By the owner \/ not included<\/td><td>([^<]*)</.exec(html)![1]!;
      expect(included).not.toContain('Paint');
      expect(byOwner).toContain('Paint');
      expect(included.length).toBeGreaterThan(0);
      // phones are formatted (QA-A-33)
      expect(html).not.toMatch(/\+92\d{10}/);

      const internal = await api().get(`/api/v1/quotes/${q.id}/pdf?variant=internal&lang=en`).set(auth);
      expect(internal.status).toBe(200);
      const ih = calls.at(-1)!;
      expect(ih).toContain(rs(r.costPaisa!));
      expect(ih).toContain(rs(r.marginPaisa!));
      expect(ih).toContain('Margin');
      // overheads / contingency once (in the totals), not again in the section list (QA-A-33)
      expect(ih.split('Site overheads').length - 1).toBe(1);
      expect(ih.split('Contingency').length - 1).toBe(1);

      // Urdu customer PDF renders right-to-left
      expect((await api().get(`/api/v1/quotes/${q.id}/pdf?lang=ur`).set(auth)).status).toBe(200);
      expect(calls.at(-1)).toContain('dir="rtl"');
    } finally {
      setPdfRenderer(null);
    }
  });
});

describe('status actions', () => {
  it('send → negotiation → lost (reason required, OTHER needs a note) → closed', async () => {
    setPdfRenderer({ async render() { return Buffer.from('%PDF-1.4 test'); } });
    try {
      const auth = await owner();
      const q = await createQuote(auth);
      const sent = await api().post(`/api/v1/quotes/${q.id}/send`).set(auth).send({ lang: 'roman' });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body.data.quote.status).toBe('SENT');
      expect(sent.body.data.share).toMatchObject({ url: expect.any(String), clientPhone: '+923318889900', whatsappText: expect.stringContaining(q.number) });
      // the PM (no contract-value permission) cannot send a price
      const pmSend = await api().post(`/api/v1/quotes/${q.id}/send`).set(await pm()).send({});
      expect(pmSend.status).toBe(403);

      const neg = await api().post(`/api/v1/quotes/${q.id}/negotiation`).set(auth).send({ note: 'Wants 5 % off' });
      expect(neg.body.data.status).toBe('NEGOTIATION');

      expect((await api().post(`/api/v1/quotes/${q.id}/lost`).set(auth).send({ note: 'gone' })).body.error.code).toBe('VALIDATION_ERROR');
      expect((await api().post(`/api/v1/quotes/${q.id}/lost`).set(auth).send({ reason: 'OTHER' })).body.error.code).toBe('LOST_NOTE_REQUIRED');
      const lost = await api().post(`/api/v1/quotes/${q.id}/lost`).set(auth).send({ reason: 'SELF_BUILD', note: 'Will build with his own mistri' });
      expect(lost.body.data).toMatchObject({ status: 'LOST', lostReason: 'SELF_BUILD' });
      expect((await api().post(`/api/v1/quotes/${q.id}/won`).set(auth).send({})).body.error.code).toBe('QUOTE_CLOSED');
      expect((await api().post(`/api/v1/quotes/${q.id}/revisions`).set(auth).send({ inputs: INPUTS })).body.error.code).toBe('QUOTE_CLOSED');
      const actions = (await api().get(`/api/v1/quotes/${q.id}`).set(auth)).body.data.activity.map((a: { action: string }) => a.action);
      expect(actions).toEqual(['quote.lost', 'quote.negotiation', 'quote.send', 'quote.create']);
    } finally {
      setPdfRenderer(null);
    }
  });

  it('mark won makes a pre-filled DRAFT project and links it — idempotent', async () => {
    const auth = await owner();
    const q = await createQuote(auth, { inputs: { ...INPUTS, basement: true, basementHeightFt: 9, supplyRules: [{ categoryKey: 'STEEL', suppliedBy: 'OWNER' }] } });
    const rev2 = await api().post(`/api/v1/quotes/${q.id}/revisions`).set(auth).send({ inputs: { ...INPUTS, basement: true, basementHeightFt: 9, supplyRules: [{ categoryKey: 'STEEL', suppliedBy: 'OWNER' }], finalPricePaisa: '1250000000' }, note: 'Agreed' });
    expect(rev2.status).toBe(201);
    expect(rev2.body.data).toMatchObject({ revision: 2, pricePaisa: '1250000000' });

    expect((await api().post(`/api/v1/quotes/${q.id}/won`).set(await pm()).send({})).status).toBe(403);
    const res = await api().post(`/api/v1/quotes/${q.id}/won`).set(auth).send({ startDate: '2026-11-01' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ created: true, quote: { status: 'WON' } });
    const p = await prismaAdmin.project.findUniqueOrThrow({
      where: { id: res.body.data.projectId },
      include: { floors: { orderBy: { sortOrder: 'asc' } }, supplyRules: true, billingStages: { orderBy: { sortOrder: 'asc' } } },
    });
    expect(p).toMatchObject({
      status: 'DRAFT',
      name: 'Bahria Orchard · 8 Marla',
      clientId: seeded().clients['Farah Naz']!.id,
      siteAddress: 'Plot 118, Block E',
      contractType: 'GREY_OWNER_FINISHING',
      billingModel: 'STAGE_SCHEDULE',
      contractValuePaisa: 1_250_000_000n,
      plotUnit: 'MARLA',
      structureType: 'FRAMED',
      hasBasement: true,
      createdFromQuoteId: q.id,
      wizardCompletedSteps: [1, 2, 3, 4],
    });
    expect(Number(p.plotSize)).toBe(8);
    expect(Number(p.frontFt)).toBe(30);
    expect(Number(p.coveredAreaSqft)).toBe(3300);
    expect(Number(p.basementHeightFt)).toBe(9);
    expect(p.startDate?.toISOString().slice(0, 10)).toBe('2026-11-01');
    expect(p.endDate?.toISOString().slice(0, 10)).toBe('2027-11-01');
    expect(p.floors.map((f) => [f.level, Number(f.ceilingHeightFt)])).toEqual([
      ['BASEMENT', 9],
      ['GROUND', 11],
      ['FIRST', 10],
      ['MUMTY', 9],
    ]);
    const rule = (k: string) => p.supplyRules.find((r) => r.categoryKey === k)!;
    expect(rule('STEEL')).toMatchObject({ suppliedBy: 'OWNER', qualityCategoryId: null });
    expect(rule('CEMENT').suppliedBy).toBe('CONTRACTOR');
    expect(rule('CEMENT').qualityCategoryId).toBeTruthy();
    expect(rule('PAINT').suppliedBy).toBe('OWNER');
    expect(p.billingStages.reduce((a, s) => a + Number(s.percent), 0)).toBe(100);
    expect(p.billingStages.reduce((a, s) => a + s.amountPaisa, 0n)).toBe(1_250_000_000n);
    expect(await prismaAdmin.auditLog.count({ where: { action: 'project.create', entityId: p.id } })).toBe(1);

    const again = await api().post(`/api/v1/quotes/${q.id}/won`).set(auth).send({});
    expect(again.body.data).toMatchObject({ created: false, projectId: p.id });
    expect(await prismaAdmin.project.count({ where: { createdFromQuoteId: q.id } })).toBe(1);
    expect((await api().delete(`/api/v1/quotes/${q.id}`).set(auth)).body.error.code).toBe('QUOTE_WON');
  });

  it('labour-only won sets the rate per sq ft', async () => {
    const auth = await owner();
    const draft = (await api().get('/api/v1/quotes?status=DRAFT').set(auth)).body.data.find((x: { contractType: string }) => x.contractType === 'LABOR_ONLY');
    const res = await api().post(`/api/v1/quotes/${draft.id}/won`).set(auth).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = await prismaAdmin.project.findUniqueOrThrow({ where: { id: res.body.data.projectId } });
    expect(p.contractType).toBe('LABOR_ONLY');
    expect(p.contractValuePaisa).toBeNull();
    expect(p.ratePerSqftPaisa?.toString()).toBe(draft.perSqftPaisa);
  });
});

describe('expiry job', () => {
  it('SENT / NEGOTIATION past validity → EXPIRED (SYSTEM audit), DRAFT untouched, idempotent; a revision re-opens it', async () => {
    const auth = await owner();
    const a = await createQuote(auth);
    const b = await createQuote(auth);
    await prismaAdmin.quote.update({ where: { id: a.id }, data: { status: 'SENT', sentAt: new Date(), validUntil: new Date('2026-01-01T00:00:00Z') } });
    await prismaAdmin.quote.update({ where: { id: b.id }, data: { validUntil: new Date('2026-01-01T00:00:00Z') } }); // still DRAFT
    const first = await runQuoteExpiry();
    expect(first.expired).toContain(a.id);
    expect(first.expired).not.toContain(b.id);
    expect((await prismaAdmin.quote.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('EXPIRED');
    expect((await prismaAdmin.quote.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('DRAFT');
    expect(await prismaAdmin.auditLog.findFirst({ where: { action: 'quote.expire', entityId: a.id } })).toMatchObject({ actorType: 'SYSTEM' });
    expect((await runQuoteExpiry()).expired).toEqual([]);
    expect((await api().post(`/api/v1/quotes/${a.id}/send`).set(auth).send({})).body.error.code).toBe('QUOTE_STATUS_INVALID');
    const re = await api().post(`/api/v1/quotes/${a.id}/revisions`).set(auth).send({ inputs: INPUTS });
    expect(re.body.data).toMatchObject({ status: 'DRAFT', revision: 2 });
  });
});

describe('permissions and field gating', () => {
  it('PM: costs but no price / margin; with financials everything; Munshi nothing; delete is owner-level', async () => {
    const o = await owner();
    const q = await createQuote(o);
    const asPm = (await api().get(`/api/v1/quotes/${q.id}`).set(await pm())).body.data;
    expect(asPm.pricePaisa).toBeUndefined();
    expect(asPm.latest.pricePaisa).toBeUndefined();
    expect(asPm.latest.marginPaisa).toBeUndefined();
    expect(asPm.latest.inputs.marginPercent).toBeUndefined();
    expect(asPm.latest.costPaisa).toBeDefined();
    expect(asPm.latest.paymentStages[0].amountPaisa).toBeUndefined();
    expect((await api().get(`/api/v1/quotes/${q.id}/pdf`).set(await pm())).status).toBe(403);
    expect((await api().delete(`/api/v1/quotes/${q.id}`).set(await pm())).status).toBe(403);

    await grantFinancials(seeded().malik.id, seeded().users.bilal.id);
    const fin = (await api().get(`/api/v1/quotes/${q.id}`).set(await pm())).body.data;
    expect(fin.latest).toMatchObject({ pricePaisa: expect.any(String), marginPaisa: expect.any(String), marginPercent: 20 });

    const munshi = await loginMunshi(seeded().malik.id);
    expect((await api().get('/api/v1/quotes').set(bearer(munshi.accessToken))).status).toBe(403);

    const del = await api().delete(`/api/v1/quotes/${q.id}`).set(o);
    expect(del.body.data).toEqual({ id: q.id, deleted: true });
    expect((await api().get(`/api/v1/quotes/${q.id}`).set(o)).status).toBe(404);
  });

  it('another company cannot see the quotes', async () => {
    const ahmed = bearer((await loginMobile(SEED.ahmed.owner.phone, SEED.ahmed.owner.password)).accessToken);
    expect((await api().get('/api/v1/quotes').set(ahmed)).body.data).toEqual([]);
    const mine = (await api().get('/api/v1/quotes').set(await owner())).body.data[0];
    expect((await api().get(`/api/v1/quotes/${mine.id}`).set(ahmed)).status).toBe(404);
  });
});

describe('win / loss insights', () => {
  it('win rate, loss reasons, follow-ups; money only with the contract permission', async () => {
    const res = await api().get('/api/v1/quotes/insights?months=12').set(await owner());
    expect(res.status).toBe(200);
    const d = res.body.data;
    // DHA quote was made in Feb 2026 — inside 12 months only while today is before Feb 2027
    expect(d.totals.lost).toBe(1);
    expect(d.totals.expired).toBe(1);
    expect(d.lossReasons.find((r: { reason: string }) => r.reason === 'COMPETITOR_CHEAPER').count).toBe(1);
    expect(d.followUps.map((f: { title: string }) => f.title)).toEqual(['Valencia · 1 Kanal']);
    expect(d.perMonth).toHaveLength(12);
    expect(d.winRate).toBe(d.totals.won + d.totals.lost + d.totals.expired ? Math.round((d.totals.won / (d.totals.won + d.totals.lost + d.totals.expired)) * 10000) / 100 : null);
    expect(d.avgRateQuotedPaisa).toEqual(expect.any(String));
    const asPm = (await api().get('/api/v1/quotes/insights').set(await pm())).body.data;
    expect(asPm.avgRateQuotedPaisa).toBeUndefined();
    expect(asPm.wonValuePaisa).toBeUndefined();
  });
});
