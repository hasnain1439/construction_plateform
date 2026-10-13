import { describe, expect, it } from 'vitest';
import { defaultAccess } from '../../src/core/auth/access.js';
import { generateOtp, safeEqual } from '../../src/core/utils/crypto.js';
import { jsonReplacer } from '../../src/core/utils/json.js';
import { normalizePkAnyPhone, normalizePkPhone } from '../../src/core/utils/phone.js';
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

describe('normalizePkAnyPhone (office numbers)', () => {
  it.each([
    ['042-35761234', '+924235761234'],
    ['051 1234567', '+92511234567'],
    ['+92 21 34567890', '+922134567890'],
    ['0300-1234567', '+923001234567'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePkAnyPhone(input)).toBe(expected);
  });
  it.each(['35761234', '042-123', 'abc', '+44 20 7123 4567'])('rejects %s', (input) => {
    expect(normalizePkAnyPhone(input)).toBeNull();
  });
});

describe('default permissions', () => {
  it('MUNSHI never gets rates or financials', () => {
    const a = defaultAccess('MUNSHI', true);
    expect(a.fieldAccess).toEqual({ rates: false, amounts: false, profit: false, contract: false });
    expect(a.permissions).toContain('labor.attendance.create');
  });
  it('PM financials depend on the flag', () => {
    expect(defaultAccess('PM', false).permissions).not.toContain('fields.profit');
    expect(defaultAccess('PM', true).permissions).toContain('fields.profit');
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
