import { z } from 'zod';
import {
  companySecurity,
  errors,
  jsonBody,
  platformSecurity,
  registry,
  success,
} from '../../core/openapi/registry.js';
import {
  acceptInvitationBody,
  adminAuthResultDto,
  adminLoginBody,
  authResultDto,
  forgotPasswordBody,
  invitationTokenParams,
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

const tokensDto = z.object({
  accessTokenExpiresIn: z.number().meta({ example: 900 }),
  accessToken: z.string().optional().meta({ description: 'Mobile only' }),
  refreshToken: z.string().optional().meta({ description: 'Mobile only' }),
});

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
    subscription: {
      plan: { code: 'PROFESSIONAL', name: 'Professional' },
      status: 'ACTIVE',
      renewsOn: '2026-11-01T00:00:00.000Z',
      trialEndsAt: null,
    },
    permissions: ['company.update', 'users.manage', 'billing.view', 'profit.view', 'rates.view', 'store.manage', 'projects.manage', 'site.entry'],
    accessTokenExpiresIn: 900,
    accessToken: '<jwt — mobile only>',
    refreshToken: '<opaque — mobile only>',
  },
};

const webCookiesNote =
  'Web (`client: "web"`): sets httpOnly `access_token` (path /, 15 min) and `refresh_token` (path /api/v1/auth, 30 days) cookies; tokens are not in the body. ' +
  'Mobile (`client: "mobile"`): returns `accessToken` + `refreshToken` in the body.';

export function registerAuthDocs(): void {
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/signup',
    tags: Auth,
    summary: 'Create a company (tenant) and its owner (THEKEDAR)',
    description: `Starts a 14-day trial. ${webCookiesNote}`,
    request: { body: jsonBody(signupBody) },
    responses: {
      201: { description: 'Company created and signed in', content: { 'application/json': { schema: success(authResultDto), example: authResultExample } } },
      ...errors({ ...VALIDATION, 409: ['PHONE_TAKEN'], ...RATE }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: Auth,
    summary: 'Log in with email/phone + password',
    description:
      `${webCookiesNote}\n\nIf the login belongs to several companies (and the password matches more than one), ` +
      'the API answers 409 `MULTIPLE_COMPANIES` with `details.companies[]`; resend with `tenantId`. ' +
      'After 5 wrong passwords the account is locked for 15 minutes (423 `ACCOUNT_LOCKED`, `details.retryAfterSeconds`).',
    request: { body: jsonBody(loginBody) },
    responses: {
      200: { description: 'Signed in', content: { 'application/json': { schema: success(authResultDto), example: authResultExample } } },
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
    description: 'Codes expire after 5 minutes. A new code can be requested after 60 s, at most 5 per hour. In development the code is printed to the server console.',
    request: { body: jsonBody(otpRequestBody) },
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
    description: `${webCookiesNote}\n\nThree wrong codes invalidate it (429). On 409 \`MULTIPLE_COMPANIES\` the code stays valid — resend with \`tenantId\`.`,
    request: { body: jsonBody(otpVerifyBody) },
    responses: {
      200: { description: 'Signed in', content: { 'application/json': { schema: success(authResultDto), example: authResultExample } } },
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
    summary: 'Rotate the refresh token and get a new access token',
    description:
      'Web: send the `refresh_token` cookie (body may be empty). Mobile: send `{ client: "mobile", refreshToken }`. ' +
      'Every call returns a NEW refresh token; the old one stops working. Re-using an old token signs out the whole session family (401 `REFRESH_TOKEN_REUSED`).',
    request: { body: jsonBody(refreshBody) },
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
      200: {
        description: 'Signed out; cookies cleared',
        content: { 'application/json': { schema: success(z.object({ loggedOut: z.literal(true) })) } },
      },
      ...errors({ 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED'] }),
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
      ...errors({ 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/password/forgot',
    tags: Auth,
    summary: 'Send a password-reset code (SMS, and email if on file)',
    description: 'Always answers `{ sent: true }` so the endpoint cannot be used to discover accounts.',
    request: { body: jsonBody(forgotPasswordBody) },
    responses: {
      200: {
        description: 'Accepted',
        content: { 'application/json': { schema: success(z.object({ sent: z.literal(true) })), example: { success: true, data: { sent: true } } } },
      },
      ...errors({ ...VALIDATION, ...RATE }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/password/reset',
    tags: Auth,
    summary: 'Set a new password with the reset code',
    description: 'Signs out every session of the user.',
    request: { body: jsonBody(resetPasswordBody) },
    responses: {
      200: { description: 'Password changed', content: { 'application/json': { schema: success(z.object({ reset: z.literal(true) })) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'OTP_INVALID'],
        409: ['MULTIPLE_COMPANIES'],
        410: ['OTP_EXPIRED'],
        429: ['OTP_TOO_MANY_ATTEMPTS', 'RATE_LIMITED'],
      }),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/me',
    tags: Auth,
    summary: 'Current user, company, subscription and permissions',
    security: companySecurity,
    responses: {
      200: { description: 'Profile', content: { 'application/json': { schema: success(meDto) } } },
      ...errors({ 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED'], 403: ['COMPANY_SUSPENDED'] }),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/auth/me',
    tags: Auth,
    summary: 'Update own name, photo, language or password',
    description: 'Changing the password signs out all other sessions.',
    security: companySecurity,
    request: { body: jsonBody(updateMeBody, { currentPassword: 'Thekedar#2026', newPassword: 'Thekedar#2027' }) },
    responses: {
      200: { description: 'Updated profile', content: { 'application/json': { schema: success(meDto) } } },
      ...errors({
        400: ['VALIDATION_ERROR', 'CURRENT_PASSWORD_WRONG'],
        401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED'],
        403: ['COMPANY_SUSPENDED'],
        404: ['ATTACHMENT_NOT_FOUND'],
      }),
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
      ...errors({ 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED'] }),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/invitations/{token}/accept',
    tags: Auth,
    summary: 'Accept an invitation and create the account',
    description: `Password is required for PM and optional for MUNSHI (who can sign in with SMS codes). ${webCookiesNote}`,
    request: { params: invitationTokenParams, body: jsonBody(acceptInvitationBody) },
    responses: {
      201: { description: 'Account created and signed in', content: { 'application/json': { schema: success(authResultDto) } } },
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
    request: { body: jsonBody(adminLoginBody) },
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
    request: { body: jsonBody(refreshBody) },
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
      ...errors({ 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED'], 403: ['FORBIDDEN'] }),
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
      ...errors({ 401: ['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED'], 403: ['FORBIDDEN'] }),
    },
  });
}
