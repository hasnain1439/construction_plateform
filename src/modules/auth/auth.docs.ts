import { z } from 'zod';
import {
  companySecurity,
  errors,
  jsonBody,
  platformSecurity,
  registry,
  success,
  type NamedExample,
} from '../../core/openapi/registry.js';
import {
  acceptInvitationBody,
  adminAuthResultDto,
  adminLoginBody,
  authResultDto,
  forgotPasswordBody,
  loginBody,
  meDto,
  otpRequestBody,
  otpVerifyBody,
  platformAdminDto,
  refreshBody,
  resetPasswordBody,
  sessionDto,
  signupBody,
  updateMeBody,
} from './auth.schema.js';

const Auth = ['Auth'];
const Admin = ['Platform admin auth'];
const RATE = { 429: ['RATE_LIMITED'] };
const VALIDATION = { 400: ['VALIDATION_ERROR'] };

// ─── Ready-to-run examples (seed accounts from `npm run db:seed`) ──────────

const ANDROID = { deviceId: 'swagger-android-0001', platform: 'ANDROID', model: 'Samsung A54', appVersion: '1.0.0' };
const IOS = { deviceId: 'swagger-iphone-0001', platform: 'IOS', model: 'iPhone 15', appVersion: '1.0.0' };

const ex = (summary: string, value: unknown, description?: string): NamedExample => ({
  summary,
  value,
  ...(description ? { description } : {}),
});

const loginExamples = {
  ownerWeb: ex('Khalid — THEKEDAR (web, cookies)', { login: '03001234567', password: 'Thekedar#2026', client: 'web' },
    'Sets httpOnly cookies. Every other "Try it out" call is then authenticated automatically.'),
  ownerMobile: ex('Khalid — THEKEDAR (mobile, tokens)', { login: '03001234567', password: 'Thekedar#2026', client: 'mobile', device: ANDROID },
    'Copy data.accessToken → Authorize → bearerAuth.'),
  ownerEmail: ex('Khalid — login with email', { login: 'khalid@maliksons.pk', password: 'Thekedar#2026', client: 'web' }),
  pm: ex('Bilal — PM, no financials (web)', { login: '03331112233', password: 'Bilal#2026', client: 'web' }),
  ahmed: ex('Ahmed — THEKEDAR of the 2nd company (web)', { login: '03331234567', password: 'Ahmed#2026', client: 'web' }),
  wrong: ex('❌ Wrong password → 401', { login: '03001234567', password: 'Wrong#2026', client: 'web' }),
  otpOnly: ex('❌ Munshi has no password → 400 USE_OTP_LOGIN', { login: '03211234567', password: 'Anything#1', client: 'web' }),
};

const signupExamples = {
  web: ex('New company (web)', {
    companyName: 'Rehman Builders',
    ownerName: 'Abdul Rehman',
    phone: '03451234567',
    email: 'rehman@builders.pk',
    password: 'Rehman#2026',
    region: 'PUNJAB_KP',
    marlaStandard: 225,
    client: 'web',
  }, 'Change the phone to sign up again (one company per owner phone).'),
  mobile: ex('New company (mobile, Karachi)', {
    companyName: 'Sindh Constructions',
    ownerName: 'Faisal Memon',
    phone: '03121234567',
    password: 'Faisal#2026',
    region: 'KARACHI_SINDH',
    marlaStandard: 272.25,
    client: 'mobile',
    device: IOS,
  }),
  taken: ex('❌ Phone already owns a company → 409', {
    companyName: 'Duplicate Co',
    ownerName: 'Khalid Malik',
    phone: '03001234567',
    password: 'Thekedar#2026',
    region: 'PUNJAB_KP',
  }),
};

const otpRequestExamples = {
  owner: ex('Khalid (one company)', { phone: '03001234567', purpose: 'LOGIN' }),
  munshi: ex('Rafaqat — Munshi in two companies', { phone: '03211234567', purpose: 'LOGIN' }),
  unknown: ex('❌ Unregistered phone → 404', { phone: '03119876543' }),
};

const otpVerifyExamples = {
  ownerWeb: ex('Khalid (web)', { phone: '03001234567', code: '123456', client: 'web' },
    'Replace code with the 6 digits printed in the server console.'),
  munshiMobile: ex('Rafaqat (mobile) → 409 MULTIPLE_COMPANIES', { phone: '03211234567', code: '123456', client: 'mobile', device: ANDROID },
    'Then resend with one tenantId from error.details.companies.'),
  munshiPicked: ex('Rafaqat with tenantId', {
    phone: '03211234567',
    code: '123456',
    tenantId: '00000000-0000-7000-8000-000000000000',
    client: 'mobile',
    device: ANDROID,
  }, 'Paste a tenantId from the MULTIPLE_COMPANIES response.'),
};

