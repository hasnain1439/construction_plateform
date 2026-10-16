import { describe, expect, it } from 'vitest';
import { suggest, suggestContractValue, suggestLabourRate } from '../../src/modules/estimate/contractValue.js';

describe('contract value from the estimate', () => {
  it('value = cost × (1 + margin) rounded to the nearest Rs 1,000', () => {
    // Rs 50,12,345.67 × 1.2 = Rs 60,14,814.80 → Rs 60,15,000
    expect(suggestContractValue(501234567n, 20)).toBe(601500000n);
    expect(suggestContractValue(100000000n, 0)).toBe(100000000n);
    // Rs 1,499 → Rs 1,000; Rs 1,500 → Rs 2,000 (half up)
    expect(suggestContractValue(149900n, 0)).toBe(100000n);
    expect(suggestContractValue(150000n, 0)).toBe(200000n);
    expect(suggestContractValue(0n, 20)).toBeNull();
  });

  it('finishing allowance compounds before the margin (FULL only)', () => {
    // Rs 1,00,00,000 × 1.5 × 1.2 = Rs 1,80,00,000
    expect(suggestContractValue(1000000000n, 20, 50)).toBe(1800000000n);
    const base = { costPaisa: 1000000000n, labourPaisa: 200000000n, coveredAreaSqft: 2000, marginPercent: 20, finishingAllowancePercent: 50 };
    expect(suggest({ ...base, contractType: 'FULL' })).toMatchObject({ kind: 'CONTRACT_VALUE', suggestedPaisa: 1800000000n, finishingApplies: true });
    expect(suggest({ ...base, contractType: 'GREY_OWNER_FINISHING' })).toMatchObject({ kind: 'CONTRACT_VALUE', suggestedPaisa: 1200000000n, finishingApplies: false });
  });

  it('labour-only: rate = labour × (1 + margin) ÷ covered sq ft, nearest Rs 5', () => {
    // Rs 8,00,000 × 1.2 ÷ 2,000 = Rs 480
    expect(suggestLabourRate(80000000n, 20, 2000)).toBe(48000n);
    // Rs 7,77,777 × 1.25 ÷ 1,850 = Rs 525.53 → Rs 525
    expect(suggestLabourRate(77777700n, 25, 1850)).toBe(52500n);
    // Rs 527.6 → Rs 530
    expect(suggestLabourRate(52760n, 0, 1)).toBe(53000n);
    expect(suggestLabourRate(0n, 20, 2000)).toBeNull();
    expect(suggestLabourRate(80000000n, 20, null)).toBeNull();
    expect(suggest({ contractType: 'LABOR_ONLY', costPaisa: 999n, labourPaisa: 80000000n, coveredAreaSqft: 2000, marginPercent: 20, finishingAllowancePercent: 99 })).toMatchObject({
      kind: 'RATE_PER_SQFT',
      basisPaisa: 80000000n,
      suggestedPaisa: 48000n,
    });
  });
});
