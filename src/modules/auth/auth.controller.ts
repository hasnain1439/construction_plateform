/**
 * HTTP adapters only: read the validated request, call the service, shape the response.
 * No business rules live here.
 */
import type { Request, Response } from 'express';
import { created, ok } from '../../core/http/response.js';
import * as admin from './admin.service.js';
import type {
  AcceptInvitationInput,
  AdminLoginInput,
  ForgotPasswordInput,
  LoginInput,
  OtpRequestInput,
  OtpVerifyInput,
  RefreshInput,
  ResetPasswordInput,
  SignupInput,
  UpdateMeInput,
} from './auth.schema.js';
import * as auth from './auth.service.js';
import { clearAuthCookies, deliverTokens, readRefreshToken } from './token.service.js';

function authResponse(res: Response, client: 'web' | 'mobile', result: auth.AuthResult) {
  const { tokens, ...rest } = result;
  return { ...rest, ...deliverTokens(res, client, 'company', tokens) };
}

export async function signup(req: Request, res: Response) {
  const body = req.body as SignupInput;
  const result = await auth.signup(body);
  return created(res, authResponse(res, body.client, result));
}

export async function login(req: Request, res: Response) {
  const body = req.body as LoginInput;
  return ok(res, authResponse(res, body.client, await auth.login(body)));
}

export async function requestOtp(req: Request, res: Response) {
  return ok(res, await auth.requestLoginOtp(req.body as OtpRequestInput));
}

export async function verifyOtp(req: Request, res: Response) {
  const body = req.body as OtpVerifyInput;
  return ok(res, authResponse(res, body.client, await auth.verifyLoginOtp(body)));
}

export async function refresh(req: Request, res: Response) {
  const body = req.body as RefreshInput;
  const token = readRefreshToken(req, 'company', body.client === 'mobile' ? body.refreshToken : undefined);
  try {
    const { tokens } = await auth.refresh(token);
    return ok(res, deliverTokens(res, body.client, 'company', tokens));
  } catch (err) {
    if (body.client === 'web') clearAuthCookies(res, 'company');
    throw err;
  }
}

export async function logout(_req: Request, res: Response) {
  await auth.logout();
  clearAuthCookies(res, 'company');
  return ok(res, { loggedOut: true });
}

export async function logoutAll(_req: Request, res: Response) {
  const { revoked } = await auth.logoutAll();
  clearAuthCookies(res, 'company');
  return ok(res, { loggedOut: true, revoked });
}

export async function forgotPassword(req: Request, res: Response) {
  return ok(res, await auth.forgotPassword(req.body as ForgotPasswordInput));
}

export async function resetPassword(req: Request, res: Response) {
  return ok(res, await auth.resetPassword(req.body as ResetPasswordInput));
}

export async function getMe(_req: Request, res: Response) {
  return ok(res, await auth.getMe());
}

export async function updateMe(req: Request, res: Response) {
  return ok(res, await auth.updateMe(req.body as UpdateMeInput));
}

export async function listSessions(_req: Request, res: Response) {
  return ok(res, await auth.listSessions());
}

export async function acceptInvitation(req: Request, res: Response) {
  const body = req.body as AcceptInvitationInput;
  const result = await auth.acceptInvitation(String(req.params['token']), body);
  return created(res, authResponse(res, body.client, result));
}

// ─── Platform admin ─────────────────────────────────────────────────────────

export async function adminLogin(req: Request, res: Response) {
  const body = req.body as AdminLoginInput;
  const { tokens, admin: profile } = await admin.adminLogin(body);
  return ok(res, { admin: profile, ...deliverTokens(res, body.client, 'platform', tokens) });
}

export async function adminRefresh(req: Request, res: Response) {
  const body = req.body as RefreshInput;
  const token = readRefreshToken(req, 'platform', body.client === 'mobile' ? body.refreshToken : undefined);
  try {
    const { tokens } = await admin.adminRefresh(token);
    return ok(res, deliverTokens(res, body.client, 'platform', tokens));
  } catch (err) {
    if (body.client === 'web') clearAuthCookies(res, 'platform');
    throw err;
  }
}

export async function adminLogout(_req: Request, res: Response) {
  await admin.adminLogout();
  clearAuthCookies(res, 'platform');
  return ok(res, { loggedOut: true });
}

export async function adminMe(_req: Request, res: Response) {
  return ok(res, await admin.adminMe());
}