const refreshExamples = {
  web: ex('Web — uses the refresh_token cookie', { client: 'web' }),
  mobile: ex('Mobile — send the refresh token', { client: 'mobile', refreshToken: 'paste data.refreshToken from a mobile login' }),
};

// ─── Response examples ──────────────────────────────────────────────────────

const authResultExample = {
  success: true,
  data: {
    user: {
      id: '0199a8c0-0000-7000-8000-000000000001',
      name: 'Khalid Malik',
      phone: '+923001234567',
      email: 'khalid@maliksons.pk',
      role: 'THEKEDAR',
      language: 'ROMAN_URDU',
      photoUrl: null,
      canSeeFinancials: false,
    },
    tenant: {
      id: '0199a8c0-0000-7000-8000-0000000000aa',
      name: 'Malik & Sons Builders',
      slug: 'malik-and-sons-builders',
      logoUrl: null,
      status: 'ACTIVE',
      readOnly: false,
      region: 'PUNJAB_KP',
      marlaStandard: 225,
    },
    subscription: { plan: { code: 'PROFESSIONAL', name: 'Professional' }, status: 'ACTIVE', renewsOn: '2026-11-01T00:00:00.000Z', trialEndsAt: null },
    permissions: ['company.update', 'users.manage', 'billing.view', 'profit.view', 'rates.view', 'store.manage', 'projects.manage', 'site.entry'],
    accessTokenExpiresIn: 900,
    accessToken: '<jwt — mobile only>',
    refreshToken: '<opaque — mobile only>',
  },
};

const authOk = (description: string) => ({
  description,
  content: { 'application/json': { schema: success(authResultDto), example: authResultExample } },
});

const tokensDto = z.object({
  accessTokenExpiresIn: z.number().meta({ example: 900 }),
  accessToken: z.string().optional().meta({ description: 'Mobile only' }),
  refreshToken: z.string().optional().meta({ description: 'Mobile only' }),
});

const cookiesNote =
  '**Web** (`client: "web"`): sets httpOnly `access_token` + `refresh_token` cookies; tokens are not in the body. ' +
  '**Mobile** (`client: "mobile"`): returns `accessToken` + `refreshToken` in the body.';

const AUTH_401 = { 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'SESSION_REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_REVOKED'] };

