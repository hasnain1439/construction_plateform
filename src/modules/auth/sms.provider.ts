import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { Lang } from '../../core/i18n/lang.js';
import { maskPhone } from '../../core/utils/phone.js';
import { withDeliveryLog, type MessageType, type ProviderSendResult } from './deliveryLog.js';

export type { MessageType } from './deliveryLog.js';

export interface SmsMessage {
  /** Normalised phone, +923XXXXXXXXX. */
  to: string;
  /** Built-in text. Replaced by SMS_TEMPLATES[type] when the owner configured one. */
  body: string;
  /** What the message is for (default GENERIC). */
  type?: MessageType;
  /** Company the message belongs to (delivery log); null / unset for platform messages. */
  tenantId?: string | null;
  /** Values for {placeholders} in a configured template (code, minutes, url, company…). */
  params?: Record<string, string | number>;
  /** Recipient's language of `body` (picks SMS_TEMPLATES["TYPE.lang"] before SMS_TEMPLATES[TYPE]). */
  lang?: Lang;
}

/** Implement this for a gateway and register it in `smsProvider()`. Throw when the gateway refuses. */
export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<ProviderSendResult | void>;
}

// ─── Templates ──────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Replaces {key} with escape(vars[key]); unknown placeholders are left as they are. */
export function fillTemplate(template: string, vars: Record<string, string | number | undefined>, escape: (v: string) => string = (v) => v): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => (vars[key] === undefined ? whole : escape(String(vars[key]))));
}

/**
 * The text actually sent: SMS_TEMPLATES["type.lang"] (e.g. "OTP.ur") or SMS_TEMPLATES[type] filled
 * with the message params (plus {message} =
 * the built-in text), or the built-in text when no template is configured or the template uses
 * a placeholder this message doesn't have (never send "{code}" to a user).
 */
export function smsText(message: SmsMessage, templates: Record<string, string> | undefined = env.SMS_TEMPLATES): string {
  const type = message.type ?? 'GENERIC';
  const template = (message.lang ? templates?.[`${type}.${message.lang}`] : undefined) ?? templates?.[type];
  if (!template) return message.body;
  const filled = fillTemplate(template, { ...message.params, message: message.body });
  if (/\{[A-Za-z][A-Za-z0-9_]*\}/.test(filled)) {
    logger.warn({ type: message.type }, 'SMS template has unknown placeholders — built-in text used');
    return message.body;
  }
  return filled;
}

// ─── Console (dev / tests) ──────────────────────────────────────────────────

/**
 * Development provider: prints the SMS to the console (NOT the structured logger,
 * which must never contain OTP codes). In tests it only records to `outbox`.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  readonly outbox: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 100) this.outbox.shift();
    if (!isTest) {
      console.log(`\n📱 [SMS → ${message.to}] ${message.body}\n`);
    }
    logger.debug({ to: maskPhone(message.to), provider: this.name }, 'sms sent');
  }
}

// ─── Generic HTTP gateway ───────────────────────────────────────────────────

export interface HttpSmsConfig {
  url: string;
  method: 'GET' | 'POST';
  contentType: 'json' | 'form';
  bodyTemplate?: string;
  auth: 'none' | 'bearer' | 'basic' | 'header' | 'query';
  apiKey?: string;
  authHeader: string;
  authQueryParam: string;
  username?: string;
  password?: string;
  senderId?: string;
  phoneFormat: 'e164' | 'international' | 'local';
  successMatch?: string;
  failureMatch?: string;
  idPath?: string;
  timeoutMs: number;
  templateIds?: Record<string, string>;
}

export function httpSmsConfigFromEnv(): HttpSmsConfig {
  return {
    url: env.SMS_HTTP_URL!,
    method: env.SMS_HTTP_METHOD,
    contentType: env.SMS_HTTP_CONTENT_TYPE,
    bodyTemplate: env.SMS_HTTP_BODY_TEMPLATE,
    auth: env.SMS_HTTP_AUTH,
    apiKey: env.SMS_HTTP_API_KEY,
    authHeader: env.SMS_HTTP_AUTH_HEADER,
    authQueryParam: env.SMS_HTTP_AUTH_QUERY_PARAM,
    username: env.SMS_HTTP_USERNAME,
    password: env.SMS_HTTP_PASSWORD,
    senderId: env.SMS_SENDER_ID,
    phoneFormat: env.SMS_HTTP_PHONE_FORMAT,
    successMatch: env.SMS_HTTP_SUCCESS_MATCH,
    failureMatch: env.SMS_HTTP_FAILURE_MATCH,
    idPath: env.SMS_HTTP_ID_PATH,
    timeoutMs: env.SMS_HTTP_TIMEOUT_MS,
    templateIds: env.SMS_TEMPLATE_IDS,
  };
}

/** +923001234567 → e164 as is · international 923001234567 · local 03001234567. */
export function formatPhone(phone: string, format: HttpSmsConfig['phoneFormat']): string {
  if (format === 'e164') return phone;
  const digits = phone.replace(/^\+/, '');
  if (format === 'international') return digits;
  return digits.startsWith('92') ? `0${digits.slice(2)}` : digits;
}

const DEFAULT_BODY = {
  json: '{"to":"{to}","message":"{message}","sender":"{sender}"}',
  form: 'to={to}&message={message}&sender={sender}',
} as const;

