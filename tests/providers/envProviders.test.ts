import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost/db',
  DATABASE_ADMIN_URL: 'postgresql://a:p@localhost/db',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_REFRESH_PEPPER: 'y'.repeat(40),
};
const realProviders = {
  SMS_PROVIDER: 'http',
  SMS_HTTP_URL: 'https://sms.example.pk/send',
  MAIL_PROVIDER: 'ses',
  SES_REGION: 'eu-west-1',
  MAIL_FROM: 'no-reply@mail.example.pk',
  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'munshi-files',
  S3_REGION: 'me-central-1',
};

function problems(input: Record<string, string>) {
  const parsed = envSchema.safeParse({ ...base, ...input });
  return parsed.success ? [] : parsed.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`);
}

describe('production refuses dev providers', () => {
  it('console SMS, console mail and local storage are refused in production with clear messages', () => {
    const out = problems({ NODE_ENV: 'production' });
    expect(out.map((p) => p.split(':')[0]).sort()).toEqual(['MAIL_PROVIDER', 'SMS_PROVIDER', 'STORAGE_PROVIDER']);
    expect(out.join('\n')).toContain('SMS_PROVIDER=console only prints codes to the terminal');
    expect(out.join('\n')).toContain('ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true (staging only)');
  });

  it('real providers start; the staging override allows dev providers; development / test never complain', () => {
    expect(problems({ NODE_ENV: 'production', ...realProviders })).toEqual([]);
    expect(problems({ NODE_ENV: 'production', ALLOW_DEV_PROVIDERS_IN_PRODUCTION: 'true' })).toEqual([]);
    expect(problems({ NODE_ENV: 'development' })).toEqual([]);
    expect(problems({ NODE_ENV: 'test' })).toEqual([]);
    expect(problems({ NODE_ENV: 'production', ...realProviders, MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.pk', STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' })).toEqual([]);
  });
});

describe('provider settings are validated at start-up', () => {
  it('SMS http: URL required, auth needs its secret, regexes must compile, templates must be JSON', () => {
    expect(problems({ SMS_PROVIDER: 'http' })).toEqual(['SMS_HTTP_URL: SMS_HTTP_URL is required when SMS_PROVIDER=http']);
    expect(problems({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'ftp://x' })[0]).toContain('must be an http(s) URL');
    expect(problems({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://x/send?to={to}&m={message}', SMS_HTTP_AUTH: 'bearer' })).toEqual([
      'SMS_HTTP_API_KEY: SMS_HTTP_API_KEY is required when SMS_HTTP_AUTH=bearer',
    ]);
    expect(problems({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://x', SMS_HTTP_AUTH: 'basic' }).map((p) => p.split(':')[0])).toEqual(['SMS_HTTP_USERNAME', 'SMS_HTTP_PASSWORD']);
    expect(problems({ SMS_HTTP_SUCCESS_MATCH: '(' })[0]).toContain('not a valid regular expression');
    expect(problems({ SMS_TEMPLATES: '{"OTP": 5}' })[0]).toContain('must be a JSON object of strings');
    const ok = envSchema.parse({ ...base, SMS_TEMPLATES: '{"OTP":"Code {code}"}', SMS_TEMPLATE_IDS: '{"OTP":"1001"}' });
    expect(ok.SMS_TEMPLATES).toEqual({ OTP: 'Code {code}' });
    expect(ok.SMS_TEMPLATE_IDS).toEqual({ OTP: '1001' });
  });

  it('SES needs a region and MAIL_FROM; static keys come in pairs', () => {
    expect(problems({ MAIL_PROVIDER: 'ses' }).map((p) => p.split(':')[0])).toEqual(['SES_REGION', 'MAIL_FROM']);
    expect(problems({ MAIL_PROVIDER: 'ses', SES_REGION: 'eu-west-1', MAIL_FROM: 'a@b.pk', SES_ACCESS_KEY_ID: 'AKIA' })[0]).toContain('set both SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY');
  });

  it('WhatsApp is off by default; on, it needs the phone number id and token', () => {
    expect(envSchema.parse(base).WHATSAPP_ENABLED).toBe(false);
    expect(problems({ WHATSAPP_ENABLED: 'true' }).map((p) => p.split(':')[0])).toEqual(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN']);
    expect(problems({ WHATSAPP_ENABLED: 'true', WHATSAPP_PHONE_NUMBER_ID: '1098765432', WHATSAPP_ACCESS_TOKEN: 't' })).toEqual([]);
  });

  it('S3 needs bucket + region; keys in pairs; SSE defaults to AES256', () => {
    expect(problems({ STORAGE_PROVIDER: 's3' }).map((p) => p.split(':')[0])).toEqual(['S3_BUCKET', 'S3_REGION']);
    expect(problems({ STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', S3_REGION: 'auto', S3_SECRET_ACCESS_KEY: 's' })[0]).toContain('set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
    const parsed = envSchema.parse({ ...base, STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', S3_REGION: 'auto', S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', S3_FORCE_PATH_STYLE: 'true' });
    expect(parsed.S3_SERVER_SIDE_ENCRYPTION).toBe('AES256');
    expect(parsed.S3_FORCE_PATH_STYLE).toBe(true);
  });
});
