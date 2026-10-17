/**
 * QA fixes, area B — the pure pieces: wide report tables (landscape / split / totals row), whole-rupee
 * report money, bidi islands, export file names + Content-Disposition, plan-version notes, the
 * status-aware change-order WhatsApp text, milestone template keys and the PDF queue.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pdfQueue, renderPdf, setPdfRenderer } from '../../src/core/pdf/renderer.js';
import { invoiceHtml, isWideTable, qtyUnit, reportCell, reportHtml, rsWhole, rupeesWhole, splitColumns, type ReportColumnType } from '../../src/core/pdf/templates.js';
import { contentDisposition } from '../../src/modules/attachments/storage.provider.js';
import { changeOrderWhatsapp } from '../../src/modules/change-orders/slip.js';
import { exportFileName } from '../../src/modules/reports/reports.export.js';
import { bookHtml, bookIsWide } from '../../src/modules/reports/reports.book.js';
import { MILESTONE_NAMES, templateKeyOf } from '../../src/modules/schedule/milestoneNames.js';
import { milestoneEditedNote, renderPlanNote, stoppageApprovedNote } from '../../src/modules/schedule/planNotes.js';

const company = { name: 'Malik & Sons', ntn: null, address: null, phone: null, logoUrl: null };
const col = (key: string, type: ReportColumnType = 'text') => ({ key, label: key.toUpperCase(), type });
afterEach(() => setPdfRenderer(null));

describe('QA-B-03 / QA-B-12 — wide report tables', () => {
  const material = [col('material'), col('unit'), ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((k) => col(k, 'qty')), col('qtyImpact', 'money'), col('priceImpact', 'money'), col('impact', 'money')];

  it('more than 8 columns → landscape; more than 12 → parts that repeat the leading text columns', () => {
    expect(isWideTable(8)).toBe(false);
    expect(isWideTable(11)).toBe(true); // WHT summary
    expect(splitColumns(material.slice(0, 11))).toHaveLength(1);
    const parts = splitColumns(material);
    expect(parts.map((p) => p.map((c) => c.key))).toEqual([
      ['material', 'unit', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      ['material', 'unit', 'qtyImpact', 'priceImpact', 'impact'],
    ]);
  });

  it('the material table: every column printed, the Total row filled where the totals are (not an empty row)', () => {
    const totals = { ...Object.fromEntries(material.map((c) => [c.key, null])), qtyImpact: '9405860', priceImpact: '875382', impact: '10281242' };
    const html = bookHtml(
      company,
      { name: 'variance-project', title: 'Variance Report', subtitle: 'x', generatedAt: '2026-10-17T05:00:00.000Z', filters: {}, project: { id: 'p', code: 'MSB-1', name: 'DHA', status: 'ACTIVE' }, summary: [], sections: [{ key: 'materials', title: 'Material variance', columns: material, rows: [{ material: 'Cement OPC', unit: 'bag', a: -155.687, qtyImpact: '9405860', priceImpact: '875382', impact: '10281242' }], totals }] },
      'en',
    );
    expect(bookIsWide({ sections: [{ columns: material } as never] })).toBe(true);
    expect(html).toContain('data-part="2"');
    for (const c of material) expect(html).toContain(`>${c.label}</th>`);
    const part2 = html.slice(html.indexOf('data-part="2"'));
    expect(part2).toMatch(/<tr class="total"><td><strong>Total<\/strong><\/td><td><strong><\/strong><\/td><td class="r"><strong><bdi dir="ltr">Rs 94,059<\/bdi>/);
    expect(part2).toContain('Rs 1,02,812'); // whole rupees, no paisa
    // part 1 has no totals → no empty Total row
    expect(html.slice(0, html.indexOf('data-part="2"'))).not.toContain('class="total"');
    // negative quantity stays an LTR island
    expect(html).toContain('<bdi dir="ltr">-155.687</bdi>');
  });

  it('one-table report PDF: landscape flag passed to the renderer for wide tables only', async () => {
    const seen: Array<boolean | undefined> = [];
    setPdfRenderer({ render: async (_h, o) => (seen.push(o.landscape), Buffer.from('%PDF')) });
    const { toPdf } = await import('../../src/modules/reports/reports.export.js');
    const r = { name: 'wht-summary', title: 'WHT Summary', subtitle: '', generatedAt: '2026-10-17T05:00:00.000Z', filters: {}, rows: [], totals: null };
    await toPdf(company, { ...r, columns: Array.from({ length: 11 }, (_, i) => col(`c${i}`)) }, 'ur');
    await toPdf(company, { ...r, columns: [col('a'), col('b')] }, 'ur');
    expect(seen).toEqual([true, undefined]);
  });
});

describe('QA-B-13 / QA-B-11 — report money and bidi', () => {
  it('whole rupees, half away from zero, one sign style', () => {
    expect(rsWhole(1994628)).toBe('Rs 19,946');
    expect(rsWhole(1994650)).toBe('Rs 19,947');
    expect(rsWhole(-4325049)).toBe('−Rs 43,250');
    expect(rsWhole(-30)).toBe('Rs 0');
    expect(rupeesWhole('10894565960')).toBe(108945660);
    expect(rupeesWhole(-150)).toBe(-2);
    expect(reportCell('money', '494896595')).toBe('<bdi dir="ltr">Rs 49,48,966</bdi>');
  });

  it('free text gets dir=auto, quantity + unit one island', () => {
    expect(reportCell('text', 'Owner wants a skylight.')).toBe('<bdi dir="auto">Owner wants a skylight.</bdi>');
    expect(qtyUnit('1', 'job')).toBe('<bdi dir="auto"><bdi dir="ltr">1</bdi> job</bdi>');
    const html = reportHtml({ company, title: 'T', subtitle: 'تمام پروجیکٹ · 17 Oct 2026 تک', generatedOn: '2026-10-17', columns: [col('a')], rows: [], totals: null }, 'ur');
    expect(html).toContain('<bdi dir="auto">تمام پروجیکٹ');
  });
});

describe('QA-B-14 — taxed invoice title', () => {
  const base = { company, number: 'INV-1', issueDate: '2026-10-17', dueDate: null, client: null, project: { name: 'P', code: 'C', siteAddress: null }, lines: [], subtotalPaisa: 100n, taxLabel: null, taxRatePercent: '16', totalPaisa: 116n, paidPaisa: 0n, balancePaisa: 116n, notes: null };
  it('"Sales Tax Invoice" (localized) when the invoice carries tax, else "Invoice"', () => {
    expect(invoiceHtml({ ...base, taxPaisa: 16n }, 'en')).toContain('<h2>SALES TAX INVOICE</h2>');
    expect(invoiceHtml({ ...base, taxPaisa: 16n }, 'ur')).toContain('<h2>سیلز ٹیکس انوائس</h2>');
    expect(invoiceHtml({ ...base, taxPaisa: 0n, totalPaisa: 100n }, 'en')).toContain('<h2>INVOICE</h2>');
  });
});

describe('QA-B-15 — export names', () => {
  it('<report>[-<project code>]-<Pakistan date>.<ext>; Content-Disposition with an ASCII fallback', () => {
    expect(exportFileName('tax-invoice-register', '2026-10-17T05:00:00.000Z', 'xlsx')).toBe('tax-invoice-register-2026-10-17.xlsx');
    expect(exportFileName('variance-project', '2026-10-16T20:30:00.000Z', 'pdf', 'MSB-2026-012')).toBe('variance-MSB-2026-012-2026-10-17.pdf');
    expect(contentDisposition('variance-MSB-2026-012-2026-10-17.pdf')).toBe(`inline; filename="variance-MSB-2026-012-2026-10-17.pdf"; filename*=UTF-8''variance-MSB-2026-012-2026-10-17.pdf`);
    expect(contentDisposition('حساب.pdf', true)).toBe(`attachment; filename="____.pdf"; filename*=UTF-8''${encodeURIComponent('حساب.pdf')}`);
  });
});

describe('QA-B-09 — plan-version notes', () => {
  it('a readable note with the values, in the reader language; old notes made readable too', () => {
    const set = milestoneEditedNote('Mumty walls & roof slab', { startNoEarlierThan: { from: null, to: '2026-11-16' } });
    expect(renderPlanNote('en', set)).toBe('Mumty walls & roof slab: earliest start set to 16 Nov 2026');
    expect(renderPlanNote('roman', set)).toBe('Mumty walls & roof slab: sab se pehle shuru 16 Nov 2026 ko');
    expect(renderPlanNote('en', milestoneEditedNote('Paint', { startNoEarlierThan: { from: '2026-11-16', to: null }, workDays: { from: 6, to: 8 } }))).toBe('Paint: start limit removed, work days 6 → 8');
    expect(renderPlanNote('en', 'Mumty walls & roof slab: startNoEarlierThan')).toBe('Mumty walls & roof slab: earliest start changed');
    expect(renderPlanNote('en', stoppageApprovedNote('RAIN', ['2026-10-12', '2026-10-11']))).toBe('Rain · 11 Oct 2026 – 12 Oct 2026');
    expect(renderPlanNote('ur', 'RAIN · 2026-10-11')).toBe('بارش · 11 Oct 2026');
    expect(renderPlanNote('en', 'Re-planned after the owner meeting')).toBe('Re-planned after the owner meeting');
    expect(renderPlanNote('en', null)).toBeNull();
  });
});

describe('QA-B-16 / QA-B-24 — change-order WhatsApp text', () => {
  const p = { salutation: 'Dear Ahmed', project: 'DHA', code: 'CO-004', title: 'Light points', amount: 'Rs 31,625', days: 2, url: 'https://x' };
  it('asks for approval only while DRAFT / SENT; plural-aware days', () => {
    expect(changeOrderWhatsapp('en', 'SENT', p)).toContain('2 extra working days. Please reply OK to approve');
    expect(changeOrderWhatsapp('en', 'DRAFT', { ...p, days: 1 })).toContain('1 extra working day. Please reply OK');
    for (const s of ['APPROVED', 'IN_PROGRESS', 'COMPLETED', 'BILLED', 'REJECTED'] as const) expect(changeOrderWhatsapp('en', s, p)).not.toContain('reply OK');
    expect(changeOrderWhatsapp('en', 'COMPLETED', { ...p, days: 0 })).toBe('Dear Ahmed, change order CO-004 for DHA: Light points — Rs 31,625. Status: Completed. Details: https://x');
    expect(changeOrderWhatsapp('roman', 'APPROVED', p)).toContain('Status: Manzoor');
  });
});

describe('QA-B-26 — milestone template keys', () => {
  it('the key while the generated name is kept; null once renamed or custom', () => {
    expect(templateKeyOf({ key: 'MUMTY_ROOF.STRUCTURE', name: 'Mumty walls & roof slab' })).toBe('MUMTY_ROOF.STRUCTURE');
    expect(templateKeyOf({ key: 'MUMTY_ROOF.STRUCTURE', name: 'Mumty (owner design)' })).toBeNull();
    expect(templateKeyOf({ key: 'CUSTOM.1', name: 'Boundary wall' })).toBeNull();
    expect(Object.keys(MILESTONE_NAMES)).toHaveLength(17);
  });
});

describe('QA-B-23 — PDF queue', () => {
  it('a burst queues (at most PDF_MAX_CONCURRENT at once) instead of failing', async () => {
    let running = 0;
    let peak = 0;
    setPdfRenderer({
      async render() {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return Buffer.from('%PDF');
      },
    });
    const all = await Promise.all(Array.from({ length: 8 }, () => renderPdf('<p>x</p>', 'f')));
    expect(all).toHaveLength(8);
    expect(peak).toBe(3);
    expect(pdfQueue.stats).toEqual({ running: 0, waiting: 0 });
  });
});
