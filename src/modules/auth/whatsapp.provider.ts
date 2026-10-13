import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { maskPhone } from '../../core/utils/phone.js';
import { safeErrorText, withDeliveryLog, type ProviderSendResult } from './deliveryLog.js';

/** Message types that have an approved WhatsApp template (WHATSAPP_TEMPLATE_*). */
export type WhatsAppTemplateType = 'INVOICE' | 'STATEMENT' | 'INVITE' | 'OTP';

export interface WhatsAppMessage {
  /** Normalised phone, +923XXXXXXXXX. */
  to: string;
  type: WhatsAppTemplateType;
  /**
   * Body variables {{1}}, {{2}}, … in template order (see README → WhatsApp):
   * INVOICE [client, invoice no, amount, link] · STATEMENT [client, period, balance, link] ·
   * INVITE [name, company, role, link] · OTP [code] (the code is also the copy-code button value).
   */
  params: string[];
  tenantId?: string | null;
}

/** WhatsApp Business messaging. Throw when the API refuses the message. */
export interface WhatsAppProvider {
  readonly name: string;
  /** false = WHATSAPP_ENABLED is off: callers skip WhatsApp and rely on SMS / share links. */
  readonly enabled: boolean;
  send(message: WhatsAppMessage): Promise<ProviderSendResult>;
}

/** WHATSAPP_ENABLED=false (default): nothing is sent, nothing is logged. */
export class DisabledWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'disabled';
  readonly enabled = false;
  async send(): Promise<ProviderSendResult> {
    return {};
  }
}

export interface CloudApiConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion: string;
  baseUrl: string;
  language: string;
  templates: Record<WhatsAppTemplateType, string>;
  timeoutMs?: number;
}

export function cloudApiConfigFromEnv(): CloudApiConfig {
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
    accessToken: env.WHATSAPP_ACCESS_TOKEN!,
    apiVersion: env.WHATSAPP_API_VERSION,
    baseUrl: env.WHATSAPP_API_BASE_URL.replace(/\/+$/, ''),
    language: env.WHATSAPP_TEMPLATE_LANGUAGE,
    templates: {
      INVOICE: env.WHATSAPP_TEMPLATE_INVOICE,
      STATEMENT: env.WHATSAPP_TEMPLATE_STATEMENT,
      INVITE: env.WHATSAPP_TEMPLATE_INVITE,
      OTP: env.WHATSAPP_TEMPLATE_OTP,
    },
  };
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

/**
 * Meta WhatsApp Cloud API: template messages (business-initiated messages must use templates
 * approved in WhatsApp Manager). Plain `fetch`, no SDK. The access token is never logged.
 */
export class CloudApiWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'whatsapp-cloud';
  readonly enabled = true;

  constructor(
    private readonly config: CloudApiConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** The request body for one template message (exported shape is what Meta documents). */
  payload(message: WhatsAppMessage): Record<string, unknown> {
    const components: Array<Record<string, unknown>> = [];
    if (message.params.length) {
      components.push({ type: 'body', parameters: message.params.map((text) => ({ type: 'text', text })) });
    }
    if (message.type === 'OTP' && message.params[0]) {
      // Authentication templates carry the code again in their copy-code / one-tap button.
      components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: message.params[0] }] });
    }
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to.replace(/^\+/, ''),
      type: 'template',
      template: { name: this.config.templates[message.type], language: { code: this.config.language }, components },
    };
  }

  async send(message: WhatsAppMessage): Promise<ProviderSendResult> {
    const c = this.config;
    const url = `${c.baseUrl}/${c.apiVersion}/${c.phoneNumberId}/messages`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.payload(message)),
        signal: AbortSignal.timeout(c.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new WhatsAppApiError(`WhatsApp API unreachable: ${err instanceof Error ? err.name : 'error'}`);
    }
    const json = (await response.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string; code?: number };
    };
    if (!response.ok || json.error) {
      const detail = json.error ? `${json.error.code ?? ''} ${json.error.message ?? ''}`.trim() : 'no details';
      throw new WhatsAppApiError(`WhatsApp API answered HTTP ${response.status}: ${detail}`.slice(0, 300), response.status);
    }
    logger.debug({ to: maskPhone(message.to), type: message.type, provider: this.name }, 'whatsapp sent');
    return { providerId: json.messages?.[0]?.id };
  }
}

let instance: WhatsAppProvider | undefined;

export function whatsAppProvider(): WhatsAppProvider {
  instance ??= env.WHATSAPP_ENABLED ? new CloudApiWhatsAppProvider(cloudApiConfigFromEnv()) : new DisabledWhatsAppProvider();
  return instance;
}

/** Tests only: use `provider`; undefined goes back to WHATSAPP_ENABLED. */
export function useWhatsAppProviderForTests(provider: WhatsAppProvider | undefined): void {
  instance = provider;
}

/**
 * Best effort, an extra channel next to SMS / email / share links: sends the template when
 * WhatsApp is enabled, logs it in MessageDelivery, and never throws. Returns whether it was sent.
 */
export async function trySendWhatsApp(message: WhatsAppMessage): Promise<boolean> {
  const provider = whatsAppProvider();
  if (!provider.enabled) return false;
  try {
    await withDeliveryLog(
      { channel: 'WHATSAPP', type: message.type, provider: provider.name, to: message.to, tenantId: message.tenantId },
      () => provider.send(message),
    );
    return true;
  } catch (err) {
    logger.warn({ to: maskPhone(message.to), type: message.type, error: safeErrorText(err) }, 'whatsapp delivery failed');
    return false;
  }
}

/** Ready-made senders for billing (wire them where an invoice / statement is shared). */
export const whatsAppTemplates = {
  invoice: (to: string, v: { client: string; invoiceNo: string; amount: string; url: string }, tenantId?: string) =>
    trySendWhatsApp({ to, type: 'INVOICE', params: [v.client, v.invoiceNo, v.amount, v.url], tenantId }),
  statement: (to: string, v: { client: string; period: string; balance: string; url: string }, tenantId?: string) =>
    trySendWhatsApp({ to, type: 'STATEMENT', params: [v.client, v.period, v.balance, v.url], tenantId }),
};
