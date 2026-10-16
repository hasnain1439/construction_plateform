/**
 * The server message catalogues: every key in every language, the same {placeholders}, nothing
 * empty — and every notification text renders completely in each language.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGS, LANGS, langOf, dbLanguage, enumLabel, materialLine, placeholdersOf, tr, trCount, unitLabel } from '../../src/core/i18n/index.js';
import { NOTIFICATION_TEXT_KEYS, renderNotification } from '../../src/modules/notifications/texts.js';
import { smsText } from '../../src/modules/auth/sms.provider.js';

const en = CATALOGS.en;

describe('i18n catalogues', () => {
  it('every language has exactly the English keys (fails on a missing or extra key)', () => {
    for (const lang of LANGS) {
      const keys = Object.keys(CATALOGS[lang]);
      const missing = Object.keys(en).filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !(k in en));
      expect({ lang, missing, extra }).toEqual({ lang, missing: [], extra: [] });
    }
  });

  it('no empty texts and the same {placeholders} in every language', () => {
    for (const lang of LANGS) {
      for (const [key, text] of Object.entries(CATALOGS[lang])) {
        expect(text.trim(), `${lang} ${key}`).not.toBe('');
        expect(placeholdersOf(text), `${lang} ${key}`).toEqual(placeholdersOf(en[key as keyof typeof en]));
      }
    }
  });

  it('Urdu texts are in Urdu script; Roman Urdu has none', () => {
    const urdu = /[؀-ۿ]/;
    for (const key of Object.keys(en).filter((k) => k.startsWith('notif.') || k.startsWith('sms.') || k.startsWith('pdf.') || k.startsWith('mail.'))) {
      const ur = CATALOGS.ur[key as keyof typeof en];
      if (ur.replace(/\{[^}]+\}/g, '').replace(/[\s#.:()"·—–!,؛۔،-]/g, '') === '') continue; // e.g. "{lines}"
      expect(urdu.test(ur), `ur ${key}`).toBe(true);
      expect(urdu.test(CATALOGS.roman[key as keyof typeof en]), `roman ${key}`).toBe(false);
    }
  });

  it('every notification text key renders title + body in every language, no placeholder left', () => {
    const params = { number: 'GP-0001', project: 'DHA', lines: [{ qty: 200, unit: 'bag', name: 'OPC cement', group: 'CEMENT' }], where: 'Site', count: 3, material: 'Sand', store: 'Central Store', left: '10', unit: 'cft', min: '50', supplier: 'Al-Madina', week: '14 Sep – 19 Sep', amount: 'Rs 1,000', comment: 'redo', holder: 'Rafaqat', description: 'tea', method: 'EASYPAISA', subcontractor: 'Sharif', quantity: '10', cheque: 'MCB cheque 1', reason: 'funds', label: 'Plinth', plan: 'Starter', endsOn: '3 Oct 2026', until: '3 Nov 2026', receipt: 'RCPT-2026-0001', transactionId: 'EP1', name: 'Kamran', role: 'PM', admin: 'Support', date: '15 Oct 2026', snags: 2, milestone: 'First floor — columns & brickwork' };
    for (const lang of LANGS) {
      for (const key of NOTIFICATION_TEXT_KEYS) {
        const r = renderNotification(lang, key, params);
        expect(r, `${lang} ${key}`).not.toBeNull();
        expect(`${r!.title} ${r!.body} ${r!.sms ?? ''}`, `${lang} ${key}`).not.toMatch(/\{[A-Za-z]+\}/);
      }
    }
    expect(renderNotification('ur', 'floatSentBy', { amount: 'Rs 5,000', method: 'EASYPAISA' })!.body).toBe('Rs 5,000 بذریعہ ایزی پیسہ — ملنے پر تصدیق کریں۔');
    expect(renderNotification('roman', 'dispatchCreated', params)!.body).toBe('200 bags cement');
    expect(renderNotification('en', 'unknownKey', {})).toBeNull();
  });

  it('plurals, enum and unit labels, material lines, DB language mapping', () => {
    expect(trCount('en', 'notif.invoiceOverdue.body', 1, { amount: 'Rs 5' })).toBe('Rs 5 is 1 day past due.');
    expect(trCount('en', 'notif.invoiceOverdue.body', 4, { amount: 'Rs 5' })).toBe('Rs 5 is 4 days past due.');
    expect(enumLabel('ur', 'ProjectStatus', 'ACTIVE')).toBe('جاری');
    expect(enumLabel('en', 'ProjectStatus', 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(unitLabel('roman', 'Bag')).toBe('bori');
    expect(unitLabel('ur', 'sack')).toBe('sack');
    expect(materialLine('roman', { qty: 5000, unit: 'nos', name: 'Bricks', group: 'BRICKS' })).toBe('5,000 eent');
    expect(materialLine('ur', { qty: 1, unit: 'ton', name: 'Steel', group: 'STEEL' })).toBe('1 ٹن سریا');
    expect(langOf('URDU')).toBe('ur');
    expect(langOf('ROMAN_URDU')).toBe('roman');
    expect(langOf(null)).toBe('roman');
    expect(dbLanguage('en')).toBe('ENGLISH');
    expect(tr('en', 'sms.otp.login', { code: '123456', minutes: 5 })).toContain('123456');
  });

  it('SMS_TEMPLATES: a per-language template ("OTP.ur") wins over the type template; {message} is the built-in text', () => {
    const templates = { OTP: 'X {code}', 'OTP.ur': 'کوڈ {code}', INVITE: '[{message}]' };
    expect(smsText({ to: '+923001234567', body: 'b', type: 'OTP', params: { code: '1' }, lang: 'ur' }, templates)).toBe('کوڈ 1');
    expect(smsText({ to: '+923001234567', body: 'b', type: 'OTP', params: { code: '1' }, lang: 'en' }, templates)).toBe('X 1');
    expect(smsText({ to: '+923001234567', body: 'آپ کا', type: 'INVITE', lang: 'ur' }, templates)).toBe('[آپ کا]');
  });
});
