/**
 * Server i18n: message catalogues (en = source, roman, ur) for notifications, SMS, email, share
 * texts, PDF / report labels and enum labels. Pick the RECIPIENT's language (`User.language`,
 * the invite's language, or the requesting user's for documents) — see README → Languages.
 *
 *   tr('ur', 'sms.otp.login', { code, minutes })
 *   trCount('roman', 'notif.invoiceOverdue.body', 3, { amount })   // picks .one / .other
 *   enumLabel('en', 'ProjectStatus', 'HANDED_OVER')                // "Handed over"
 */
import { en, type MessageKey } from './catalog/en.js';
import { roman } from './catalog/roman.js';
import { ur } from './catalog/ur.js';
import type { Lang } from './lang.js';

export * from './lang.js';
export type { MessageKey };

export const CATALOGS: Record<Lang, Record<MessageKey, string>> = { en, roman, ur };

export type Params = Record<string, string | number | null | undefined>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Placeholders a text uses ({code}, {minutes}…). */
export const placeholdersOf = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!).sort();

/** True when `key` is a catalogue key. */
export const hasKey = (key: string): key is MessageKey => Object.hasOwn(en, key);

/**
 * The text of `key` in `lang` with {placeholders} filled (`escape` is applied to the values only —
 * HTML templates pass their escaper). Unknown placeholders stay as they are.
 */
export function tr(lang: Lang, key: MessageKey, params: Params = {}, escape: (v: string) => string = (v) => v): string {
  const text = CATALOGS[lang][key] ?? en[key];
  return text.replace(PLACEHOLDER, (whole, name: string) => (params[name] === undefined || params[name] === null ? whole : escape(String(params[name]))));
}

/** `base.one` when count is 1, else `base.other`; {count} is filled too. */
export function trCount(lang: Lang, base: string, count: number, params: Params = {}, escape?: (v: string) => string): string {
  const key = `${base}.${count === 1 ? 'one' : 'other'}`;
  if (!hasKey(key)) throw new Error(`i18n: no plural key ${key}`);
  return tr(lang, key, { ...params, count }, escape);
}

/** A key when it exists (`.one` / `.other` pairs resolved on params.count), else null. */
export function trMaybe(lang: Lang, base: string, params: Params = {}): string | null {
  if (hasKey(base)) return tr(lang, base, params);
  if (hasKey(`${base}.one`) && typeof params['count'] === 'number') return trCount(lang, base, params['count'], params);
  return null;
}

export type EnumName =
  | 'UserRole'
  | 'PaymentMethod'
  | 'ClientPaymentStatus'
  | 'ProjectStatus'
  | 'InvoiceStatus'
  | 'StatementEntry'
  | 'StockLocationType'
  | 'PayeeKind'
  | 'CostBucket'
  | 'ExpenseCategory';

/** Label of an enum value in `lang`; an unknown value comes back as it is. */
export function enumLabel(lang: Lang, name: EnumName, value: string | null | undefined): string {
  if (!value) return '';
  const key = `enum.${name}.${value}`;
  return hasKey(key) ? tr(lang, key) : value;
}

/** "bag" → "bori" / "بوری"; a unit the catalogue doesn't know is shown as the company wrote it. */
export function unitLabel(lang: Lang, unit: string | null | undefined): string {
  if (!unit) return '';
  const key = `unit.${unit.trim().toLowerCase().replace(/\s+/g, '')}`;
  return hasKey(key) ? tr(lang, key) : unit;
}

/** "a, b and c" in the language. */
export function joinList(lang: Lang, items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  const sep = lang === 'ur' ? '، ' : ', ';
  return `${items.slice(0, -1).join(sep)} ${tr(lang, 'common.and')} ${items.at(-1)}`;
}

export interface MaterialLine {
  qty: number;
  unit: string;
  name: string;
  /** Material group code (CEMENT / BRICKS / STEEL get the site words: "bags cement", "eent", "ton sariya"). */
  group: string | null;
}

const qtyText = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);

/** "200 bags cement" / "5,000 eent" / "1 ton sariya", else "<qty> <unit> <name>". */
export function materialLine(lang: Lang, m: MaterialLine): string {
  const n = qtyText(m.qty);
  switch (m.group) {
    case 'CEMENT':
      return tr(lang, m.name.toLowerCase().includes('white') ? 'material.whiteCement' : 'material.cement', { n });
    case 'BRICKS':
      return tr(lang, 'material.bricks', { n });
    case 'STEEL':
      return tr(lang, 'material.steel', { n });
    default:
      return tr(lang, 'material.other', { n, unit: unitLabel(lang, m.unit), name: m.name });
  }
}
