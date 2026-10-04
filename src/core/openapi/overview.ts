import { isProduction } from '../../config/env.js';

/**
 * Markdown shown at the top of /api/docs (OpenAPI `info.description`).
 * Kept short: how to start testing, roles, response format, error codes.
 */
const testAccounts = `
### Test accounts

Created by \`npm run db:seed\` (re-run it any time to reset passwords, locks and the invite). Every request body has ready-made **Examples** in its dropdown.

| Account | Login | Password |
|---|---|---|
| Khalid Malik — THEKEDAR, *Malik & Sons Builders* | \`03001234567\` · \`khalid@maliksons.pk\` | \`Thekedar#2026\` |
| Bilal Ahmed — PM (no financials), *Malik & Sons* | \`03331112233\` | \`Bilal#2026\` |
| Rafaqat Ali — MUNSHI in **two** companies | \`03211234567\` | SMS code only |
| Ahmed Raza — THEKEDAR, *Ahmed Constructions* | \`03331234567\` | \`Ahmed#2026\` |
| Platform admin | \`admin@platform.local\` | \`Admin#2026\` |
| Kamran Shah — pending PM invite | token \`dev-invite-kamran-shah-2026-0001\` | set on accept |

SMS / email codes are printed in the **server console**.
`;

export function apiOverview(): string {
  return `
Multi-tenant backend for a **Construction Management SaaS**. Each tenant is a construction company (*thekedar*) with its own users, projects and data, isolated by PostgreSQL row-level security. One API serves the **Next.js** web app and the **React Native** mobile app.

### Getting started

1. Open **Auth → \`POST /api/v1/auth/login\`**, pick the example **"Khalid — THEKEDAR (web, cookies)"** and click **Execute**.
2. The server sets httpOnly \`access_token\` / \`refresh_token\` cookies — every other *Try it out* call (e.g. \`GET /api/v1/auth/me\`) is now logged in automatically.
3. To test like the mobile app instead, pick a **(mobile, tokens)** example, copy \`data.accessToken\`, click **Authorize** and paste it into **bearerAuth**.
${isProduction ? '' : testAccounts}
### Roles

| Role | Scope | Created by | Can do |
|---|---|---|---|
| **THEKEDAR** | One company | Self sign-up | Everything in the company |
| **PM** | One company | Invitation | Projects & rates; billing/profit only if *canSeeFinancials* |
| **MUNSHI** | One or more companies | Invitation | Site entries only — logs in with an SMS code on mobile |
| **PLATFORM_ADMIN** | Whole platform | Database seed | Platform routes only (separate login) |

> **Note:** the company is always taken from the signed token — never from headers, query or URL. If one phone belongs to several companies, login answers \`409 MULTIPLE_COMPANIES\` with the list; send the request again with \`tenantId\`.

### Response format

**Success**
\`\`\`json
{
  "success": true,
  "data": { },
  "meta": { }
}
\`\`\`

**Error**
\`\`\`json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid", "details": { } }
}
\`\`\`

Money is integer **paisa** sent as a string (\`"950000"\` = Rs 9,500) · IDs are UUID v7 · times are UTC · phones are returned as \`+923001234567\`.

### Common error codes

| HTTP | Code | What to do |
|---|---|---|
| **400** | \`VALIDATION_ERROR\` | Fix the fields listed in \`error.details.fields\`. |
| **400** | \`USE_OTP_LOGIN\` | This user has no password — use *otp/request* + *otp/verify*. |
| **401** | \`INVALID_CREDENTIALS\` | Wrong login or password. |
| **401** | \`UNAUTHENTICATED\` / \`TOKEN_EXPIRED\` | Log in, or call *auth/refresh* and retry. |
| **401** | \`SESSION_REVOKED\` / \`ACCOUNT_DISABLED\` / \`DEVICE_REVOKED\` / \`REFRESH_TOKEN_REUSED\` | Signed out (logout, deactivated, phone revoked or token copied) — log in again. |
| **400** | \`FILE_TOO_LARGE\` / \`INVALID_FILE_TYPE\` | Upload ≤ 10 MB in a type allowed for that \`kind\`. |
| **402** | \`PLAN_LIMIT_REACHED\` | The company's plan is full — upgrade the plan or deactivate an office user. |
| **403** | \`FORBIDDEN\` | Your role can't do this (e.g. only a THEKEDAR edits the company). |
| **403** | \`COMPANY_SUSPENDED\` | Company account is suspended — contact support. |
| **403** | \`ACCOUNT_READ_ONLY\` | Company is read-only — renew the subscription to make changes. |
| **403** | \`LINK_EXPIRED\` / \`INVALID_SIGNATURE\` | File link is old or edited — fetch the attachment again for a fresh \`url\`. |
| **404** | \`*_NOT_FOUND\` | Doesn't exist **in your company** (other companies' data is invisible). |
| **409** | \`MULTIPLE_COMPANIES\` | Ask which company, resend with \`tenantId\`. |
| **409** | \`PHONE_TAKEN\` / \`EMAIL_TAKEN\` / \`ALREADY_MEMBER\` / \`INVITE_PENDING\` | Person already exists or is invited — edit or resend instead. |
| **410** | \`OTP_EXPIRED\` / \`INVITE_EXPIRED\` | Request a new code / invitation. |
| **423** | \`ACCOUNT_LOCKED\` | 5 wrong passwords — wait \`details.retryAfterSeconds\`. |
| **429** | \`RATE_LIMITED\` / \`OTP_RESEND_WAIT\` | Too many requests — wait and retry. |
`;
}

export const TAGS = [
  { name: 'Health', description: 'Liveness check' },
  {
    name: 'Auth',
    description: 'Sign-up, password & SMS-code login, token refresh, profile, sessions, password reset and invitations',
  },
  { name: 'Company', description: 'Company profile, business rules (settings) and the holiday calendar' },
  { name: 'Team', description: 'Team members, invitations and signed-in devices (THEKEDAR manages, PM can view the list)' },
  { name: 'Subscription', description: 'Plan, trial/grace status, usage limits, payment slips and plan changes (THEKEDAR)' },
  { name: 'Attachments', description: 'File uploads (logos, photos, receipts, documents, voice notes) with signed download links' },
  { name: 'Materials', description: 'Material groups and the company material list (all roles; never shows rates)' },
  { name: 'Price List', description: 'Quality categories (A+ / A / B) and material rates with full history (THEKEDAR, PM)' },
  { name: 'Labor Rates', description: 'Daily wages and sub-contract piece rates' },
  { name: 'Payment Templates', description: 'Client payment schedules (stages adding up to 100 %, optional retention)' },
  { name: 'Suppliers', description: 'Suppliers and their agreed rates (THEKEDAR, PM)' },
  { name: 'Workers', description: 'Daily-wage workers (site staff can add them)' },
  { name: 'Sub-contractors', description: 'Piece-rate teams by trade' },
  { name: 'Clients', description: 'Project owners (no login) — THEKEDAR, PM' },
  { name: 'Projects', description: 'Projects: list, create (draft), detail, review, activation and status. PM / MUNSHI see assigned projects only; others get 404' },
  { name: 'Project Wizard', description: 'Wizard tabs 1–4: basic, team, contract (supply rules + billing stages), plot & structure, coverage' },
  { name: 'Floors & Rooms', description: 'Tab 5: rooms and openings per floor, with area calculations' },
  { name: 'Platform admin auth', description: 'Platform owners only — separate accounts and tokens' },
  { name: 'Platform admin', description: 'Platform console: dashboard, companies, payment review, plans, holidays, material catalog, audit log (platform token)' },
];
