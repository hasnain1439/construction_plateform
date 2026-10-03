import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const durationPattern = /^\d+(ms|s|m|h|d)$/;

export const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.url().default('http://localhost:3000'),

  /** app_user — row-level security applies. */
  DATABASE_URL: z.string().startsWith('postgres', 'DATABASE_URL must be a PostgreSQL URL'),
  /** app_admin — BYPASSRLS. Auth lookups and platform-admin code only. */
  DATABASE_ADMIN_URL: z.string().startsWith('postgres', 'DATABASE_ADMIN_URL must be a PostgreSQL URL'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_PEPPER: z.string().min(32, 'JWT_REFRESH_PEPPER must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().regex(durationPattern, 'use e.g. 15m, 1h').default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_DOMAIN: z.string().optional(),
  /** Base URL clients use to reach this API (absolute signed file URLs). */
  API_PUBLIC_URL: z.url().optional(),
  /** local = disk (dev/tests); cloudinary = authenticated Cloudinary assets. */
  STORAGE_PROVIDER: z.enum(['local', 'cloudinary']).default('local'),
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  /** Optional: Cloudinary token-based auth key — enables expiring thumbnail URLs. */
  CLOUDINARY_AUTH_TOKEN_KEY: z.string().regex(/^[0-9a-fA-F]+$/, 'must be the hex key from the Cloudinary console').optional(),
  /** Folder for the local storage provider. */
  STORAGE_DIR: z.string().default('./storage'),
  /** Lifetime of signed attachment URLs. */
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
  SMS_PROVIDER: z.enum(['console']).default('console'),
  MAIL_PROVIDER: z.enum(['console']).default('console'),
  ENABLE_DOCS: booleanish.optional(),
  /** Value for Express "trust proxy" (number of hops). 0 = do not trust X-Forwarded-For. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  GENERAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.STORAGE_PROVIDER !== 'cloudinary') return;
    for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_PROVIDER=cloudinary` });
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
