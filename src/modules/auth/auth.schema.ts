/**
 * Auth request/response schemas. Pure Zod (examples via `.meta`) so the Next.js and
 * React Native clients can import them for form validation.
 */
import { z } from 'zod';
import { normalizePkPhone } from '../../core/utils/phone.js';

// ─── Building blocks ────────────────────────────────────────────────────────

export const PHONE_MESSAGE = 'Enter a valid Pakistani mobile number, e.g. 03001234567';

export const phoneSchema = z
  .string({ error: 'Phone number is required' })
  .trim()
  .transform((value, ctx) => {
    const phone = normalizePkPhone(value);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
      return z.NEVER;
    }
    return phone;
  })
  .meta({ example: '03001234567', description: 'Pakistani mobile; normalised to +923001234567' });

export const emailSchema = z
  .email({ error: 'Enter a valid email address' })
  .trim()
  .toLowerCase()
  .max(254)
  .meta({ example: 'khalid@maliksons.pk' });

export const passwordSchema = z
  .string({ error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/\d/, 'Password must contain at least one number')
  .meta({ example: 'Thekedar#2026' });

/** Email or phone. Phones are normalised; emails lower-cased. */
export const loginIdentifierSchema = z
  .string({ error: 'Email or phone is required' })
  .trim()
  .min(3, 'Email or phone is required')
  .max(254)
  .transform((value, ctx) => {
    if (value.includes('@')) {
      const parsed = z.email().safeParse(value.toLowerCase());
      if (parsed.success) return parsed.data;
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email address' });
      return z.NEVER;
    }
    const phone = normalizePkPhone(value);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email or Pakistani mobile number' });
      return z.NEVER;
    }
    return phone;
  })
  .meta({ example: '03001234567', description: 'Email address or Pakistani mobile number' });

export const otpCodeSchema = z
  .string({ error: 'Code is required' })
  .trim()
  .regex(/^\d{6}$/, 'Code must be 6 digits')
  .meta({ example: '123456' });

export const clientSchema = z
  .enum(['web', 'mobile'])
  .default('web')
  .meta({ description: '"web" → httpOnly cookies; "mobile" → tokens in the response body' });

export const regionSchema = z.enum(['PUNJAB_KP', 'KARACHI_SINDH'], { error: 'Region must be PUNJAB_KP or KARACHI_SINDH' });
export const languageSchema = z.enum(['ENGLISH', 'ROMAN_URDU', 'URDU']);
export const roleSchema = z.enum(['THEKEDAR', 'PM', 'MUNSHI']);

export const deviceSchema = z
  .object({
    deviceId: z.string().trim().min(8, 'deviceId must be at least 8 characters').max(128),
    platform: z.enum(['ANDROID', 'IOS', 'WEB']),
    model: z.string().trim().max(120).optional(),
    appVersion: z.string().trim().max(40).optional(),
  })
  .meta({
    id: 'Device',
    example: { deviceId: 'a1b2c3d4-e5f6-4789-9abc-def012345678', platform: 'ANDROID', model: 'Samsung A54', appVersion: '1.0.0' },
  });

const tenantIdSchema = z.uuid({ error: 'tenantId must be a UUID' }).meta({ description: 'Pick a company after MULTIPLE_COMPANIES' });

/** Mobile clients must identify their device (needed for device revocation). */
function requireDeviceForMobile(value: { client: 'web' | 'mobile'; device?: unknown }, ctx: z.RefinementCtx) {
  if (value.client === 'mobile' && !value.device) {
    ctx.addIssue({ code: 'custom', path: ['device'], message: 'device is required for mobile clients' });
  }
}

// ─── Request bodies ─────────────────────────────────────────────────────────

