import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { maskPhone } from '../../core/utils/phone.js';

export interface SmsMessage {
  to: string;
  body: string;
}

/** Implement this for a real gateway (e.g. Jazz, Telenor, Twilio) and register it in `smsProvider()`. */
export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<void>;
}

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

let instance: SmsProvider | undefined;

export function smsProvider(): SmsProvider {
  if (!instance) {
    switch (env.SMS_PROVIDER) {
      case 'console':
        instance = new ConsoleSmsProvider();
        break;
    }
  }
  return instance;
}

/** Test helper: the latest SMS sent to `phone` (console provider only). */
export function lastSmsTo(phone: string): SmsMessage | undefined {
  const provider = smsProvider();
  if (!(provider instanceof ConsoleSmsProvider)) return undefined;
  return [...provider.outbox].reverse().find((m) => m.to === phone);
}
