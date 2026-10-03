import { describe, expect, it } from 'vitest';
import { permissionsFor } from '../../src/core/auth/permissions.js';
import { generateOtp, safeEqual } from '../../src/core/utils/crypto.js';
import { jsonReplacer } from '../../src/core/utils/json.js';
import { normalizePkPhone } from '../../src/core/utils/phone.js';
import { slugify } from '../../src/core/utils/slug.js';

describe('normalizePkPhone', () => {
  it.each([
    ['03001234567', '+923001234567'],
    ['+92 300 1234567', '+923001234567'],
    ['923001234567', '+923001234567'],
    ['0092-300-1234567', '+923001234567'],
    ['3001234567', '+923001234567'],
    ['(0321) 123-4567', '+923211234567'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePkPhone(input)).toBe(expected);
  });

  it.each(['0423456789', '+4420712345678', '0300123456', '030012345678', 'abc', '', '+92421234567'])('rejects %s', (input) => {
    expect(normalizePkPhone(input)).toBeNull();
  });
});

describe('permissionsFor', () => {
  it('MUNSHI never gets rates or financials', () => {
    expect(permissionsFor({ role: 'MUNSHI', canSeeFinancials: true })).toEqual(['site.entry']);
  });
  it('PM financials depend on the flag', () => {
    expect(permissionsFor({ role: 'PM', canSeeFinancials: false })).not.toContain('profit.view');
    expect(permissionsFor({ role: 'PM', canSeeFinancials: true })).toContain('profit.view');
  });
});

describe('utils', () => {
  it('generateOtp gives 6 digits', () => {
    for (let i = 0; i < 50; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('BigInt serialises as string', () => {
    expect(JSON.stringify({ amount: 950_000n }, jsonReplacer)).toBe('{"amount":"950000"}');
  });
  it('slugify', () => {
    expect(slugify('Malik & Sons Builders')).toBe('malik-and-sons-builders');
    expect(slugify('!!!')).toBe('company');
  });
});
