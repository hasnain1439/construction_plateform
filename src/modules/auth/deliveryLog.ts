import { logger } from '../../config/logger.js';
import { prismaAdmin } from '../../core/db/prisma.js';
import { maskPhone } from '../../core/utils/phone.js';
import type { MessageChannel } from '../../generated/prisma/enums.js';

/**
 * What a message is for. Drives per-type SMS text / gateway template ids (SMS_TEMPLATES,
 * SMS_TEMPLATE_IDS), WhatsApp template names, and the `type` column of MessageDelivery.
 */
export type MessageType =
  | 'OTP'
  | 'PASSWORD_RESET'
  | 'INVITE'
  | 'NOTIFICATION'
  | 'SUBSCRIPTION_REMINDER'
  | 'CASHBOOK'
  | 'DISPATCH'
  | 'PLATFORM'
  | 'INVOICE'
  | 'STATEMENT'
  | 'GENERIC';

/** What a provider may return after a successful hand-off. */
export interface ProviderSendResult {
  /** The provider's own message id (gateway id, SES MessageId, WhatsApp wamid). */
  providerId?: string;
}

/** a***@example.com — enough to recognise a recipient in the log, not to harvest it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function maskRecipient(channel: MessageChannel, to: string): string {
  return channel === 'EMAIL' ? maskEmail(to) : maskPhone(to);
}

/**
 * Error text safe to store: no message body (it can carry a code or an invite link), no long
 * digit runs (codes), capped length.
 */
export function safeErrorText(err: unknown, body?: string): string {
  let text = err instanceof Error ? err.message : String(err);
  if (body) text = text.split(body).join('[message]');
  text = text.replace(/\b\d{4,8}\b/g, '[digits]');
  return text.slice(0, 500);
}

export interface DeliveryMeta {
  channel: MessageChannel;
  type: MessageType;
  provider: string;
  to: string;
  tenantId?: string | null;
}

/**
 * Runs `send` and records it in MessageDelivery: QUEUED before the hand-off, then SENT (with the
 * provider id) or FAILED (with the error). Logging never fails or blocks delivery — a database
 * problem is only written to the app log. The send's own error is rethrown unchanged.
 */
export async function withDeliveryLog<T extends ProviderSendResult | void>(
  meta: DeliveryMeta,
  send: () => Promise<T>,
  body?: string,
): Promise<T> {
  let id: string | undefined;
  try {
    const row = await prismaAdmin.messageDelivery.create({
      data: {
        channel: meta.channel,
        type: meta.type,
        provider: meta.provider,
        to: maskRecipient(meta.channel, meta.to),
        tenantId: meta.tenantId ?? null,
        status: 'QUEUED',
      },
      select: { id: true },
    });
    id = row.id;
  } catch (err) {
    logger.error({ err, channel: meta.channel, type: meta.type }, 'message delivery log failed');
  }

  try {
    const result = await send();
    if (id) await update(id, { status: 'SENT', providerId: result?.providerId?.slice(0, 200) ?? null });
    return result;
  } catch (err) {
    if (id) await update(id, { status: 'FAILED', error: safeErrorText(err, body) });
    throw err;
  }
}

async function update(id: string, data: { status: 'SENT' | 'FAILED'; providerId?: string | null; error?: string }) {
  try {
    await prismaAdmin.messageDelivery.update({ where: { id }, data });
  } catch (err) {
    logger.error({ err }, 'message delivery log update failed');
  }
}
