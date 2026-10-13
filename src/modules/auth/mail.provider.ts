import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import nodemailer, { type Transporter } from 'nodemailer';
import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { withDeliveryLog, type MessageType, type ProviderSendResult } from './deliveryLog.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body; mail clients fall back to `text`. */
  html?: string;
  /** What the message is for (delivery log; default GENERIC). */
  type?: MessageType;
  /** Company the message belongs to (delivery log); null / unset for platform mail. */
  tenantId?: string | null;
}

/** Implement for a real provider and register it in `mailProvider()`. Throw when delivery is refused. */
export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<ProviderSendResult | void>;
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

  async send(message: MailMessage): Promise<ProviderSendResult> {
    const { to, subject, text, html } = message;
    const info = await this.transport.sendMail({ from: env.MAIL_FROM ?? env.SMTP_USER, to, subject, text, html });
    logger.debug({ provider: this.name }, 'mail sent');
    return { providerId: typeof info.messageId === 'string' ? info.messageId : undefined };
  }
}

export interface SesConfig {
  region: string;
  from: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  configurationSet?: string;
}

/**
 * Amazon SES (API v2, `SendEmail` with simple content). Credentials: SES_ACCESS_KEY_ID /
 * SES_SECRET_ACCESS_KEY when set, otherwise the standard AWS chain (AWS_* env, profile, IAM role).
 * The sender must be on a domain verified in SES (with DKIM) and the account out of the sandbox.
 */
export class SesMailProvider implements MailProvider {
  readonly name = 'ses';
  private readonly client: SESv2Client;

  constructor(private readonly config: SesConfig) {
    this.client = new SESv2Client({
      region: config.region,
      credentials: config.accessKeyId && config.secretAccessKey ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined,
    });
  }

  async send(message: MailMessage): Promise<ProviderSendResult> {
    const charset = 'UTF-8';
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.config.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: charset },
            Body: {
              Text: { Data: message.text, Charset: charset },
              ...(message.html ? { Html: { Data: message.html, Charset: charset } } : {}),
            },
          },
        },
        ConfigurationSetName: this.config.configurationSet,
      }),
    );
    logger.debug({ provider: this.name }, 'mail sent');
    return { providerId: result.MessageId };
  }
}

/** What `mailProvider()` hands out: sends through the configured provider and records it in MessageDelivery. */
export class LoggedMailProvider implements MailProvider {
  constructor(readonly inner: MailProvider) {}

  get name(): string {
    return this.inner.name;
  }

  async send(message: MailMessage): Promise<ProviderSendResult | void> {
    return withDeliveryLog(
      { channel: 'EMAIL', type: message.type ?? 'GENERIC', provider: this.inner.name, to: message.to, tenantId: message.tenantId },
      () => this.inner.send(message),
    );
  }
}

let instance: LoggedMailProvider | undefined;

export function mailProvider(): MailProvider {
  if (!instance) {
    switch (env.MAIL_PROVIDER) {
      case 'console':
        instance = new LoggedMailProvider(new ConsoleMailProvider());
        break;
      case 'smtp':
        instance = new LoggedMailProvider(new SmtpMailProvider());
        break;
      case 'ses':
        instance = new LoggedMailProvider(
          new SesMailProvider({
            region: env.SES_REGION!,
            from: env.MAIL_FROM!,
            accessKeyId: env.SES_ACCESS_KEY_ID,
            secretAccessKey: env.SES_SECRET_ACCESS_KEY,
            configurationSet: env.SES_CONFIGURATION_SET,
          }),
        );
        break;
    }
  }
  return instance!;
}

/** Tests only: send through `provider` (still logged); undefined goes back to MAIL_PROVIDER. */
export function useMailProviderForTests(provider: MailProvider | undefined): void {
  instance = provider ? new LoggedMailProvider(provider) : undefined;
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
  mailProvider();
  const provider = instance?.inner;
  if (!(provider instanceof ConsoleMailProvider)) return undefined;
  return [...provider.outbox].reverse().find((m) => m.to === email);
}