export function registerAuthDocs(): void {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/signup',
    tags: Auth,
    summary: 'Create a company and its owner (THEKEDAR)',
    description: `Starts a 14-day trial. ${cookiesNote}`,
    request: { body: jsonBody(signupBody, signupExamples) },
    responses: { 201: authOk('Company created and signed in'), ...errors({ ...VALIDATION, 409: ['PHONE_TAKEN'], ...RATE }) },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: Auth,
    summary: 'Log in with phone/email + password',
    description:
      `${cookiesNote}\n\n` +
      'Several companies match → `409 MULTIPLE_COMPANIES` with `details.companies`; resend with `tenantId`. ' +
      '5 wrong passwords lock the account for 15 min (`423`).',
    request: { body: jsonBody(loginBody, loginExamples) },
    responses: {
      200: authOk('Signed in'),
      ...errors({
        400: ['VALIDATION_ERROR', 'USE_OTP_LOGIN'],
        401: ['INVALID_CREDENTIALS'],
        403: ['COMPANY_SUSPENDED'],
        409: ['MULTIPLE_COMPANIES'],
        423: ['ACCOUNT_LOCKED'],
        ...RATE,
      }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/otp/request',
    tags: Auth,
    summary: 'Send a 6-digit login code by SMS',
    description: 'Valid 5 min. Resend after 60 s, max 5 per hour. **In development the code is printed in the server console.**',
    request: { body: jsonBody(otpRequestBody, otpRequestExamples) },
    responses: {
      200: {
        description: 'Code sent',
        content: {
          'application/json': {
            schema: success(z.object({ sent: z.literal(true), expiresIn: z.number(), resendAfter: z.number() })),
            example: { success: true, data: { sent: true, expiresIn: 300, resendAfter: 60 } },
          },
        },
      },
      ...errors({ ...VALIDATION, 404: ['PHONE_NOT_REGISTERED'], 429: ['OTP_RESEND_WAIT', 'OTP_LIMIT_REACHED', 'RATE_LIMITED'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/otp/verify',
    tags: Auth,
    summary: 'Sign in with the SMS code',
    description: `${cookiesNote}\n\n3 wrong codes invalidate it. On \`409 MULTIPLE_COMPANIES\` the code stays valid — resend with \`tenantId\`.`,
    request: { body: jsonBody(otpVerifyBody, otpVerifyExamples) },
    responses: {
      200: authOk('Signed in'),
      ...errors({
        400: ['VALIDATION_ERROR', 'OTP_INVALID'],
        401: ['INVALID_CREDENTIALS'],
        403: ['COMPANY_SUSPENDED'],
        409: ['MULTIPLE_COMPANIES'],
        410: ['OTP_EXPIRED'],
        429: ['OTP_TOO_MANY_ATTEMPTS', 'RATE_LIMITED'],
      }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/refresh',
    tags: Auth,
    summary: 'Get a new access token (rotates the refresh token)',
    description:
      'Every call returns a **new** refresh token; the old one stops working. ' +
      'Re-using an old token signs out the whole session family (`401 REFRESH_TOKEN_REUSED`).',
    request: { body: jsonBody(refreshBody, refreshExamples) },
    responses: {
      200: { description: 'New tokens', content: { 'application/json': { schema: success(tokensDto) } } },
      ...errors({ 401: ['REFRESH_INVALID', 'REFRESH_TOKEN_REUSED', 'DEVICE_REVOKED'], 403: ['COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout',
    tags: Auth,
    summary: 'Sign out this session',
    security: companySecurity,
    responses: {
      200: { description: 'Signed out; cookies cleared', content: { 'application/json': { schema: success(z.object({ loggedOut: z.literal(true) })) } } },
      ...errors(AUTH_401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout-all',
    tags: Auth,
    summary: 'Sign out every session of the current user',
    security: companySecurity,
    responses: {
      200: {
        description: 'All sessions revoked',
        content: { 'application/json': { schema: success(z.object({ loggedOut: z.literal(true), revoked: z.number() })) } },
      },
      ...errors(AUTH_401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/password/forgot',
    tags: Auth,
    summary: 'Send a password-reset code (SMS + email)',
    description: 'Always answers `{ sent: true }` so accounts cannot be discovered. The code is printed in the server console in development.',
    request: {
      body: jsonBody(forgotPasswordBody, {
        phone: ex('Khalid by phone', { login: '03001234567' }),
        email: ex('Khalid by email', { login: 'khalid@maliksons.pk' }),
        unknown: ex('Unknown login (still { sent: true })', { login: 'nobody@example.com' }),
      }),
    },
    responses: {
      200: { description: 'Accepted', content: { 'application/json': { schema: success(z.object({ sent: z.literal(true) })), example: { success: true, data: { sent: true } } } } },
      ...errors({ ...VALIDATION, ...RATE }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/password/reset',
    tags: Auth,
    summary: 'Set a new password with the reset code',
    description: 'Signs out **every** session of the user.',
    request: {
      body: jsonBody(resetPasswordBody, {
        khalid: ex('Khalid', { login: '03001234567', code: '123456', newPassword: 'NewPass#2026' },
          'Use the code from the server console. Run `npm run db:seed` to restore the original password.'),
      }),
    },
    responses: {
      200: { description: 'Password changed', content: { 'application/json': { schema: success(z.object({ reset: z.literal(true) })) } } },
      ...errors({ 400: ['VALIDATION_ERROR', 'OTP_INVALID'], 409: ['MULTIPLE_COMPANIES'], 410: ['OTP_EXPIRED'], 429: ['OTP_TOO_MANY_ATTEMPTS', 'RATE_LIMITED'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/me',
    tags: Auth,
    summary: 'Current user, company, subscription and permissions',
    description: 'Log in first (web example sets the cookie, or Authorize with a mobile token).',
    security: companySecurity,
    responses: {
      200: { description: 'Profile', content: { 'application/json': { schema: success(meDto) } } },
      ...errors({ ...AUTH_401, 403: ['COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/auth/me',
    tags: Auth,
    summary: 'Update own name, photo, language or password',
    description: 'Changing the password signs out all **other** sessions.',
    security: companySecurity,
    request: {
      body: jsonBody(updateMeBody, {
        language: ex('Change language', { language: 'URDU' }),
        name: ex('Change name', { name: 'Khalid Malik Sahib' }),
        password: ex('Change password (Khalid)', { currentPassword: 'Thekedar#2026', newPassword: 'Thekedar#2027' },
          'Run `npm run db:seed` afterwards to restore the demo password.'),
        wrong: ex('❌ Wrong current password → 400', { currentPassword: 'Nope#2026', newPassword: 'Thekedar#2027' }),
      }),
    },
    responses: {
      200: { description: 'Updated profile', content: { 'application/json': { schema: success(meDto) } } },
      ...errors({ 400: ['VALIDATION_ERROR', 'CURRENT_PASSWORD_WRONG'], ...AUTH_401, 403: ['COMPANY_SUSPENDED'], 404: ['ATTACHMENT_NOT_FOUND'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/sessions',
    tags: Auth,
    summary: 'My active sessions / devices',
    security: companySecurity,
    responses: {
      200: { description: 'Sessions', content: { 'application/json': { schema: success(z.array(sessionDto)) } } },
      ...errors(AUTH_401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/invitations/{token}/accept',
    tags: Auth,
    summary: 'Accept an invitation and create the account',
    description: `Password is required for PM and optional for MUNSHI. ${cookiesNote}\n\nThe seeded invite works once; run \`npm run db:seed\` to reset it.`,
    request: {
      params: z.object({
        token: z.string().meta({ example: 'dev-invite-kamran-shah-2026-0001', description: 'Token from the invitation link' }),
      }),
      body: jsonBody(acceptInvitationBody, {
        web: ex('Kamran — PM (web)', { name: 'Kamran Shah', password: 'Kamran#2026', client: 'web' }),
        mobile: ex('Kamran — PM (mobile)', { name: 'Kamran Shah', password: 'Kamran#2026', client: 'mobile', device: ANDROID }),
        noPassword: ex('❌ PM without password → 400', { name: 'Kamran Shah', client: 'web' }),
      }),
    },
    responses: {
      201: authOk('Account created and signed in'),
      ...errors({
        ...VALIDATION,
        402: ['PLAN_LIMIT_REACHED'],
        403: ['COMPANY_SUSPENDED'],
        404: ['INVITE_NOT_FOUND'],
        409: ['INVITE_ALREADY_ACCEPTED', 'PHONE_TAKEN'],
        410: ['INVITE_EXPIRED', 'INVITE_CANCELLED'],
        ...RATE,
      }),
    },
  });

  // ─── Platform admin ──────────────────────────────────────────────────────
  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/auth/login',
    tags: Admin,
    summary: 'Platform admin login',
    description: 'Separate from company login. Web clients receive `admin_access_token` / `admin_refresh_token` cookies.',
    request: {
      body: jsonBody(adminLoginBody, {
        web: ex('Platform admin (web, cookies)', { email: 'admin@platform.local', password: 'Admin#2026', client: 'web' }),
        mobile: ex('Platform admin (tokens)', { email: 'admin@platform.local', password: 'Admin#2026', client: 'mobile' },
          'Copy data.accessToken → Authorize → bearerAuth.'),
      }),
    },
    responses: {
      200: { description: 'Signed in', content: { 'application/json': { schema: success(adminAuthResultDto) } } },
      ...errors({ ...VALIDATION, 401: ['INVALID_CREDENTIALS'], 423: ['ACCOUNT_LOCKED'], ...RATE }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/auth/refresh',
    tags: Admin,
    summary: 'Rotate platform admin refresh token',
    request: { body: jsonBody(refreshBody, refreshExamples) },
    responses: {
      200: { description: 'New tokens', content: { 'application/json': { schema: success(tokensDto) } } },
      ...errors({ 401: ['REFRESH_INVALID', 'REFRESH_TOKEN_REUSED'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/admin/auth/logout',
    tags: Admin,
    summary: 'Platform admin logout',
    security: platformSecurity,
    responses: {
      200: { description: 'Signed out', content: { 'application/json': { schema: success(z.object({ loggedOut: z.literal(true) })) } } },
      ...errors({ ...AUTH_401, 403: ['FORBIDDEN'] }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/admin/auth/me',
    tags: Admin,
    summary: 'Platform admin profile',
    security: platformSecurity,
    responses: {
      200: { description: 'Profile', content: { 'application/json': { schema: success(platformAdminDto) } } },
      ...errors({ ...AUTH_401, 403: ['FORBIDDEN'] }),
    },
  });
}
