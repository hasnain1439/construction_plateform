import { isProduction } from '../../config/env.js';

/**
 * Markdown shown at the top of /api/docs (OpenAPI `info.description`).
 * Developer-facing guide to the API: clients, auth flow, roles, errors.
 */
const seedAccounts = `
## 🧪 Dev accounts (seed)

Run \`npm run db:seed\`. Not shown in production.

| Who | Login | Password |
|---|---|---|
| Platform admin | \`admin@platform.local\` → *Platform admin auth* | \`Admin#2026\` |
| Khalid Malik — THEKEDAR, Malik & Sons Builders | \`03001234567\` | \`Thekedar#2026\` |
| Bilal Ahmed — PM (no financials), Malik & Sons | \`03331112233\` | \`Bilal#2026\` |
| Rafaqat Ali — MUNSHI in **both** companies | \`03211234567\` (OTP → \`MULTIPLE_COMPANIES\`) | — |
| Ahmed Raza — THEKEDAR, Ahmed Constructions | \`03331234567\` | \`Ahmed#2026\` |
| Kamran Shah — pending PM invite | token \`dev-invite-kamran-shah-2026-0001\` | chosen on accept |

OTP codes are printed in the **server console** (\`SMS_PROVIDER=console\`).
`;

export function apiOverview(): string {
  return `
Backend for a **multi-tenant Construction Management SaaS**. Each tenant is a construction company with its own users, projects and data, isolated by PostgreSQL row-level security.

## 🚀 Try it in 30 seconds

1. Open **Auth → POST /api/v1/auth/login** → *Try it out*.
2. Send \`{ "login": "03001234567", "password": "Thekedar#2026", "client": "mobile" }\`.
3. Copy \`data.accessToken\` → click **Authorize** (top right) → paste into **bearerAuth**.
4. Call **GET /api/v1/auth/me**.

> With \`"client": "web"\` the server sets httpOnly cookies instead, and the browser sends them on every *Try it out* call automatically.

## 👷 Roles & permissions

| Role | Who | Permissions |
|---|---|---|
| **THEKEDAR** | Company owner / admin | everything: \`company.update\` \`users.manage\` \`billing.view\` \`profit.view\` \`rates.view\` \`store.manage\` \`projects.manage\` \`site.entry\` |
| **PM** | Project manager | \`projects.manage\` \`rates.view\` \`site.entry\` (+ \`billing.view\` \`profit.view\` when *canSeeFinancials*) |
| **MUNSHI** | Site supervisor (mobile, SMS code login) | \`site.entry\` only — never rates or financials |
| **PLATFORM_ADMIN** | Platform owners (separate login) | platform routes only; cannot call company routes |

The company is **always taken from the signed token**, never from headers, query or URL.

## 🔐 Web vs mobile

Every sign-in endpoint accepts \`client: "web" | "mobile"\` (default **web**).

| | Web (Next.js) | Mobile (React Native) |
|---|---|---|
| Access token (15 min) | \`access_token\` httpOnly cookie | \`accessToken\` in body → \`Authorization: Bearer …\` |
| Refresh token (30 days) | \`refresh_token\` httpOnly cookie (path \`/api/v1/auth\`) | \`refreshToken\` in body → secure storage |
| Refresh | \`POST /auth/refresh\` with \`{}\` | \`POST /auth/refresh\` with \`{ "client": "mobile", "refreshToken" }\` |
| Device | optional | \`device: { deviceId, platform, model?, appVersion? }\` **required** |

## 🔄 Refresh rotation

Every refresh returns a **new** refresh token and kills the old one. If an old (already rotated) token comes back, it was copied: the **whole session family is signed out** → \`401 REFRESH_TOKEN_REUSED\`. Clients should run one refresh at a time and queue other 401s behind it.

## 🏢 One phone, several companies

A Munshi can work for more than one company. Login / OTP verify then answer **\`409 MULTIPLE_COMPANIES\`** with \`details.companies: [{ tenantId, name, role }]\`. Ask the user and resend the same request with \`tenantId\` (the OTP stays valid).

## 📦 Conventions

- **Success:** \`{ "success": true, "data": …, "meta"?: … }\`
- **Error:** \`{ "success": false, "error": { "code": "…", "message": "…", "details"?: … } }\` — switch on \`code\`, show \`message\`.
- **Money** is integer **paisa** sent as a string (\`"950000"\` = Rs 9,500). **IDs** are UUID v7. **Times** are UTC ISO-8601.
- **Phones** accept \`03001234567\`, \`+92 300 1234567\`, \`923001234567\` and are returned as \`+923001234567\`.

## ⚠️ Common error codes

| Status | Codes |
|---|---|
| 400 | \`VALIDATION_ERROR\` (see \`details.fields\`), \`USE_OTP_LOGIN\`, \`OTP_INVALID\`, \`CURRENT_PASSWORD_WRONG\` |
| 401 | \`UNAUTHENTICATED\`, \`TOKEN_INVALID\`, \`TOKEN_EXPIRED\`, \`INVALID_CREDENTIALS\`, \`REFRESH_INVALID\`, \`REFRESH_TOKEN_REUSED\`, \`DEVICE_REVOKED\` |
| 402 | \`PLAN_LIMIT_REACHED\` |
| 403 | \`COMPANY_SUSPENDED\`, \`ACCOUNT_READ_ONLY\`, \`FORBIDDEN\` |
| 404 / 409 / 410 | \`PHONE_NOT_REGISTERED\`, \`INVITE_NOT_FOUND\` · \`PHONE_TAKEN\`, \`MULTIPLE_COMPANIES\` · \`OTP_EXPIRED\`, \`INVITE_EXPIRED\` |
| 423 / 429 | \`ACCOUNT_LOCKED\` (\`details.retryAfterSeconds\`) · \`RATE_LIMITED\`, \`OTP_RESEND_WAIT\`, \`OTP_TOO_MANY_ATTEMPTS\` |

**Limits:** 5 wrong passwords → locked 15 min · OTP valid 5 min, resend after 60 s, max 5/hour, 3 wrong tries · auth endpoints 10 req/min per IP + login.
${isProduction ? '' : seedAccounts}`;
}

export const TAGS = [
  { name: 'Health', description: 'Liveness check.' },
  {
    name: 'Auth',
    description:
      'Company users (THEKEDAR, PM, MUNSHI): signup, password & SMS-code login, token refresh, profile, sessions, password reset and invitations.',
  },
  {
    name: 'Platform admin auth',
    description: 'Platform owners only. Separate accounts, sessions and `platform`-audience tokens.',
  },
];
