import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Implement for a real provider (SES, Postmark, SMTP…) and register it in `mailProvider()`. */
export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

/** Development provider: prints mail to the console; in tests only records to `outbox`. */
export class ConsoleMailProvider implements MailProvider {
  readonly name = 'console';
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 100) this.outbox.shift();
    if (!isTest) {
      console.log(`\n✉️  [MAIL → ${message.to}] ${message.subject}\n${message.text}\n`);
    }
    logger.debug({ provider: this.name }, 'mail sent');
  }
}

let instance: MailProvider | undefined;

export function mailProvider(): MailProvider {
  if (!instance) {
    switch (env.MAIL_PROVIDER) {
      case 'console':
        instance = new ConsoleMailProvider();
        break;
    }
  }
  return instance;
}
