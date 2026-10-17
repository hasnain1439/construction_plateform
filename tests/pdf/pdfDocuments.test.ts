/**
 * Step 18 · PDFs: every producer uses the one letterhead (templates.ts shell), the shared page
 * setup (renderer.ts pdfPageOptions: A4, margins, footer with "Page X of Y" + generated-on date),
 * and its language — Urdu documents are right-to-left with the embedded Nastaliq font.
 * Owner-facing documents (customer quotation, change order slip, invoice, receipt, statement,
 * handover certificate, owner shopping list) never show internal costs, overheads, contingency,
 * margins, markups or redacted-rate notes. The renderer is swapped for a recorder: these tests
 * check the HTML the renderer is given, not the binary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOGS, tr, type Lang, type MessageKey } from '../../src/core/i18n/index.js';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { pdfPageOptions, setPdfRenderer } from '../../src/core/pdf/renderer.js';
import { esc, rs as rupees } from '../../src/core/pdf/templates.js';
import { pay, stageInvoice, stagesOf, today } from '../billing/fixtures.js';
import { api, attachment, owner, rs, type Auth } from '../inventory/fixtures.js';
import { projectRow, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const LANGS: Lang[] = ['en', 'roman', 'ur'];

interface Call {
  html: string;
  footerText: string;
  lang: Lang;
}
const calls: Call[] = [];
function recordPdfs() {
  calls.length = 0;
  setPdfRenderer({
    async render(html, { footerText, lang }) {
      calls.push({ html, footerText, lang });
      return Buffer.from('%PDF-1.4 test');
    },
  });
}
afterEach(() => setPdfRenderer(null));

/** The last document in `lang` whose title is `titleKey` (a stored PDF may be reused, so search all renders). */
function rendered(lang: Lang, titleKey: MessageKey): Call {
  const needle = `<h2>${esc(tr(lang, titleKey))}</h2>`;
  const c = [...calls].reverse().find((x) => x.lang === lang && x.html.includes(needle));
  if (!c) throw new Error(`no ${titleKey} PDF in ${lang} (${calls.length} renders)`);
  return c;
}