export const signupBody = z
  .object({
    companyName: z.string().trim().min(2, 'Company name is too short').max(120),
    ownerName: z.string().trim().min(2, 'Name is too short').max(80),
    phone: phoneSchema,
    email: emailSchema.optional(),
    password: passwordSchema,
    region: regionSchema,
    marlaStandard: z
      .union([z.literal(225), z.literal(272.25)], { error: 'marlaStandard must be 225 or 272.25' })
      .optional()
      .meta({ description: 'Square feet per marla. Defaults to 225.' }),
    client: clientSchema,
    device: deviceSchema.optional(),
  })
  .superRefine(requireDeviceForMobile)
  .meta({
    example: {
      companyName: 'Malik & Sons Builders',
      ownerName: 'Khalid Malik',
      phone: '03001234567',
      email: 'khalid@maliksons.pk',
      password: 'Thekedar#2026',
      region: 'PUNJAB_KP',
      marlaStandard: 225,
      client: 'mobile',
      device: { deviceId: 'a1b2c3d4-e5f6-4789-9abc-def012345678', platform: 'ANDROID', model: 'Samsung A54' },
    },
  });

export const loginBody = z
  .object({
    login: loginIdentifierSchema,
    password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(200),
    tenantId: tenantIdSchema.optional(),
    client: clientSchema,
    device: deviceSchema.optional(),
  })
  .superRefine(requireDeviceForMobile)
  .meta({ example: { login: '03001234567', password: 'Thekedar#2026', client: 'web' } });

export const otpRequestBody = z
  .object({
    phone: phoneSchema,
    purpose: z.enum(['LOGIN']).default('LOGIN'),
  })
  .meta({ example: { phone: '03211234567', purpose: 'LOGIN' } });

export const otpVerifyBody = z
  .object({
    phone: phoneSchema,
    code: otpCodeSchema,
    tenantId: tenantIdSchema.optional(),
    client: clientSchema,
    device: deviceSchema.optional(),
  })
  .superRefine(requireDeviceForMobile)
  .meta({
    example: {
      phone: '03211234567',
      code: '123456',
      client: 'mobile',
      device: { deviceId: 'a1b2c3d4-e5f6-4789-9abc-def012345678', platform: 'ANDROID' },
    },
  });

export const refreshBody = z
  .object({
    client: clientSchema,
    refreshToken: z.string().min(20).max(200).optional().meta({ description: 'Mobile only. Web sends the refresh_token cookie.' }),
  })
  .superRefine((value, ctx) => {
    if (value.client === 'mobile' && !value.refreshToken) {
      ctx.addIssue({ code: 'custom', path: ['refreshToken'], message: 'refreshToken is required for mobile clients' });
    }
  })
  .meta({ example: { client: 'mobile', refreshToken: '<opaque refresh token>' } });

export const forgotPasswordBody = z.object({ login: loginIdentifierSchema }).meta({ example: { login: '03001234567' } });

export const resetPasswordBody = z
  .object({
    login: loginIdentifierSchema,
    code: otpCodeSchema,
    newPassword: passwordSchema,
    tenantId: tenantIdSchema.optional(),
  })
  .meta({ example: { login: '03001234567', code: '123456', newPassword: 'NewPass#2026' } });

export const updateMeBody = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80).optional(),
    photoAttachmentId: z.uuid().nullable().optional(),
    language: languageSchema.optional(),
    currentPassword: z.string().min(1).max(200).optional(),
    newPassword: passwordSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.currentPassword) !== Boolean(value.newPassword)) {
      ctx.addIssue({
        code: 'custom',
        path: [value.currentPassword ? 'newPassword' : 'currentPassword'],
        message: 'currentPassword and newPassword must be sent together',
      });
    }
    if (Object.values(value).every((v) => v === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Nothing to update' });
    }
  })
  .meta({ example: { name: 'Khalid Malik', language: 'URDU' } });

export const invitationTokenParams = z.object({
  token: z.string().min(16, 'Invalid invitation link').max(200),
});

export const acceptInvitationBody = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80).optional(),
    password: passwordSchema.optional().meta({ description: 'Required for PM, optional for MUNSHI' }),
    client: clientSchema,
    device: deviceSchema.optional(),
  })
  .superRefine(requireDeviceForMobile)
  .meta({ example: { name: 'Kamran Shah', password: 'Kamran#2026', client: 'web' } });

