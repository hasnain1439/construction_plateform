/**
 * QA area A fixes — pure helpers: quote work sections (QA-A-05), phone formatting (QA-A-33), owner
 * shopping list WhatsApp lines (QA-A-09), RATES_MISSING after a rate adjustment (QA-A-11), steel
 * bar names in the BoQ PDF (QA-A-24).
 */
import { describe, expect, it } from 'vitest';
import { buyQuantity, displayPhone, shoppingShareItems } from '../../src/core/pdf/templates.js';
import { pdfLineDescription, ratesFixedByOverride } from '../../src/modules/estimate/revisions.service.js';
import { workSections } from '../../src/modules/sales/sales.service.js';

describe('QA-A-05 quote work sections', () => {
  it('only contractor-priced sections are "included"; owner-only ones are listed apart; overheads / contingency never', () => {
    const r = workSections({
      sections: [
        { section: 'CONCRETE', amountPaisa: '150000000' },
        { section: 'FLOORING_TILES', amountPaisa: '0' },
        { section: 'PAINT', amountPaisa: '0' },
        { section: 'ROOF_WATERPROOFING', amountPaisa: '2500000' },
        { section: 'SITE_OVERHEADS', amountPaisa: '100' },
        { section: 'CONTINGENCY', amountPaisa: '100' },
      ],
    });
    expect(r).toEqual({ included: ['CONCRETE', 'ROOF_WATERPROOFING'], byOwner: ['FLOORING_TILES', 'PAINT'] });
  });
});

describe('QA-A-33 phone formatting', () => {
  it('formats a Pakistani mobile, leaves anything else alone', () => {
    expect(displayPhone('+923001239901')).toBe('+92 300 1239901');
    expect(displayPhone('+924235761234')).toBe('+92 42 35761234');
    expect(displayPhone('042-1234567')).toBe('042-1234567');
  });
});

describe('QA-A-09 owner shopping list text', () => {
  it('lists every item with the "To buy" quantity rounded up and a translated unit', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ description: `Item ${i + 1}`, quantity: i + 0.08, unit: 'bag' }));
    items.push({ description: 'Wall tiles', quantity: 928.4, unit: 'sqft' });
    const text = shoppingShareItems(items, 'en');
    expect(text.split('\n').filter(Boolean)).toHaveLength(9);
    expect(text).toContain('• Item 1 — 1 ');
    expect(text).toContain('• Item 3 — 3 ');
    expect(text).toContain('• Wall tiles — 929 ');
    expect(text).not.toContain('2.08');
    expect(buyQuantity(19.32)).toBe(20);
    expect(buyQuantity(20)).toBe(20);
  });
});

describe('QA-A-11 rate adjustments clear RATES_MISSING', () => {
  const line = (material: string, overrideRatePaisa: bigint | null) => ({ material, suppliedBy: 'CONTRACTOR' as const, kind: 'MATERIAL' as const, overrideRatePaisa });
  it('drops a material whose every contractor line has a rate typed in; keeps the rest', () => {
    const w = [{ code: 'RATES_MISSING', items: ['wallTiles', 'termite'], message: 'x' }, { code: 'OTHER', message: 'y' }];
    const out = ratesFixedByOverride(w, [line('wallTiles', 18000n), line('termite', null)]) as Array<{ code: string; items?: string[] }>;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ code: 'RATES_MISSING', items: ['termite'] });
    expect(ratesFixedByOverride(w, [line('wallTiles', 18000n), line('termite', 500n)])).toEqual([{ code: 'OTHER', message: 'y' }]);
  });
});

describe('QA-A-24 steel bar names in the BoQ PDF', () => {
  it('a bar size priced at another rate keeps its own size in the text', () => {
    expect(pdfLineDescription({ material: 'steel10', description: 'Steel Grade-60 #4' })).toBe('Steel #3 (10 mm) — general steel rate');
    expect(pdfLineDescription({ material: 'steel12', description: 'Steel Grade-60 #4' })).toBe('Steel Grade-60 #4');
    expect(pdfLineDescription({ material: 'cement', description: 'Cement OPC' })).toBe('Cement OPC');
  });
});