async function ok(req: PromiseLike<{ status: number; body: unknown }>, what: string) {
  const res = await req;
  if (res.status !== 200) throw new Error(`${what} ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/** Visible text: no CSS, no tags. */
const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

/** Internal words (any language the document is in may still carry English user data). */
const INTERNAL_WORDS = /\b(costs?|costing|overheads?|contingency|margins?|mark-?ups?|rate hidden|rulebook rate|internal)\b/i;
/** Labels only internal documents use — none may appear on an owner-facing one, in its language. */
const INTERNAL_LABELS: MessageKey[] = [
  'pdf.directCost',
  'pdf.estimatedCost',
  'pdf.costPerSqft',
  'pdf.margin',
  'pdf.internalOnly',
  'pdf.finishingAllowance',
  'estimate.section.SITE_OVERHEADS' as MessageKey,
  'estimate.section.CONTINGENCY' as MessageKey,
];

const OWNER_FACING: Array<[string, MessageKey]> = [
  ['customer quotation', 'pdf.quote'],
  ['change order slip', 'pdf.changeOrder'],
  ['invoice', 'pdf.invoice'],
  ['receipt', 'pdf.receipt'],
  ['owner statement', 'pdf.statement'],
  ['handover certificate', 'pdf.handoverCertificate'],
  ['owner shopping list', 'pdf.ownerShoppingList'],
];

/** Makes every company PDF in every language; returns the internal numbers that must stay hidden. */
async function makeEveryPdf(o: Auth) {
  const t = seeded().malik.id;
  const dha = seeded().projects.dha.id;

  // Quote in negotiation (seed): price + internal cost / margin.
  const quotes = (await ok(api().get('/api/v1/quotes?limit=50').set(o), 'quotes')).body as { data: Array<{ id: string; status: string }> };
  const quoteId = quotes.data.find((q) => q.status === 'NEGOTIATION')!.id;
  const quote = (await ok(api().get(`/api/v1/quotes/${quoteId}`).set(o), 'quote')).body as { data: { latest: Record<string, unknown> & { sections: Array<{ amountPaisa?: string }> } } };
  const r = quote.data.latest;

  // Change order: cost 100 × Rs 200, 25 % markup → owner price Rs 250.
  const co = await api()
    .post(`/api/v1/projects/${dha}/change-orders`)
    .set(o)
    .send({ title: 'Extra bathroom tiles', type: 'ADDITION', markupPercent: 25, lines: [{ kind: 'OTHER', description: 'Wall tiles to the ceiling', unit: 'sqft', quantity: 100, ratePaisa: rs(200) }] });
  expect(co.status, JSON.stringify(co.body)).toBe(201);

  // Invoice + payment on DHA.
  const [, plinth] = await stagesOf(dha);
  const inv = await stageInvoice(o, dha, plinth!.id);
  const payment = (await pay(o, dha, { amountPaisa: rs(1_000_000) })).body.data as { id: string };

  // Handover: a project in close-out with the owner's sign-off.
  const p = await projectRow(t, 'Gulberg · 1 Kanal', { status: 'CLOSEOUT' });
  const signature = await attachment(o, 'SITE_PHOTO');
  await ok(api().post(`/api/v1/projects/${p.id}/handover/sign-off`).set(o).send({ ownerName: 'Ahmed Raza', signedOn: today(), signatureAttachmentId: signature }), 'sign-off');

  // Estimate revision (internal BoQ).
  const est = (await ok(api().get(`/api/v1/projects/${dha}/estimates`).set(o), 'estimates')).body as { data: Array<{ id: string }> | { items: Array<{ id: string }> } };
  const estimateId = (Array.isArray(est.data) ? est.data : est.data.items)[0]!.id;

  // Tax report letterhead carries the STRN.
  await ok(api().patch('/api/v1/tax/settings').set(o).send({ strn: '3277876123456' }), 'tax settings');

  recordPdfs();
  const tables: Record<string, Partial<Record<Lang, Call>>> = { report: {}, book: {}, tax: {} };
  for (const lang of LANGS) {
    await ok(api().get(`/api/v1/quotes/${quoteId}/pdf`).set(o).query({ variant: 'customer', lang }), 'quote customer');
    await ok(api().get(`/api/v1/quotes/${quoteId}/pdf`).set(o).query({ variant: 'internal', lang }), 'quote internal');
    await ok(api().get(`/api/v1/change-orders/${co.body.data.id}/pdf`).set(o).query({ lang }), 'slip');
    await ok(api().get(`/api/v1/invoices/${inv.id}/pdf`).set(o).query({ lang }), 'invoice');
    await ok(api().get(`/api/v1/payments/${payment.id}/receipt-pdf`).set(o).query({ lang }), 'receipt');
    await ok(api().get(`/api/v1/projects/${dha}/owner-statement/pdf`).set(o).query({ lang }), 'statement');
    await ok(api().get(`/api/v1/projects/${p.id}/handover/certificate`).set(o).query({ lang }), 'certificate');
    await ok(api().get(`/api/v1/projects/${dha}/owner-shopping-list/pdf`).set(o).query({ lang }), 'shopping list');
    await ok(api().get(`/api/v1/estimates/${estimateId}/pdf`).set(o).query({ lang }), 'estimate');
    await ok(api().get('/api/v1/reports/stock-valuation').set(o).query({ format: 'pdf', lang }), 'report');
    tables.report![lang] = calls.at(-1)!;
    await ok(api().get(`/api/v1/reports/delay-analysis/${dha}`).set(o).query({ format: 'pdf', lang }), 'report book');
    tables.book![lang] = calls.at(-1)!;
    await ok(api().get('/api/v1/reports/tax-invoice-register').set(o).query({ format: 'pdf', lang }), 'tax report');
    tables.tax![lang] = calls.at(-1)!;
  }
  return {
    tables,
    hidden: {
      quote: [r.costPaisa, r.marginPaisa, r.directCostPaisa, r.overheadPaisa, r.contingencyPaisa, ...r.sections.map((s) => s.amountPaisa)].filter((v): v is string => typeof v === 'string' && v !== '0'),
      // change order cost (100 × Rs 200) and markup (Rs 5,000)
      slip: [rs(20_000), rs(5_000)],
    },
  };
}

describe('Step 18 — PDFs', () => {
  it('every PDF: one letterhead, the shared page setup (Page X of Y, generated-on), its language; Urdu = RTL + embedded font', async () => {
    const o = await owner();
    const company = await prismaAdmin.tenant.findUniqueOrThrow({ where: { id: seeded().malik.id } });
    const { tables } = await makeEveryPdf(o);

    const docs: Array<[string, (lang: Lang) => Call]> = [
      ...OWNER_FACING.map(([name, key]): [string, (lang: Lang) => Call] => [name, (lang) => rendered(lang, key)]),
      ['internal quote costing', (lang) => rendered(lang, 'pdf.quoteInternal')],
      ['estimate (BoQ)', (lang) => rendered(lang, 'pdf.estimate')],
      ['report', (lang) => tables.report![lang]!],
      ['report book', (lang) => tables.book![lang]!],
      ['tax report', (lang) => tables.tax![lang]!],
    ];
    for (const [name, of] of docs) {
      for (const lang of LANGS) {
        const c = of(lang);
        const where = `${name} (${lang})`;
        expect(c.lang, where).toBe(lang); // the language reaches the renderer (footer)
        // letterhead: company, address, NTN with its label, document title + meta
        expect(c.html, where).toContain('data-pdf="letterhead"');
        expect(c.html, where).toContain(`<h1>${esc(company.name)}</h1>`);
        expect(c.html, where).toContain(`${esc(tr(lang, 'pdf.ntn'))} <bdi dir="ltr">${company.ntn}</bdi>`);
        expect(c.html, where).toMatch(/<div class="doc"><h2>[^<]+<\/h2><div class="muted">.+<\/div><\/div>/);
        if (lang === 'ur') {
          expect(c.html, where).toContain('<html lang="ur" dir="rtl">');
          expect(c.html, where).toContain("@font-face { font-family: 'Noto Nastaliq Urdu'");
          expect(c.html, where).toContain('data:font/woff2;base64,');
        } else {
          expect(c.html, where).toContain('dir="ltr"><head>');
          expect(c.html, where).not.toContain('@font-face');
        }
        // footer: the page setup the renderer uses for this document
        const page = pdfPageOptions(c.footerText, c.lang, '2026-10-16');
        expect(page, where).toMatchObject({ format: 'A4', displayHeaderFooter: true, printBackground: true, margin: { top: '14mm', bottom: '18mm', left: '14mm', right: '14mm' } });
        expect(page.footerTemplate, where).toContain('<span class="pageNumber"></span>');
        expect(page.footerTemplate, where).toContain('<span class="totalPages"></span>');
        expect(page.footerTemplate, where).toContain(`${esc(tr(lang, 'pdf.page'))} <bdi dir="ltr">`);
        expect(page.footerTemplate, where).toContain('16 Oct 2026');
        expect(page.footerTemplate, where).toContain(`dir="${lang === 'ur' ? 'rtl' : 'ltr'}"`);
      }
    }
    // STRN: on tax reports only (a taxed invoice prints its own issue-time snapshot)
    expect(tables.tax!.en!.html).toContain('STRN <bdi dir="ltr">3277876123456</bdi>');
    expect(rendered('en', 'pdf.statement').html).not.toContain('3277876123456');
    expect(rendered('en', 'pdf.handoverCertificate').html).not.toContain('3277876123456');
    // the footer's Urdu words
    expect(pdfPageOptions('x', 'ur').footerTemplate).toContain('صفحہ');
  });

  it('owner-facing PDFs never show internal costs, overheads, contingency, margins, markups or hidden-rate notes', async () => {
    const o = await owner();
    const { hidden } = await makeEveryPdf(o);
    expect(hidden.quote.length).toBeGreaterThanOrEqual(5); // cost, margin, direct, overheads, contingency (+ sections)
    for (const [name, key] of OWNER_FACING) {
      for (const lang of LANGS) {
        const where = `${name} (${lang})`;
        const html = rendered(lang, key).html;
        const text = visible(html);
        expect(text, where).not.toMatch(INTERNAL_WORDS);
        for (const k of INTERNAL_LABELS) expect(text, `${where}: ${k}`).not.toContain(CATALOGS[lang][k]);
        expect(html, where).not.toContain('Paisa');
      }
    }
    for (const lang of LANGS) {
      const quote = rendered(lang, 'pdf.quote').html;
      for (const v of hidden.quote) expect(quote, `quote ${lang} ${v}`).not.toContain(rupees(v));
      const slip = rendered(lang, 'pdf.changeOrder').html;
      expect(slip, `slip ${lang}`).toContain(rupees(rs(25_000))); // owner price total
      for (const v of hidden.slip) expect(slip, `slip ${lang} ${v}`).not.toContain(`${rupees(v)}<`);
      // the shopping list carries no money at all
      expect(rendered(lang, 'pdf.ownerShoppingList').html, `shopping ${lang}`).not.toContain('Rs ');
      expect(rendered(lang, 'pdf.handoverCertificate').html, `certificate ${lang}`).not.toContain('Rs ');
    }
    // …while the internal documents do carry them (the check above is not vacuous)
    expect(visible(rendered('en', 'pdf.quoteInternal').html)).toMatch(/Margin/);
    expect(visible(rendered('en', 'pdf.estimate').html)).toMatch(/Contingency/);
  });
});