export const adminLoginBody = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(200),
    client: clientSchema,
  })
  .meta({ example: { email: 'admin@platform.local', password: 'Admin#2026', client: 'web' } });

// ─── Response shapes ────────────────────────────────────────────────────────

export const userDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    role: roleSchema,
    language: languageSchema,
    photoUrl: z.string().nullable(),
    canSeeFinancials: z.boolean(),
  })
  .meta({ id: 'User' });

export const tenantDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    logoUrl: z.string().nullable(),
    status: z.enum(['ACTIVE', 'READ_ONLY', 'SUSPENDED', 'CLOSED']),
    readOnly: z.boolean(),
    region: regionSchema,
    marlaStandard: z.number().meta({ example: 225 }),
  })
  .meta({ id: 'Tenant' });

export const subscriptionDto = z
  .object({
    plan: z.object({ code: z.string(), name: z.string() }),
    status: z.enum(['TRIAL', 'ACTIVE', 'GRACE', 'LAPSED', 'CANCELLED']),
    renewsOn: z.iso.datetime().nullable(),
    trialEndsAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Subscription' });

export const authResultDto = z
  .object({
    user: userDto,
    tenant: tenantDto,
    subscription: subscriptionDto.nullable(),
    permissions: z.array(z.string()),
    accessTokenExpiresIn: z.number().meta({ example: 900, description: 'Seconds' }),
    accessToken: z.string().optional().meta({ description: 'Mobile only' }),
    refreshToken: z.string().optional().meta({ description: 'Mobile only' }),
  })
  .meta({ id: 'AuthResult' });

export const meDto = z
  .object({
    user: userDto,
    tenant: tenantDto,
    subscription: subscriptionDto.nullable(),
    permissions: z.array(z.string()),
    assignedProjectIds: z.array(z.uuid()).meta({ description: 'Empty for THEKEDAR = all projects' }),
  })
  .meta({ id: 'Me' });

export const sessionDto = z
  .object({
    id: z.uuid(),
    platform: z.enum(['ANDROID', 'IOS', 'WEB']),
    model: z.string().nullable(),
    appVersion: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    lastActiveAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .meta({ id: 'Session' });

export const multipleCompaniesDetails = z.object({
  companies: z.array(z.object({ tenantId: z.uuid(), name: z.string(), role: roleSchema })),
});

export const platformAdminDto = z
  .object({ id: z.uuid(), email: z.string(), name: z.string(), lastLoginAt: z.iso.datetime().nullable() })
  .meta({ id: 'PlatformAdmin' });

export const adminAuthResultDto = z
  .object({
    admin: platformAdminDto,
    accessTokenExpiresIn: z.number(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
  })
  .meta({ id: 'AdminAuthResult' });

// ─── Types ──────────────────────────────────────────────────────────────────

export type Client = z.infer<typeof clientSchema>;
export type DeviceInput = z.infer<typeof deviceSchema>;
export type SignupInput = z.infer<typeof signupBody>;
export type LoginInput = z.infer<typeof loginBody>;
export type OtpRequestInput = z.infer<typeof otpRequestBody>;
export type OtpVerifyInput = z.infer<typeof otpVerifyBody>;
export type RefreshInput = z.infer<typeof refreshBody>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordBody>;
export type ResetPasswordInput = z.infer<typeof resetPasswordBody>;
export type UpdateMeInput = z.infer<typeof updateMeBody>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationBody>;
export type AdminLoginInput = z.infer<typeof adminLoginBody>;
export type UserDto = z.infer<typeof userDto>;
export type TenantDto = z.infer<typeof tenantDto>;
export type SubscriptionDto = z.infer<typeof subscriptionDto>;
export type MeDto = z.infer<typeof meDto>;
export type SessionDto = z.infer<typeof sessionDto>;
export type PlatformAdminDto = z.infer<typeof platformAdminDto>;
