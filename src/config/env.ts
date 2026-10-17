import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const durationPattern = /^\d+(ms|s|m|h|d)$/;

/** Optional JSON object of string values, e.g. {"OTP":"Your code is {code}"}. */
const jsonStringMap = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (!value?.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((v) => typeof v === 'string')) {
        return parsed as Record<string, string>;
      }
    } catch {
      // reported below
    }
    ctx.addIssue({ code: 'custom', message: 'must be a JSON object of strings, e.g. {"OTP":"..."}' });
    return z.NEVER;
  });

/** `KEY=` in a .env file means "not set". */
const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

/** http(s) URL that may contain {placeholders}. */
const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');

export const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.url().default('http://localhost:3000'),

  /** app_user — row-level security applies. */
  DATABASE_URL: z.string().startsWith('postgres', 'DATABASE_URL must be a PostgreSQL URL'),
  /** app_admin — BYPASSRLS. Auth lookups and platform-admin code only. */
  DATABASE_ADMIN_URL: z.string().startsWith('postgres', 'DATABASE_ADMIN_URL must be a PostgreSQL URL'),
  /** Max connections per pool (app_user and app_admin each get one). Keep under Postgres max_connections. */
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
  /** How long a request may wait for a free connection before its transaction gives up (→ 503). */
  DB_TX_MAX_WAIT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_PEPPER: z.string().min(32, 'JWT_REFRESH_PEPPER must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().regex(durationPattern, 'use e.g. 15m, 1h').default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Lifetime of SMS / login codes. At most 10 minutes. */
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(600, 'OTP_TTL_SECONDS must be at most 600 (10 minutes)').default(300),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_DOMAIN: z.string().optional(),
  /** Base URL clients use to reach this API (absolute signed file URLs). */
  API_PUBLIC_URL: z.url().optional(),
  /** local = disk (dev/tests); cloudinary = authenticated Cloudinary assets; s3 = private S3 / R2 bucket. */
  STORAGE_PROVIDER: z.enum(['local', 'cloudinary', 's3']).default('local'),
  /** S3-compatible storage (AWS S3, Cloudflare R2, MinIO…). Private bucket; files are served by presigned GET URLs. */
  S3_BUCKET: z.string().min(1).optional(),
  /** AWS region (e.g. me-central-1, ap-south-1); "auto" for Cloudflare R2. */
  S3_REGION: z.string().min(1).optional(),
  /** Custom endpoint for non-AWS services, e.g. https://<account>.r2.cloudflarestorage.com */
  S3_ENDPOINT: z.url().optional(),
  /** Static keys; leave both unset to use the standard AWS credential chain (env, profile, IAM role). */
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Path-style URLs (https://host/bucket/key) — needed by MinIO and some S3-compatible services. */
  S3_FORCE_PATH_STYLE: booleanish.default(false),
  /** Server-side encryption of new objects. "none" only if an S3-compatible service rejects the header. */
  S3_SERVER_SIDE_ENCRYPTION: z.enum(['AES256', 'none']).default('AES256'),
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  /** Optional: Cloudinary token-based auth key — enables expiring thumbnail URLs. */
  CLOUDINARY_AUTH_TOKEN_KEY: z.string().regex(/^[0-9a-fA-F]+$/, 'must be the hex key from the Cloudinary console').optional(),
  /** Folder for the local storage provider. */
  STORAGE_DIR: z.string().default('./storage'),
  /** Lifetime of signed attachment URLs. */
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
  /** QA-B-02: lifetime of WhatsApp share links (/public/files/:id) — 1 to 90 days. */
  SHARE_LINK_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** QA-B-23: PDFs rendered at the same time per API process (the rest queue). */
  PDF_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(3),
  /** QA-B-23: how long a PDF may wait in the queue before 503 SERVICE_BUSY. */
  PDF_QUEUE_WAIT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  /** Mobile app: older builds see a "please update" screen. */
  MOBILE_MIN_APP_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
  MOBILE_LATEST_APP_VERSION: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
  /** console = print to the terminal (dev/tests); http = a generic HTTP SMS gateway (SMS_HTTP_*). */
  SMS_PROVIDER: z.enum(['console', 'http']).default('console'),
  /** Sender ID / mask registered with the gateway ({sender} in templates). */
  SMS_SENDER_ID: z.string().min(1).optional(),
  /** Gateway endpoint. May contain {to}, {message}, {sender}, {type}, {templateId} (URL-encoded). */
  SMS_HTTP_URL: httpUrl.optional(),
  SMS_HTTP_METHOD: z.enum(['GET', 'POST']).default('POST'),
  /** POST body format: json (application/json) or form (application/x-www-form-urlencoded). */
  SMS_HTTP_CONTENT_TYPE: z.enum(['json', 'form']).default('json'),
  /** POST body with the same placeholders (escaped for the content type). Defaults per content type. */
  SMS_HTTP_BODY_TEMPLATE: z.string().min(1).optional(),
  /** none | bearer (Authorization: Bearer key) | basic (username/password) | header (custom header = key) | query (?param=key). */
  SMS_HTTP_AUTH: z.enum(['none', 'bearer', 'basic', 'header', 'query']).default('none'),
  SMS_HTTP_API_KEY: z.string().min(1).optional(),
  SMS_HTTP_AUTH_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/, 'must be an HTTP header name').default('X-API-Key'),
  SMS_HTTP_AUTH_QUERY_PARAM: z.string().min(1).default('api_key'),
  SMS_HTTP_USERNAME: z.string().min(1).optional(),
  SMS_HTTP_PASSWORD: z.string().min(1).optional(),
  /** How {to} is written: e164 (+923001234567), international (923001234567), local (03001234567). */
  SMS_HTTP_PHONE_FORMAT: z.enum(['e164', 'international', 'local']).default('international'),
  /** Regex the response body must match to count as sent (besides a 2xx status). */
  SMS_HTTP_SUCCESS_MATCH: z.string().min(1).optional(),
  /** Regex that marks a 2xx response as failed (gateways that answer 200 with an error text). */
  SMS_HTTP_FAILURE_MATCH: z.string().min(1).optional(),
  /** Dot path of the message id in a JSON response, e.g. data.messageId. */
  SMS_HTTP_ID_PATH: z.string().min(1).optional(),
  SMS_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /** Per-message-type SMS text, JSON {"OTP":"…{code}…","INVITE":"…{url}…"}; other types keep the built-in text. */
  SMS_TEMPLATES: jsonStringMap,
  /** Per-message-type gateway template ids, JSON {"OTP":"1001"} — {templateId} in the URL / body. */
  SMS_TEMPLATE_IDS: jsonStringMap,
  /** console = print to the terminal (dev); smtp = SMTP_* settings; ses = Amazon SES API (SES_*). */
  MAIL_PROVIDER: z.enum(['console', 'smtp', 'ses']).default('console'),
  /** Amazon SES region, e.g. eu-west-1 / ap-south-1 / me-central-1. */
  SES_REGION: z.string().min(1).optional(),
  /** Static SES keys; leave both unset to use the standard AWS credential chain. */
  SES_ACCESS_KEY_ID: z.string().min(1).optional(),
  SES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Optional SES configuration set (bounce / complaint event publishing). */
  SES_CONFIGURATION_SET: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  /** true for port 465 (implicit TLS); defaults from the port. */
  SMTP_SECURE: booleanish.optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  /** Sender, e.g. "Construction Platform <no-reply@example.com>". Defaults to SMTP_USER. */
  MAIL_FROM: z.string().min(3).optional(),
  /** WhatsApp Cloud API (Meta). Off by default; when on, invites and login codes also go by WhatsApp. */
  WHATSAPP_ENABLED: booleanish.default(false),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/, 'must be the numeric phone number id from Meta').optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'e.g. v21.0').default('v21.0'),
  WHATSAPP_API_BASE_URL: z.url().default('https://graph.facebook.com'),
  /** Language code the templates were approved in (en, en_US, ur…). */
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().min(2).default('en'),
  WHATSAPP_TEMPLATE_INVOICE: z.string().min(1).default('invoice_issued'),
  WHATSAPP_TEMPLATE_STATEMENT: z.string().min(1).default('account_statement'),
  WHATSAPP_TEMPLATE_INVITE: z.string().min(1).default('team_invite'),
  WHATSAPP_TEMPLATE_OTP: z.string().min(1).default('login_code'),
  /** Staging only: allow console SMS / mail and local storage with NODE_ENV=production. */
  ALLOW_DEV_PROVIDERS_IN_PRODUCTION: booleanish.default(false),
  ENABLE_DOCS: booleanish.optional(),
  /** Value for Express "trust proxy" (number of hops). 0 = do not trust X-Forwarded-For. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Sign-in requests per minute per IP across all sign-in routes (whatever the phone / email). */
  AUTH_IP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  /** Code-sending requests (OTP, forgot password) per hour per IP. */
  OTP_SEND_IP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  /** POST /sync/push calls per minute per user (each carries up to 100 mutations). */
  SYNC_PUSH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  GENERAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  /** Sentry error + performance monitoring. Empty = completely off (Sentry is never initialised). */
  SENTRY_DSN: z.preprocess(emptyToUndefined, z.url().optional()),
  /** Defaults to NODE_ENV. */
  SENTRY_ENVIRONMENT: z.preprocess(emptyToUndefined, z.string().min(1).max(64).optional()),
  /** e.g. the git sha or "construction-api@1.4.0". */
  SENTRY_RELEASE: z.preprocess(emptyToUndefined, z.string().min(1).max(200).optional()),
  /** Share of requests traced for performance (0–1). */
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  /** PostHog product analytics (project API key). Empty = off. */
  POSTHOG_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** PostHog host — https://us.i.posthog.com, https://eu.i.posthog.com or a self-hosted URL. */
  POSTHOG_HOST: z.preprocess(emptyToUndefined, z.url().default('https://us.i.posthog.com')),
  })
  .superRefine((value, ctx) => {
    const required = (key: keyof typeof value, when: string) => {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when ${when}` });
    };
    const pair = (a: keyof typeof value, b: keyof typeof value) => {
      if (Boolean(value[a]) !== Boolean(value[b])) {
        ctx.addIssue({ code: 'custom', path: [value[a] ? b : a], message: `set both ${a} and ${b}, or neither (standard AWS credential chain)` });
      }
    };

    if (value.MAIL_PROVIDER === 'smtp') required('SMTP_HOST', 'MAIL_PROVIDER=smtp');
    if (value.MAIL_PROVIDER === 'ses') {
      required('SES_REGION', 'MAIL_PROVIDER=ses');
      required('MAIL_FROM', 'MAIL_PROVIDER=ses (an address on a domain verified in SES)');
    }
    pair('SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY');

    if (value.SMS_PROVIDER === 'http') {
      required('SMS_HTTP_URL', 'SMS_PROVIDER=http');
      if (['bearer', 'header', 'query'].includes(value.SMS_HTTP_AUTH)) required('SMS_HTTP_API_KEY', `SMS_HTTP_AUTH=${value.SMS_HTTP_AUTH}`);
      if (value.SMS_HTTP_AUTH === 'basic') {
        required('SMS_HTTP_USERNAME', 'SMS_HTTP_AUTH=basic');
        required('SMS_HTTP_PASSWORD', 'SMS_HTTP_AUTH=basic');
      }
    }
    for (const key of ['SMS_HTTP_SUCCESS_MATCH', 'SMS_HTTP_FAILURE_MATCH'] as const) {
      const pattern = value[key];
      if (!pattern) continue;
      try {
        new RegExp(pattern);
      } catch {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is not a valid regular expression` });
      }
    }

    if (value.WHATSAPP_ENABLED) {
      required('WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ENABLED=true');
      required('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_ENABLED=true');
    }

    if (value.STORAGE_PROVIDER === 'cloudinary') {
      for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const) required(key, 'STORAGE_PROVIDER=cloudinary');
    }
    if (value.STORAGE_PROVIDER === 's3') {
      required('S3_BUCKET', 'STORAGE_PROVIDER=s3');
      required('S3_REGION', 'STORAGE_PROVIDER=s3 ("auto" for Cloudflare R2)');
    }
    pair('S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY');

    // Production must use real providers; a staging server may opt out explicitly.
    if (value.NODE_ENV === 'production' && !value.ALLOW_DEV_PROVIDERS_IN_PRODUCTION) {
      const hint = 'or set ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true (staging only)';
      if (value.SMS_PROVIDER === 'console') {
        ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: `SMS_PROVIDER=console only prints codes to the terminal — use SMS_PROVIDER=http in production, ${hint}` });
      }
      if (value.MAIL_PROVIDER === 'console') {
        ctx.addIssue({ code: 'custom', path: ['MAIL_PROVIDER'], message: `MAIL_PROVIDER=console sends no email — use ses or smtp in production, ${hint}` });
      }
      if (value.STORAGE_PROVIDER === 'local') {
        ctx.addIssue({ code: 'custom', path: ['STORAGE_PROVIDER'], message: `STORAGE_PROVIDER=local keeps files on this server's disk — use s3 or cloudinary in production, ${hint}` });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Logger depends on env, so fail with a plain message.
    console.error(`Invalid environment configuration:\n${problems}`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.BCRYPT_ROUNDS < 12) {
    console.error('BCRYPT_ROUNDS must be >= 12 in production');
    process.exit(1);
  }
  return env;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const docsEnabled = env.ENABLE_DOCS ?? !isProduction;
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/** Parses "15m" / "900s" / "1h" into seconds. */
export function durationToSeconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[unit as 'ms' | 's' | 'm' | 'h' | 'd'];
  return Math.floor(amount * factor);
}

export const accessTokenTtlSeconds = durationToSeconds(env.ACCESS_TOKEN_TTL);
export const apiPublicUrl = (env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '');
