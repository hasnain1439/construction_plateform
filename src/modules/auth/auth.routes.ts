import { Router } from 'express';
import { asyncHandler as h } from '../../core/http/asyncHandler.js';
import { authenticate } from '../../core/middleware/authenticate.js';
import { authRateLimit } from '../../core/middleware/rateLimit.js';
import { requirePlatformAdmin } from '../../core/middleware/requirePlatformAdmin.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { validate } from '../../core/middleware/validate.js';
import { assertAdminSessionActive } from './admin.service.js';
import * as c from './auth.controller.js';
import {
  acceptInvitationBody,
  adminLoginBody,
  forgotPasswordBody,
  invitationTokenParams,
  loginBody,
  otpRequestBody,
  otpVerifyBody,
  refreshBody,
  resetPasswordBody,
  signupBody,
  updateMeBody,
} from './auth.schema.js';

/** Mounted at /api/v1/auth */
export const authRouter = Router();

authRouter.post('/signup', authRateLimit, validate({ body: signupBody }), h(c.signup));
authRouter.post('/login', authRateLimit, validate({ body: loginBody }), h(c.login));
authRouter.post('/otp/request', authRateLimit, validate({ body: otpRequestBody }), h(c.requestOtp));
authRouter.post('/otp/verify', authRateLimit, validate({ body: otpVerifyBody }), h(c.verifyOtp));
authRouter.post('/refresh', validate({ body: refreshBody }), h(c.refresh));
authRouter.post('/password/forgot', authRateLimit, validate({ body: forgotPasswordBody }), h(c.forgotPassword));
authRouter.post('/password/reset', authRateLimit, validate({ body: resetPasswordBody }), h(c.resetPassword));

// Signing out must work even when the company is suspended or read-only.
authRouter.post('/logout', authenticate, h(c.logout));
authRouter.post('/logout-all', authenticate, h(c.logoutAll));

// Profile and own security settings. Not behind readOnlyGuard: a read-only company's
// users can still change their password and language.
authRouter.get('/me', authenticate, tenantContext, h(c.getMe));
authRouter.patch('/me', authenticate, tenantContext, validate({ body: updateMeBody }), h(c.updateMe));
authRouter.get('/sessions', authenticate, tenantContext, h(c.listSessions));

/** Mounted at /api/v1/invitations */
export const invitationRouter = Router();

invitationRouter.post(
  '/:token/accept',
  authRateLimit,
  validate({ params: invitationTokenParams, body: acceptInvitationBody }),
  h(c.acceptInvitation),
);

/** Mounted at /api/v1/admin/auth */
export const adminAuthRouter = Router();

adminAuthRouter.post('/login', authRateLimit, validate({ body: adminLoginBody }), h(c.adminLogin));
adminAuthRouter.post('/refresh', validate({ body: refreshBody }), h(c.adminRefresh));
/** Platform admin with a live session (future platform-admin routes should use this too). */
export const requireActivePlatformAdmin = [...requirePlatformAdmin, h(async (_req, _res, next) => {
  await assertAdminSessionActive();
  next();
})];

adminAuthRouter.post('/logout', ...requirePlatformAdmin, h(c.adminLogout));
adminAuthRouter.get('/me', ...requireActivePlatformAdmin, h(c.adminMe));
