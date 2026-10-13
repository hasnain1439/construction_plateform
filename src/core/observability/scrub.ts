/**
 * PII / secret scrubbing for anything that leaves the server for a monitoring service (Sentry).
 * Pure functions — no Sentry import — so they are unit-tested directly (tests/unit/observability).
 *
 * Removed or masked:
 *  - emails, Pakistani / E.164 phone numbers, CNICs
 *  - JWTs, `Bearer …` values, long opaque tokens (hex / base64url)
 *  - cookies, authorization / act-as headers, request bodies (never sent at all)
 *  - query strings of signed file links, invitation tokens in URLs
 *  - any object key that names a secret or personal field (password, token, code, otp, phone…)
 * The Sentry user is reduced to `{ id }` (a hash of the user id, see hash.ts).
 */
import { safeUrl } from '../utils/safeUrl.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** +923001234567, 923001234567, 03001234567, 0300-1234567, 0300 1234567 */
const PK_PHONE = /(?<![\d])(?:\+?92|0)[\s-]?3\d{2}[\s-]?\d{7}(?!\d)/g;
/** Any other E.164-looking number (+ followed by 10–15 digits). */
const E164 = /\+\d{10,15}(?!\d)/g;
/** 35202-1234567-1 */
const CNIC = /(?<!\d)\d{5}-?\d{7}-?\d(?!\d)/g;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/** Opaque secrets: long runs of hex or base64url (refresh tokens, invite tokens, signatures). UUIDs are kept. */
const LONG_TOKEN = /(?<![A-Za-z0-9_-])(?![0-9a-f]{8}-[0-9a-f]{4}-)[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g;
/** key=value pairs in free text / query strings whose value is a secret. */
const SECRET_PARAM = /\b(token|code|otp|sig|signature|password|secret|api_key|apikey|access_token|refresh_token)=([^&\s"']+)/gi;

/** Object keys whose values are never sent (matched case-insensitively, anywhere in the key). */
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|otp|^code$|codehash|^sig$|signature|phone|email|cnic|^login$|api[_-]?key|session|^device$|pushtoken|ssn/i;

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

/** Masks emails, phones, CNICs and tokens inside a free-text string. */
export function scrubString(value: string): string {
  return value
    .replace(JWT, '[token]')
    .replace(BEARER, '$1 [token]')
    .replace(SECRET_PARAM, `$1=${REDACTED}`)
    .replace(EMAIL, '[email]')
    .replace(PK_PHONE, '[phone]')
    .replace(E164, '[phone]')
    .replace(CNIC, '[cnic]')
    .replace(LONG_TOKEN, '[token]');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Deep copy with sensitive keys redacted and every string scrubbed. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : scrubValue(inner, depth + 1);
  }
  return out;
}

/** URL path + query without invitation tokens, signed-link queries or secret params. */
export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return scrubString(safeUrl(url) ?? url);
}

const DROP_HEADERS = /^(authorization|cookie|set-cookie|proxy-authorization|x-act-as-session|x-api-key|x-forwarded-for|x-real-ip)$/i;

function scrubHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (DROP_HEADERS.test(key)) continue;
    out[key] = scrubString(String(value));
  }
  return out;
}

/** The parts of a Sentry event we touch (structurally typed so this file needs no Sentry import). */
export interface ScrubbableEvent {
  message?: string;
  transaction?: string;
  user?: { id?: string | number; [key: string]: unknown };
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, string>;
    env?: unknown;
    [key: string]: unknown;
  };
  exception?: { values?: Array<{ value?: string; [key: string]: unknown }> };
  breadcrumbs?: ScrubbableBreadcrumb[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  logentry?: { message?: string; params?: unknown[] };
  server_name?: string;
  [key: string]: unknown;
}

export interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  if (crumb.message) crumb.message = scrubString(crumb.message);
  if (crumb.data) {
    const data = scrubValue(crumb.data) as Record<string, unknown>;
    for (const key of ['url', 'to', 'from']) if (typeof data[key] === 'string') data[key] = scrubUrl(data[key] as string);
    delete data['http.query'];
    delete data['http.fragment'];
    crumb.data = data;
  }
  return crumb;
}

/** Sentry `beforeSend` / `beforeSendTransaction`: mutates and returns the event. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.message) event.message = scrubString(event.message);
  if (event.logentry?.message) event.logentry.message = scrubString(event.logentry.message);
  if (event.logentry?.params) event.logentry.params = scrubValue(event.logentry.params) as unknown[];
  if (event.transaction) event.transaction = scrubUrl(event.transaction);

  if (event.user) {
    // Only the hashed id ever leaves; Sentry would otherwise add the IP address.
    event.user = event.user.id === undefined ? {} : { id: event.user.id };
  }

  if (event.request) {
    const req = event.request;
    delete req.cookies;
    delete req.data; // request bodies are never sent (auth bodies hold passwords / codes)
    delete req.env;
    if (req.url) req.url = scrubUrl(req.url);
    if (req.query_string !== undefined) req.query_string = REDACTED;
    req.headers = scrubHeaders(req.headers);
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as Record<string, unknown>;
  if (event.tags) event.tags = scrubValue(event.tags) as Record<string, unknown>;
  // Transactions: span names hold URLs / SQL text, span data holds URLs and query strings.
  if (Array.isArray(event['spans'])) {
    for (const span of event['spans'] as Array<{ description?: string; data?: Record<string, unknown> }>) {
      if (span.description) span.description = scrubUrl(span.description);
      if (span.data) {
        const data = scrubValue(span.data) as Record<string, unknown>;
        delete data['http.query'];
        delete data['url.query'];
        span.data = data;
      }
    }
  }
  return event;
}