const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), value);
}

export class SmsGatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SmsGatewayError';
  }
}

/**
 * Any HTTP SMS gateway (Pakistani aggregators such as those of Jazz, Telenor, Zong, Ufone
 * resellers, or Twilio-style APIs) described by configuration: URL + method, auth, sender ID,
 * body template with {to}, {message}, {sender}, {type}, {templateId}, and success detection
 * (2xx + optional SMS_HTTP_SUCCESS_MATCH / SMS_HTTP_FAILURE_MATCH regexes). The API key is
 * never logged.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http';

  constructor(
    private readonly config: HttpSmsConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async send(message: SmsMessage): Promise<ProviderSendResult> {
    const c = this.config;
    const type = message.type ?? 'GENERIC';
    const vars = {
      to: formatPhone(message.to, c.phoneFormat),
      message: message.body,
      sender: c.senderId ?? '',
      type,
      templateId: c.templateIds?.[type] ?? '',
    };

    let url = fillTemplate(c.url, vars, encodeURIComponent);
    const headers: Record<string, string> = {};
    let body: string | undefined;

    if (c.method === 'GET') {
      const query = c.bodyTemplate ?? (c.url.includes('{message}') ? '' : DEFAULT_BODY.form);
      if (query) url += (url.includes('?') ? '&' : '?') + fillTemplate(query, vars, encodeURIComponent);
    } else if (c.contentType === 'json') {
      headers['Content-Type'] = 'application/json';
      body = fillTemplate(c.bodyTemplate ?? DEFAULT_BODY.json, vars, jsonEscape);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = fillTemplate(c.bodyTemplate ?? DEFAULT_BODY.form, vars, encodeURIComponent);
    }

    switch (c.auth) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${c.apiKey}`;
        break;
      case 'basic':
        headers['Authorization'] = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
        break;
      case 'header':
        headers[c.authHeader] = c.apiKey!;
        break;
      case 'query':
        url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(c.authQueryParam)}=${encodeURIComponent(c.apiKey!)}`;
        break;
      case 'none':
        break;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: c.method, headers, body, signal: AbortSignal.timeout(c.timeoutMs) });
    } catch (err) {
      // Network error / timeout. The URL may carry the key (query auth) — don't echo it.
      throw new SmsGatewayError(`SMS gateway unreachable: ${err instanceof Error ? err.name : 'error'}`);
    }
    const text = await response.text().catch(() => '');
    const snippet = this.redact(text, message.body).slice(0, 200);

    if (!response.ok) throw new SmsGatewayError(`SMS gateway answered HTTP ${response.status}: ${snippet}`, response.status);
    if (c.failureMatch && new RegExp(c.failureMatch, 'i').test(text)) throw new SmsGatewayError(`SMS gateway reported a failure: ${snippet}`, response.status);
    if (c.successMatch && !new RegExp(c.successMatch, 'i').test(text)) throw new SmsGatewayError(`SMS gateway response not recognised as sent: ${snippet}`, response.status);

    let providerId: string | undefined;
    if (c.idPath) {
      try {
        const id = readPath(JSON.parse(text), c.idPath);
        if (id !== undefined && id !== null && id !== '') providerId = String(id);
      } catch {
        // Not JSON: no id.
      }
    }
    logger.debug({ to: maskPhone(message.to), provider: this.name, type }, 'sms sent');
    return { providerId };
  }

  private redact(text: string, body: string): string {
    let out = text.split(body).join('[message]');
    if (this.config.apiKey) out = out.split(this.config.apiKey).join('[key]');
    return out;
  }
}

// ─── Delivery logging wrapper ───────────────────────────────────────────────

/**
 * What `smsProvider()` hands out: applies SMS_TEMPLATES, then sends through the configured
 * provider and records the attempt in MessageDelivery (masked phone, status, provider id, error).
 */
export class LoggedSmsProvider implements SmsProvider {
  constructor(readonly inner: SmsProvider) {}

  get name(): string {
    return this.inner.name;
  }

  async send(message: SmsMessage): Promise<ProviderSendResult | void> {
    const body = smsText(message);
    return withDeliveryLog(
      { channel: 'SMS', type: message.type ?? 'GENERIC', provider: this.inner.name, to: message.to, tenantId: message.tenantId },
      () => this.inner.send({ ...message, body }),
      body,
    );
  }
}

let instance: LoggedSmsProvider | undefined;

export function smsProvider(): SmsProvider {
  if (!instance) {
    switch (env.SMS_PROVIDER) {
      case 'console':
        instance = new LoggedSmsProvider(new ConsoleSmsProvider());
        break;
      case 'http':
        instance = new LoggedSmsProvider(new HttpSmsProvider(httpSmsConfigFromEnv()));
        break;
    }
  }
  return instance!;
}

/** Tests only: send through `provider` (still logged); undefined goes back to SMS_PROVIDER. */
export function useSmsProviderForTests(provider: SmsProvider | undefined): void {
  instance = provider ? new LoggedSmsProvider(provider) : undefined;
}

/** Test helper: the latest SMS sent to `phone` (console provider only). */
export function lastSmsTo(phone: string): SmsMessage | undefined {
  smsProvider();
  const provider = instance?.inner;
  if (!(provider instanceof ConsoleSmsProvider)) return undefined;
  return [...provider.outbox].reverse().find((m) => m.to === phone);
}
