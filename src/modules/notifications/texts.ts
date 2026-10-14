/**
 * Notification texts in every language. A notification is stored with its text key + params
 * (`Notification.textKey` / `params`) AND the title / body rendered in the recipient's language
 * when it was created. Inbox, dashboard and sync re-render from key + params in the READER's
 * current language, so changing the language also changes old notifications; rows without a key
 * (older ones, tests) show the stored text.
 *
 * Params are raw values; a few names are translated at render time:
 *   unit → unit label · role → UserRole label · method → payment method label ·
 *   lines → MaterialLine[] ("200 bags cement, 5,000 eent") · count → .one / .other plural keys.
 */
import { enumLabel, materialLine, trMaybe, unitLabel, type Lang, type MaterialLine, type Params } from '../../core/i18n/index.js';

export const NOTIFICATION_TEXT_KEYS = [
  'dispatchCreated',
  'shortageCreated',
  'lowStock',
  'purchasePendingRate',
  'settlementSubmitted',
  'settlementReturned',
  'expensePending',
  'topupRequested',
  'floatSent',
  'floatSentBy',
  'measurementRecorded',
  'subcontractorOverpaid',
  'invoiceOverdue',
  'chequeBounced',
  'stageReadyUnbilled',
  'previousStageUnpaid',
  'subscriptionRenewal',
  'subscriptionPaymentApproved',
  'subscriptionPaymentRejected',
  'inviteAccepted',
  'platformSupportAccess',
  'missingLog',
  'missingLogWaiting',
] as const;
export type NotificationTextKey = (typeof NOTIFICATION_TEXT_KEYS)[number];

export type NotificationParams = Record<string, string | number | MaterialLine[] | null>;

export interface NotificationText {
  key: NotificationTextKey;
  params: NotificationParams;
}

function prepare(lang: Lang, params: NotificationParams): Params {
  const out: Params = {};
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) out[name] = name === 'lines' ? (value as MaterialLine[]).map((m) => materialLine(lang, m)).join(lang === 'ur' ? '، ' : ', ') : value.join(', ');
    else if (name === 'unit') out[name] = unitLabel(lang, value === null ? null : String(value));
    else if (name === 'role') out[name] = enumLabel(lang, 'UserRole', value === null ? null : String(value));
    else if (name === 'method') out[name] = enumLabel(lang, 'PaymentMethod', value === null ? null : String(value));
    else out[name] = value;
  }
  return out;
}

/** Title / body (and SMS text when the type has one) in `lang`; null for an unknown key. */
export function renderNotification(lang: Lang, key: string | null | undefined, params: unknown): { title: string; body: string; sms: string | null } | null {
  if (!key || !(NOTIFICATION_TEXT_KEYS as readonly string[]).includes(key)) return null;
  const p = prepare(lang, (params && typeof params === 'object' ? params : {}) as NotificationParams);
  const title = trMaybe(lang, `notif.${key}.title`, p);
  const body = trMaybe(lang, `notif.${key}.body`, p);
  if (title === null || body === null) return null;
  return { title, body, sms: trMaybe(lang, `notif.${key}.sms`, p) };
}
