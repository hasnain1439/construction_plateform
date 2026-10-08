import nodemailer, { type Transporter } from 'nodemailer';
import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body; mail clients fall back to `text`. */
  html?: string;
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

/** Real delivery over SMTP (Gmail app password, Brevo, Mailgun, SES SMTP…). */
export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;

  constructor() {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: env.MAIL_FROM ?? env.SMTP_USER, ...message });
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
      case 'smtp':
        instance = new SmtpMailProvider();
        break;
    }
  }
  return instance;
}

/** Best-effort mail: never fails the request (the SMS / link still works). */
export async function trySendMail(message: MailMessage): Promise<void> {
  try {
    await mailProvider().send(message);
  } catch (err) {
    logger.error({ err, provider: mailProvider().name }, 'mail delivery failed');
  }
}

/** Test helper: the latest mail sent to `email` (console provider only). */
export function lastMailTo(email: string): MailMessage | undefined {
  const provider = mailProvider();
  if (!(provider instanceof ConsoleMailProvider)) return undefined;
  return [...provider.outbox].reverse().find((m) => m.to === email);
}
