# Construction Platform API

Multi-tenant backend for a Construction Management SaaS. Express 5 · TypeScript (strict, ESM) · Prisma 7 · PostgreSQL (row-level security) · Zod.

Tenant = construction company. Company users are `THEKEDAR` (owner), `PM` (project manager) and `MUNSHI` (site supervisor, phone OTP). Platform owners are `PLATFORM_ADMIN` in a separate table.

## Getting started

```bash
npm install
cp .env.example .env            # set DATABASE_MIGRATION_URL to your postgres superuser
npm run db:setup                # creates roles app_user / app_admin and the database
npm run db:migrate              # applies schema + RLS
npm run db:seed                 # demo data (prints the accounts below)
npm run dev                     # http://localhost:4000  ·  docs at /api/docs
```

| Script | What it does |
|---|---|
| `dev` / `build` / `start` | Watch mode · compile to `dist/` · run compiled |
| `db:setup` | Create/update DB roles + database from the URLs in `.env` |
| `db:migrate` / `db:migrate:deploy` | `prisma migrate dev` / `deploy` |
| `db:generate` / `db:seed` / `db:studio` | Prisma client · seed · Studio |
| `test` / `test:watch` | Vitest against the `construction_test` database (`.env.test`) |
| `typecheck` | Type-checks src, tests, prisma and scripts |
| `jobs:subscriptions` | Run the subscription lifecycle once (also runs in the server at start-up and daily 02:00 PKT) |
| `dev:otp -- <phone>` | Development / E2E only: issues a fresh login code for the phone and prints `OTP=123456` (refuses in production) |
| `docker:up` / `docker:down` | Postgres 16 + Redis 7 (optional; local Postgres works too) |

### Database roles

| Role | Used for | RLS |
|---|---|---|
| `app_user` (`DATABASE_URL`) | Everything tenant-scoped, always through `withTenant()` | **Applies** |
| `app_admin` (`DATABASE_ADMIN_URL`) | Cross-tenant auth lookups (login by phone/email, OTP, invitation by token) and platform-admin code only | `BYPASSRLS` |
| owner/superuser (`DATABASE_MIGRATION_URL`) | Prisma CLI only (migrations, seed) — never the running app | — |

`prisma/roles.sql` (or `npm run db:setup`) creates the two app roles for local dev. In production create them with strong passwords.

Every table with a `tenantId` has RLS **enabled and forced** with the policy `"tenantId" = current_setting('app.tenant_id')` (see `prisma/rls.sql`, included in the first migration). `withTenant(tenantId, fn)` opens a transaction and runs `set_config('app.tenant_id', …, true)` first, so the setting is transaction-local and never leaks across pooled connections. Outside `withTenant`, tenant tables return **no rows** (fail closed). `app_user` has no access at all to `PlatformAdmin*` or `OtpCode`.

`prismaAdmin` may only be imported by `src/modules/auth/**`, `src/modules/platform-admin/**`, seed, scripts and tests — `tests/guards/prismaAdminImports.test.ts` fails the build otherwise.

**When you add a tenant-scoped table:** in its migration add `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy, and `GRANT … TO app_user` (app_user gets no default privileges on purpose). Reference tenant-scoped parents with composite `(tenantId, id)` foreign keys.

### Conventions

- IDs are UUID v7, money is `BigInt` paisa (sent to clients as strings), timestamps UTC.
- Phones are normalised to `+923XXXXXXXXX` (`03001234567`, `+92 300 1234567`, `923001234567` all work).
- Success: `{ "success": true, "data": …, "meta"?: … }` · Error: `{ "success": false, "error": { "code", "message", "details"? } }`.
- Controllers have no business logic; services own transactions; repositories own Prisma calls.
- Connection pool: `DB_POOL_MAX` (default 20 per pool) and `DB_TX_MAX_WAIT_MS` (default 10 000 — how long a request waits for a free connection before `503 SERVICE_BUSY`).

---

## Auth

### Two clients, one API

Every sign-in endpoint accepts `client: "web" | "mobile"` (default `"web"`).

| | Web (Next.js) | Mobile (React Native) |
|---|---|---|
| Access token | `access_token` cookie — httpOnly, SameSite=Lax, path `/`, 15 min | `accessToken` in the body → send `Authorization: Bearer <token>` |
| Refresh token | `refresh_token` cookie — httpOnly, SameSite=Strict, path `/api/v1/auth`, 30 days | `refreshToken` in the body → keep in secure storage |
| Refresh call | `POST /api/v1/auth/refresh` with `{}` (cookie is sent automatically) | `POST /api/v1/auth/refresh` with `{ "client": "mobile", "refreshToken": "…" }` |
| Device | optional | `device: { deviceId, platform, model?, appVersion? }` required |

Cookies are `Secure` in production; set `COOKIE_DOMAIN` if web and API live on sibling subdomains. Web fetches must use `credentials: "include"`.

**Access token** — JWT HS256, 15 min, `iss: construction-api`. Company tokens: `aud: "company"`, `sub` (user), `tid` (tenant), `role`, `perms`, `sid` (session). Platform tokens: `aud: "platform"`, `role: "PLATFORM_ADMIN"`, separate cookies (`admin_access_token`, `admin_refresh_token`). A token of one audience is rejected on the other's routes. **The tenant always comes from the verified token** — never from headers, query or URL.

**Refresh token** — 48 random bytes, opaque. Only `sha256(token + JWT_REFRESH_PEPPER)` is stored in `Session.tokenHash`.

### Refresh rotation and reuse detection

```
login ─► session A (family F) ──refresh──► session B (F) ──refresh──► session C (F)
                 A.revokedAt, A.replacedById = B      B.revokedAt, B.replacedById = C
```

- Every refresh returns a **new** refresh token in the same family and revokes the old one.
- Presenting a token that was already rotated away means it was copied → **every session in the family is revoked**, `auth.refresh_reuse_detected` is audited, and the API answers `401 REFRESH_TOKEN_REUSED`. Both the attacker and the real user must log in again.
- Refresh also fails for an expired/unknown token (`REFRESH_INVALID`), a revoked device (`DEVICE_REVOKED`), a disabled user, or a suspended company (`403 COMPANY_SUSPENDED`).
- Clients should run one refresh at a time (queue concurrent 401s behind a single refresh), otherwise the second refresh looks like reuse.
- Every company request re-checks the login behind the access token (`tenantContext`, one indexed query): the user must be ACTIVE, the device not revoked, and the session family still alive. So logout, logout-all, password change/reset, deactivation, device revoke and refresh-token reuse cut access **immediately** (`401 SESSION_REVOKED` / `ACCOUNT_DISABLED` / `DEVICE_REVOKED`). A normal refresh keeps the family alive, so the previous access token keeps working until it expires. Role and financial-permission changes reach the token at the next refresh (≤ 15 min).

### Sign-in flows

- **Password** — `POST /auth/login { login, password }`. `login` is an email or phone. 5 wrong passwords lock the account for 15 min (`423 ACCOUNT_LOCKED`, `details.retryAfterSeconds`). Unknown login and wrong password give the same `401 INVALID_CREDENTIALS`.
- **OTP (Munshi)** — `POST /auth/otp/request { phone }` then `POST /auth/otp/verify { phone, code }`. 6 digits, valid 5 min, resend after 60 s, max 5 per hour, 3 wrong tries invalidate the code.
- **Several companies** — the same phone can work for more than one company. Login/verify then answer `409 MULTIPLE_COMPANIES` with `details.companies: [{ tenantId, name, role }]`; ask the user and resend with `tenantId` (an OTP stays valid for that).
- **Forgot password** — `POST /auth/password/forgot { login }` always answers `{ sent: true }`; the code goes by SMS (and email if on file). `POST /auth/password/reset { login, code, newPassword }` signs out every session.
- **Invitations** — `POST /invitations/:token/accept` creates the user (password required for PM, optional for Munshi), applies project access, checks the plan's office-user limit (`402 PLAN_LIMIT_REACHED`; Munshis don't count) and signs in.

Passwords: bcrypt cost 12, at least 8 characters with a letter and a number. Changing the password (`PATCH /auth/me`) signs out all *other* sessions.

### OTP codes in development

`SMS_PROVIDER=console` prints every SMS to the server terminal:

```
📱 [SMS → +923211234567] Your login code is 482913. It expires in 5 minutes. …
```

Codes never go to the structured (pino) log. Password-reset emails are printed the same way. To add a real gateway, implement `SmsProvider` / `MailProvider` in `src/modules/auth/sms.provider.ts` / `mail.provider.ts`.

### Email (invites and login codes)

Everything that goes by SMS also goes by email when the person has an email address:

- **New company** (platform console): the owner gets the invite link by SMS and email (owner email, or the company email).
- **Team invite** (PM / Munshi): the invite link by SMS and email (when the invite has an email). Resend does the same.
- **Login code** (`POST /auth/otp/request`): the code by SMS and to every email on that phone; the response says `emailed: true`.
- **Password reset**: as before.

Mail is best effort: a failed email never fails the request (the link can be resent). `MAIL_PROVIDER=console` prints mail to the terminal; for real email set `MAIL_PROVIDER=smtp` and `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (see `.env.example`; Gmail works with an App Password).

A Munshi signs in on the mobile app with **phone + code** or **phone + password**. The password is chosen when accepting the invite (optional for a Munshi) or set later by the Thekedar (`PUT /users/:id/password`).

### Seed accounts (`npm run db:seed`)

| Who | Login | Password |
|---|---|---|
| Platform admin | `admin@platform.local` (`POST /api/v1/admin/auth/login`) | `Admin#2026` |
| Malik & Sons Builders — Khalid Malik, THEKEDAR | `03001234567` / `khalid@maliksons.pk` | `Thekedar#2026` |
| Malik & Sons — Bilal Ahmed, PM (no financials) | `03331112233` | `Bilal#2026` |
| Malik & Sons + Ahmed Constructions — Rafaqat Ali, MUNSHI | `03211234567` (OTP only → `MULTIPLE_COMPANIES`) | — |
| Ahmed Constructions — Ahmed Raza, THEKEDAR | `03331234567` | `Ahmed#2026` |
| Pending invite — Kamran Shah, PM `03009988776` | token `dev-invite-kamran-shah-2026-0001` | (chosen on accept) |

### Protecting a new route

```ts
import { authenticate } from '../../core/middleware/authenticate.js';
import { tenantContext } from '../../core/middleware/tenantContext.js';
import { readOnlyGuard } from '../../core/middleware/readOnlyGuard.js';
import { requirePermission, requireRole } from '../../core/middleware/requireRole.js';
import { validate } from '../../core/middleware/validate.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant } from '../../core/db/withTenant.js';

router.post(
  '/projects',
  authenticate,                 // 401 unless a valid company token (cookie or Bearer)
  tenantContext,                // 403 COMPANY_SUSPENDED; flags READ_ONLY companies
  readOnlyGuard,                // 403 ACCOUNT_READ_ONLY for writes on READ_ONLY companies
  requireRole('THEKEDAR', 'PM'),// or requirePermission('projects.manage')
  validate({ body: createProjectBody }),
  h(controller.create),
);

// service
export function createProject(input: CreateProjectInput) {
  const { tenantId, userId } = getCtx();           // from the verified token
  return withTenant(tenantId!, (tx) => tx.project.create({ data: { ...input, tenantId: tenantId! } }));
}
```

Platform-admin routes use `...requirePlatformAdmin` instead of the first four middlewares.

Permissions (`src/core/auth/permissions.ts`): THEKEDAR has all; PM has `projects.manage`, `rates.view`, `site.entry` plus `billing.view` / `profit.view` when `canSeeFinancials`; MUNSHI has only `site.entry`.

### Endpoints

All under `/api/v1`, documented with examples at **`/api/docs`** (raw spec: `/api/docs.json`; disabled in production unless `ENABLE_DOCS=true`).

`POST auth/signup` · `POST auth/login` · `POST auth/otp/request` · `POST auth/otp/verify` · `POST auth/refresh` · `POST auth/logout` · `POST auth/logout-all` · `POST auth/password/forgot` · `POST auth/password/reset` · `GET|PATCH auth/me` · `GET auth/sessions` · `POST invitations/:token/accept` · `POST admin/auth/login|refresh|logout` · `GET admin/auth/me`

### Audit log

`tenant.signup`, `auth.login`, `auth.login_failed`, `auth.otp_verified`, `auth.refresh_reuse_detected`, `auth.logout`, `auth.logout_all`, `auth.password_reset`, `auth.password_changed`, `invite.accept`, `admin.login` — with IP, user agent and request id; never passwords, tokens or codes.

---

## Attachments

`src/modules/attachments` — files for every other module (logos, profile photos, site photos, receipts, documents, voice notes).

- `POST /api/v1/attachments` — multipart `file` + `kind`, max **10 MB**, any company role. Allowed per kind:

  | kind | types |
  |---|---|
  | `LOGO`, `PROFILE_PHOTO`, `SITE_PHOTO` | JPEG, PNG, WebP |
  | `RECEIPT`, `DOCUMENT` | JPEG, PNG, WebP, PDF |
  | `VOICE_NOTE` | MP3, M4A (audio/mp4), OGG |

  The first bytes of the file are checked against the declared type (a renamed HTML file is rejected).
- Stored through a `StorageProvider` (`put`, `getSignedUrl`, `delete`, `open`). The database never stores URLs; responses carry a **signed URL** valid `SIGNED_URL_TTL_SECONDS` (default 600 = 10 minutes).

### Storage providers

| `STORAGE_PROVIDER` | Where files go | Signed URL |
|---|---|---|
| `local` (default — dev and tests) | `STORAGE_DIR` (default `./storage`, git-ignored), key `tenantId/yyyy/mm/<id>.<ext>` | `/api/v1/attachments/:id/file?tid=&exp=&sig=`, `sig = HMAC-SHA256(JWT_REFRESH_PEPPER, id:tid:exp)`, served by this API (`403 INVALID_SIGNATURE` / `LINK_EXPIRED`). Set `API_PUBLIC_URL` for the public host. |
| `cloudinary` | Cloudinary **authenticated** assets (never public), folder `construction/{tenantId}/{yyyy}/{mm}`, `public_id` = attachment id; `resource_type` image (images), video (audio), raw (PDF). Key stored: `cloudinary:<resource_type>:<public_id>` | `private_download_url` with `expires_at` — signed by Cloudinary, expires after the TTL. Image thumbnails (`signedUrlFor(att, { thumbnailWidth: 400 })` → `w_400`, auto quality/format) are expiring only if `CLOUDINARY_AUTH_TOKEN_KEY` (token-based auth, a paid Cloudinary feature) is set; otherwise the expiring original is returned. |

**Switch to Cloudinary:**

```env
STORAGE_PROVIDER=cloudinary
CLOUDINARY_CLOUD_NAME=your-cloud
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=…
# optional, for expiring thumbnails:
# CLOUDINARY_AUTH_TOKEN_KEY=…
```

The three `CLOUDINARY_*` credentials are validated at start-up only when `STORAGE_PROVIDER=cloudinary`. Switching is safe in both directions: each stored key says which provider holds it (`storageForKey`), so existing local files stay readable after moving to Cloudinary (keep `STORAGE_DIR` until you migrate them). Tests always use the local provider; the Cloudinary provider is tested with a mocked SDK (`tests/cloudinaryProvider.test.ts`) and never calls Cloudinary.
- `GET /api/v1/attachments/:id` returns metadata + a fresh URL (RLS: other companies get 404).

Other modules call `signedUrlFor()` / `optionalSignedUrl()` from `attachments.service.ts` (company logo, user photo in `/auth/me`).

## Company

`src/modules/company` — mounted at `/api/v1/company`.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /company` | THEKEDAR, PM | Profile incl. signed `logoUrl` |
| `PATCH /company` | THEKEDAR | name 3–100, NTN `1234567-8`, logo (attachment of kind LOGO in this company, else 404), address, phone (mobile or landline → E.164), email, region, marlaStandard 225 / 272.25. Audit `company.update` stores changed field **names** only. |
| `GET /company/settings` · `PATCH` | THEKEDAR | `kharchaApprovalLimitPaisa` (paisa as string), `overuseAlertPercent` 1–20, `missingLogAlertTime` HH:MM, `quoteValidityDays` 1–90, `taxEnabled`, `pmCanSeeFinancials` (default for new PM invites), `defaultLanguage`. Audit `settings.update` with before/after. |
| `GET /company/holidays` | everyone | `year` or `from`+`to`. Platform holidays (nationwide or the company's region, `editable: false`) merged with company holidays, sorted. |
| `POST /company/holidays` · `DELETE /:id` | THEKEDAR | name, startDate (not in the past, company time zone), endDate ≥ startDate, type `NON_WORKING` / `PARTIAL`. Platform holidays can't be deleted (404). |

The seed adds the fixed-date national holidays (Kashmir Day, Pakistan Day, Labour Day, Independence Day, Iqbal Day, Quaid Day) for this year and next. Lunar holidays (Eids, Ashura) must be added per year by platform admins.

## Team

`src/modules/team` — users, invitations and devices.

**Users** (`/api/v1/users`)
- `GET /users` (THEKEDAR, PM): `search`, `role`, `status`, `projectId`, `page`, `limit` (25, max 100). `meta.usage = { officeUsers, maxOfficeUsers }` — office users are active THEKEDAR + PM; Munshis are free. PMs don't see `canSeeFinancials`.
- `GET /users/:id`, `PATCH /users/:id` (THEKEDAR): role only PM ↔ MUNSHI; nobody changes their own role (`CANNOT_CHANGE_OWN_ROLE`) or an owner's (`CANNOT_CHANGE_OWNER_ROLE`); `canSeeFinancials` only for PMs; MUNSHI → PM needs a free seat (`402`); duplicate phone `409 PHONE_TAKEN`. New role/permissions reach the user's token at their next refresh (`/auth/refresh` always recomputes from the database).
- `DELETE /users/:id` = soft deactivate: status `INACTIVE`, all sessions and devices revoked. Not yourself (`CANNOT_DEACTIVATE_SELF`), never the last active THEKEDAR (`LAST_THEKEDAR`). `assertNoOpenCashBalance()` is the hook for the cash module (TODO → `409 CASH_BALANCE_OPEN`).
- `POST /users/:id/reactivate` (PM re-checks the seat limit), `PUT /users/:id/projects` replaces the project list in one transaction (`400 INVALID_PROJECT` for ids outside the company, `400 THEKEDAR_HAS_ALL_PROJECTS`).

**Invitations** (`/api/v1/invitations`, THEKEDAR; the public accept route stays in Auth)
- `POST` sends a Roman Urdu SMS — *"Malik & Sons Builders ne aap ko Project Manager ke taur par invite kiya hai: <APP_URL>/invite/<token>"*. The token is random, stored only as a hash, valid 7 days. `409 ALREADY_MEMBER`, `409 INVITE_PENDING`; PM invites count **pending PM invites** against the seat limit. Non-production responses include `devInviteUrl`.
- `GET` (status default PENDING; overdue ones are flipped to EXPIRED on read), `POST /:id/resend` (PENDING/EXPIRED, new link, once per 60 s → `429 INVITE_RESEND_WAIT`), `DELETE /:id` (cancel; accepting then gives `410 INVITE_CANCELLED`).

**Devices** (`/api/v1/devices`, THEKEDAR)
- `GET` lists devices with user, `lastSyncAt`, `pendingUploads` (filled by the future sync module) and `current`.
- `DELETE /:id` revokes the device and its sessions — its refresh then fails with `401 DEVICE_REVOKED` until the user logs in again. Your own current device → `400 CANNOT_REVOKE_CURRENT_DEVICE`.

Audit actions added: `attachment.upload`, `company.update`, `settings.update`, `holiday.create`, `holiday.delete`, `user.update`, `user.deactivate`, `user.reactivate`, `user.projects_update`, `invite.create`, `invite.resend`, `invite.cancel`, `device.revoke`.

## Subscription

`src/modules/subscription` (company side; platform-admin review of payments is Phase 1 · Step 3B). All routes: **THEKEDAR only**, mounted at `/api/v1/subscription`.

### Statuses

| Subscription | Company (`Tenant.status`) | Meaning |
|---|---|---|
| `TRIAL` | ACTIVE | 14 days from sign-up (TRIAL plan = Starter limits) |
| `ACTIVE` | ACTIVE | Paid period running (`currentPeriodStart` → `currentPeriodEnd`) |
| `GRACE` | ACTIVE | Period ended; `graceEndsAt` = period end + 3 days to pay |
| `LAPSED` | **READ_ONLY** | Trial or grace ran out |
| `CANCELLED` | READ_ONLY | Reserved for platform admins |

SUSPENDED / CLOSED companies are platform-admin decisions and are never changed by the subscription code. Every change calls `invalidateTenantStatus(tenantId)`.

A READ_ONLY company can still sign out, use **every** `/subscription` route and upload an attachment of kind `PAYMENT_SLIP` — that is how it pays its way back. All other writes get `403 ACCOUNT_READ_ONLY`.

### Endpoints

| Endpoint | Notes |
|---|---|
| `GET /subscription` | plan (price in paisa, limits, features), status, dates, `daysLeft`, `usage { activeProjects, officeUsers }` with limits, `pendingChange`, `readOnly` |
| `GET /subscription/plans` | Active plans except TRIAL, `current: true` on yours |
| `POST /subscription/payments` | `planId?` (default: pending change, else current), `method` JAZZCASH/EASYPAISA/RAAST/IBFT, `transactionId` (trimmed, upper-cased), `amountPaisa` (= plan price, else `400 AMOUNT_MISMATCH` with `expectedPaisa`), `paidOn` (not future, ≤ 30 days old), `attachmentId` (this company's `PAYMENT_SLIP`, else 404). One `PENDING_REVIEW` at a time (`409 PAYMENT_PENDING`). Transaction ids are unique across **all** companies (`409 DUPLICATE_TRANSACTION` — the same answer whether the clash is yours or another company's; enforced by a global unique index, so no cross-tenant read is needed). |
| `GET /subscription/payments` | Paginated history with `status`, `rejectReason`, period and `receiptNo` (set on approval) |
| `POST /subscription/change-plan` | **Upgrade** (or any change while no paid period is running) → pending until its payment is approved; response has `amountDuePaisa`. **Downgrade** during a paid period → effective at `currentPeriodEnd`. Either way the company must fit the target: office users over the limit → `400 DOWNGRADE_USERS_OVER_LIMIT`; active projects over the limit → `keepActiveProjectIds` required (`KEEP_PROJECTS_REQUIRED`, `TOO_MANY_PROJECTS`, `INVALID_PROJECT`). Same plan → `400 SAME_PLAN`. |
| `DELETE /subscription/change-plan` | Cancels the pending change (`404 NO_PENDING_CHANGE`) |

### Plan limits

`src/core/plan/planLimits.ts` — `getUsage`, `getLimits`, `assertWithinLimit(tx, tenantId, 'activeProjects' | 'officeUsers', adding = 1)` → `402 PLAN_LIMIT_REACHED { resource, limit, used }`; `null` limit = unlimited. Office users = active THEKEDAR + PM **+ pending PM invitations** (they reserve a seat); Munshis never count. Accepting an invitation uses `countPendingInvites: false` because that invite already holds its seat. Hold `lockPlanUsage(tx, tenantId)` around check-then-create. Team (invites, promote, reactivate) and invitation accept use it; the Projects module must call it for `activeProjects`.

### Lifecycle job

`src/jobs/subscriptionLifecycle.ts` → `runSubscriptionLifecycle(now)` (cross-tenant, so it uses `prismaAdmin`; `src/jobs/**` is on the allowlist):

1. Scheduled downgrade due → switch plan; active projects not in `keepActiveProjectIds` → `READ_ONLY`.
2. `TRIAL` past `trialEndsAt` → `LAPSED` (company READ_ONLY).
3. `ACTIVE` past `currentPeriodEnd` → `GRACE` (`graceEndsAt` = end + 3 days).
4. `GRACE` past `graceEndsAt` → `LAPSED`.
5. SMS to active THEKEDARs 3 days and 1 day before a trial/period ends, once each: *"Aap ka Professional plan 15 Oct 2026 ko khatam ho raha hai. Payment slip upload karein."*

Every transition is a conditional update + `SYSTEM` audit row, so running it twice (or on two servers) is safe. The server runs it at start-up and daily at **02:00 Asia/Karachi** under `pg_try_advisory_lock` (only one instance runs it); disabled when `NODE_ENV=test`. Run it by hand with `npm run jobs:subscriptions` (production: `node dist/jobs/cli/subscriptions.js`). Note: other running servers cache company status for up to 60 s.

## Platform Admin

`src/modules/platform-admin` — the platform owners' console, mounted at `/api/v1/admin` (login stays at `/api/v1/admin/auth`). Every route: `authenticatePlatform → requirePlatformAdmin` (platform audience + role) → live admin session → `validate` → `asyncHandler`. Company tokens get 401. The module may use `prismaAdmin` (cross-tenant); every write adds an AuditLog row with `actorType PLATFORM_ADMIN`, `actorId` = admin id and `tenantId` = the company affected.

| Endpoint | What it does |
|---|---|
| `GET /admin/overview` | Company counts (active / trial / grace / read-only / suspended), `mrrPaisa` (plan prices of ACTIVE + GRACE subscriptions), payments awaiting review, trials ending in 7 days, companies per plan, approved revenue by month (12 months, PKT) |
| `GET /admin/health` | API, database + latency, SMS / mail / storage provider, version, uptime, last subscription-lifecycle run (`JobRun` table) |
| `GET /admin/tenants` | Search (name, slug, owner phone), filters (company status, subscription status, plan code, `renewsBefore`), owner, plan, usage vs limits, renewal date |
| `GET /admin/tenants/:id` | Profile, owner, settings, full subscription, usage, last 10 payments, last 20 audit events |
| `POST /admin/tenants` | Create a company in one transaction: settings, subscription (TRIAL with `trialDays` 1–60, or PAID = ACTIVE 30 days + an APPROVED payment with a receipt), and a 7-day **THEKEDAR invitation** for the owner (SMS). The owner accepts it with a password; as the company's first user they skip the office-seat check. `409 SLUG_TAKEN / DUPLICATE_TRANSACTION / PHONE_TAKEN`, `400 AMOUNT_MISMATCH` |
| `PATCH /admin/tenants/:id/status` | `EXTEND_TRIAL` (1–30 days; TRIAL or a lapsed trial → TRIAL + company ACTIVE), `SET_READ_ONLY`, `REACTIVATE` (company status implied by the subscription), `SUSPEND` / `CLOSE` (note required; every session revoked) |
| `PATCH /admin/tenants/:id/plan` | `IMMEDIATE` or `NEXT_RENEWAL`; same fit checks and error codes as the company-side change-plan (`subscription.rules.ts`) |
| `GET /admin/payments` · `GET /admin/payments/:id` | Review queue (PENDING_REVIEW, oldest first) with expected amount and `duplicateWarning`; detail with signed slip URL and `duplicateOf` |
| `POST /admin/payments/:id/approve` · `/reject` | See below. Reject needs a 5–300 character reason (sent by SMS, shown to the company) |
| `GET/POST /admin/plans`, `PATCH /admin/plans/:id` | All plans with company counts; code unique + immutable; price changes apply to future payments; the last active paid plan can't be deactivated (`409 LAST_ACTIVE_PLAN`) |
| `GET/POST /admin/holidays`, `PATCH/DELETE /admin/holidays/:id` | Platform holidays: date range, `NON_WORKING` / `PARTIAL`, nationwide or one region; merged into every company calendar |
| `GET /admin/audit-logs` | Filters `tenantId`, `actorType`, `action` (prefix), `from` / `to`; newest first; secret-looking fields always `[REDACTED]` |
| `GET /admin/tenants/:id/projects` · `/team` · `/activity` | Read-only look into one company: projects with client and money; users and phones; activity of the last 30 days and money now. Each look is audited (`admin.company_data_viewed`, once per admin and section every 10 minutes) |

### Working inside a company (Company data)

The super admin can view, add, edit and delete anything in any company — through the **company's own API**, so every rule, calculation and delete check is the same as for the owner. The admin console sends the admin's own token plus `X-Act-As-Tenant: <companyId>` to the normal company routes (`src/modules/auth/actAs.ts`, `authenticate`):

- The admin token must be a live platform session (logout ends it at once); a company token with the header is refused (401). Unknown company → 404, a malformed id → 400.
- The request runs as the company's hidden **"Super Admin (Platform)"** user (`User.isSystem`, role THEKEDAR, every permission), created the first time. It is `INACTIVE` so it can never sign in, and it is kept out of the team list, plan seat counts, owner SMS and notifications.
- `writeAudit` records such changes with `actorType PLATFORM_ADMIN`, `actorId` = the real admin and `details.actingAsCompany = true`.
- Suspended, closed and read-only companies stay open to the admin.

### Payment approval flow

1. The company uploads a slip (`PAYMENT_SLIP`) and submits `POST /subscription/payments` → `PENDING_REVIEW`.
2. The admin checks it (`GET /admin/payments/:id`: slip, expected amount, possible duplicates) and approves or rejects.
3. **Approve** (one transaction, under the same per-company lock as the company's subscription routes):
   - period = 30 days from **today** for TRIAL / GRACE / LAPSED, or from the **current period end** for ACTIVE;
   - the subscription moves to the paid plan (a matching pending change is cleared; a cheaper plan must fit, extra projects become READ_ONLY);
   - receipt number, subscription `ACTIVE`, company `ACTIVE` (cache invalidated — a lapsed company can write immediately);
   - SMS: *"Payment approve ho gayi. Starter 4 Nov 2026 tak active."*
4. Approving or rejecting a processed payment → `409 ALREADY_PROCESSED`.

**Receipt numbers** — `RCPT-YYYY-NNNN`, one sequence per year (Pakistan time). The next number is `max(existing for the year) + 1`, taken inside the approving transaction under a global advisory lock: sequential, gap-free (a rolled-back approval releases its number) and never shared by parallel approvals. The seed ends at `RCPT-2026-0381`, so the first approval is `RCPT-2026-0382`.

## Master Data

`src/modules/master-data` (company side) + the material catalog in `src/modules/platform-admin`.

### Data model

| Table | Level | What |
|---|---|---|
| `MaterialGroup` | platform | 12 fixed groups (CEMENT … PAINT), section CIVIL / FINISHING |
| `PlatformMaterial` | platform | The shared catalog (~40 seeded): unit, `unitDetail` ("1 bag = 50 kg"), `altUnits` [{unit, factor}], supply category, `usedByRulebook` / `rulebookKey` (cement, bricks, steel, sand, bajri) |
| `Material` | tenant | The company's copy (`source PLATFORM`) or its own (`source COMPANY`); `isHidden`, `isCustomised`; name unique per company |
| `QualityCategory` | tenant | A+ Premium / A Standard (default) / B Economy to start; exactly one default |
| `MaterialRate` | tenant | **Append-only** rate history per material × category. Current rate = latest `effectiveFrom ≤ now()` |
| `LaborRate` | tenant | DAILY wages (per DAY, overtime ×) and SUBCONTRACT piece rates, unique per kind + key |
| `PaymentScheduleTemplate` | tenant | Stages `[{label, percent, isRetention?}]` adding up to 100 %; exactly one default |
| `Supplier` / `SupplierRate` | tenant | Suppliers (mobile or landline) and their agreed-rate history |
| `Worker` / `Subcontractor` | tenant | Daily-wage workers (phone unique per company) and piece-rate teams by trade |

Platform tables: `app_user` has SELECT only. Tenant tables: RLS ENABLE + FORCE, `tenant_isolation` policy, composite `(tenantId, id)` FKs.

**Starter data (copy-on-create).** `provisionMasterData(tx, tenantId)` (`master-data/provision.ts`) copies every active catalog material, the 3 quality categories, the 14 default labour rates and the "Residential standard" template. It runs in the sign-up and admin create-company transactions and is idempotent; `npm run backfill:master-data` runs it for every existing company.

**Rates are never shown to MUNSHI.** `/materials` never carries a rate; rates only come from `/price-list` (`rates.view`) and `/suppliers/:id/rates`. New rate rows take `effectiveFrom` from the database clock, so app/DB clock drift can't hide a fresh rate.

### Endpoints

| Endpoint | Who | Notes |
|---|---|---|
| `GET /material-groups` | all | Groups with section + sortOrder |
| `GET /materials` | all | `groupId`, `search`, `supplyCategory`, `includeHidden` (THEKEDAR / PM; ignored for MUNSHI) |
| `POST /materials` | THEKEDAR, PM | Company material; `409 MATERIAL_EXISTS` |
| `PATCH /materials/:id` | THEKEDAR, PM | Sets `isCustomised`; unit of a catalog material or of a material with rates → `400 UNIT_LOCKED` |
| `POST /materials/:id/hide` · `/show` | THEKEDAR | |
| `DELETE /materials/:id` | THEKEDAR | Company material without rates only, else `409 MATERIAL_IN_USE` |
| `GET /quality-categories` | THEKEDAR, PM | `includeArchived`; `ratedMaterials` count |
| `POST /quality-categories` | THEKEDAR | name, code (2–10 uppercase), `copyRatesFromCategoryId?` |
| `PATCH /quality-categories/:id` | THEKEDAR | name, description, sortOrder, `isDefault: true` (clears the old default) |
| `POST /quality-categories/:id/duplicate` · `/archive` | THEKEDAR | Duplicate copies current rates; archive: not the default (`CATEGORY_IS_DEFAULT`), not the last active (`LAST_ACTIVE_CATEGORY`) |
| `GET /price-list` | THEKEDAR, PM | `categoryId` (default category), `groupId`, `search`; rate, specification, last updated at/by; hidden excluded |
| `PUT /price-list` | THEKEDAR | 1–500 rates; history row only when rate or specification changed → `{ changed, unchanged }` |
| `POST /price-list/bulk-percent` | THEKEDAR | −50 … +100 %, whole category / `groupId` / `materialIds`; rounded to the nearest rupee |
| `GET /price-list/history` | THEKEDAR, PM | `materialId`, `categoryId?`; newest first with `changedBy` |
| `GET /labor-rates` · `PUT` | all · THEKEDAR | Upsert by kind + key; keys must match the kind (`INVALID_LABOR_KEY`), DAILY is per DAY |
| `GET /payment-templates` · `POST` · `PATCH /:id` · `DELETE /:id` | THEKEDAR, PM · THEKEDAR | 1–15 stages, total exactly 100 (`400 PERCENT_TOTAL_INVALID { total }`), one retention stage max, default can't be deleted |
| `GET /suppliers` · `GET /:id` | THEKEDAR, PM | search (name / city / phone), category, isActive, page; detail has current agreed rates |
| `POST /suppliers` · `PATCH /:id` | THEKEDAR, PM | `409 SUPPLIER_EXISTS`; landline allowed |
| `POST /suppliers/:id/deactivate` · `/activate` · `PUT /:id/rates` | THEKEDAR | Rate history row only when changed; `GET /:id/rates` (THEKEDAR, PM) = current + history |
| `GET /workers` · `POST` | all · THEKEDAR, PM, MUNSHI | `dailyRatePaisa` defaults from the DAILY labour rate of the type (OTHER → `DAILY_RATE_REQUIRED`); `409 WORKER_PHONE_TAKEN` |
| `PATCH /workers/:id` · `/deactivate` · `/activate` | THEKEDAR, PM | |
| `GET /subcontractors` · `POST` · `PATCH /:id` · `/deactivate` · `/activate` | all · THEKEDAR, PM | trade = a SUBCONTRACT key; `409 SUBCONTRACTOR_EXISTS` |

**Platform catalog** (`/api/v1/admin`): `GET /material-groups`, `GET /materials` (`groupId`, `search`, `supplyCategory`, `isActive`; `companies` = copies), `POST /materials` (`pushToTenants` default true → copied into every company; a company with a material of the same name keeps its own; `409 PLATFORM_MATERIAL_EXISTS`), `PATCH /materials/:id` (name / unitDetail / altUnits propagate only to copies with `isCustomised = false` whose company has no other material with the new name; unit is immutable).

Audit actions: `material.*`, `quality_category.*`, `price_list.update`, `price_list.bulk_percent`, `labor_rates.update`, `payment_template.*`, `supplier.*`, `supplier.rates_update`, `worker.*`, `subcontractor.*`, `admin.catalog_material_created` / `_updated`.

**Seed (Malik & Sons).** Rates A+ / A / B with specifications: cement 1,550 / 1,450 / 1,350 (plus an older A rate 1,400), bricks 19 / 17 / 14, steel #4 2,95,000 / 2,85,000 / 2,70,000, Chenab sand 85 / 70 / 60, bajri 190 / 180 / 165, floor tiles 450 / 220 / 140, PPR 1" 420 / 320 / 250, wire 7/29 14,500 / 11,800 / 9,500. Templates Residential standard (default), Labor-only monthly, Commercial. Suppliers Al-Madina Cement Agency (cement 1,430), Ittefaq Steel Traders, Chaudhry Bricks Kiln, Bilal Traders, Punjab Shuttering Yard. 14 workers (Pervaiz inactive) and 6 sub-contractors. Other companies get only the copied defaults.

## Projects

`src/modules/clients` (project owners) and `src/modules/projects` (`/projects`, `/supply-presets`, `/floors`, `/rooms`, `/openings`).

### Access rules

| Role | Projects | Can do |
|---|---|---|
| THEKEDAR | all | everything |
| PM | assigned (`UserProjectAccess`) | create (the creator is auto-assigned), edit assigned projects, review, activate; not delete, team or status |
| MUNSHI | assigned | read only — basic fields (id, code, name, status, client name, site, dates, team) and floors/rooms |

- A project outside the caller's reach is **404** (never 403), so its existence isn't leaked. Floors, rooms and openings inherit this (`FLOOR_NOT_FOUND` …).
- Financial fields (`contractValuePaisa`, `ratePerSqftPaisa`, `contractTotalPaisa`, stage `amountPaisa`) are **omitted** — not null — without `billing.view` (THEKEDAR, or a PM with `canSeeFinancials`).
- Clients (`/clients`, THEKEDAR + PM): list with `projectsCount`, detail with projects (both limited to what the caller can see), create / edit; phone (mobile or landline) unique per company → `409 CLIENT_PHONE_TAKEN`.

### Statuses and transitions

```
DRAFT ──/activate──▶ ACTIVE ──▶ CLOSEOUT ──▶ HANDED_OVER ──▶ CLOSED
                       ▲            │
                       └── reopen ──┘          READ_ONLY ← subscription job only
```

- `POST /projects` creates a **DRAFT** (free — not counted against the plan). `DELETE` works only on drafts (`409 PROJECT_NOT_DRAFT`).
- `POST /projects/:id/activate` (THEKEDAR, PM): DRAFT only, the review must have no errors (`400 PROJECT_NOT_READY` with `details.errors`), plan limit (`402`). Response has `nextStep: "ESTIMATE"` (Phase 2).
- `PATCH /projects/:id/status` (THEKEDAR): only the arrows above (`409 INVALID_STATUS_TRANSITION`); reopening re-checks the plan limit.
- **Plan limit:** `activeProjects` counts ACTIVE + CLOSEOUT (`PLAN_COUNTED_PROJECT_STATUSES` in `planLimits.ts`, also used by downgrade parking and the admin usage view).
- Wizard sections, rooms and openings can change only while **DRAFT or ACTIVE**; otherwise `409 PROJECT_LOCKED` (team: also CLOSEOUT).

### Wizard

| Tab | Endpoint | Notes |
|---|---|---|
| 1 Basic | `POST /projects`, `PATCH /:id/basic` | name, code (auto `<initials>-<year>-NNN` e.g. `MSB-2026-017`, editable, unique → `PROJECT_CODE_TAKEN`), `clientId` **or** `newClient`, site, city, dates (end ≥ start), optional `pmId` / `munshiId`. Defaults: marla standard from company settings, retention 5 %, defect period 6 months. |
| Team | `PUT /:id/team` | THEKEDAR. `pmId` (null removes), `munshiIds` ([] removes); omitted = unchanged; users must be active with that role. |
| 2 Contract | `PATCH /:id/contract` | FULL / GREY_OWNER_FINISHING need `contractValuePaisa`, LABOR_ONLY needs `ratePerSqftPaisa`; retention 0–10 %, defect 0–24 months. **Supply rules** start from the contract-type preset (`GET /supply-presets`: FULL all contractor; GREY → cement, bricks, steel, sand & bajri, pipes by contractor; LABOR_ONLY all owner) with the default quality category on contractor rows; `supplyRules` override categories (CONTRACTOR needs `qualityCategoryId`, OWNER must not have one); rows with `lockedAt` → `409 SUPPLY_RULE_LOCKED`. **Billing stages** from `billingStages`, `templateId`, or the company default template on first save; exactly 100 % (`PERCENT_TOTAL_INVALID {total}`), one retention max. |
| 3 Plot & structure | `PATCH /:id/plot-structure` | MARLA / KANAL / SQFT, marla standard 225 / 272.25, front × depth, corner, FRAMED / LOAD_BEARING, basement (+height). Floors upserted by level (GROUND required, BASEMENT only with a basement); dropping a floor with rooms → `409 FLOOR_HAS_ROOMS` unless `force: true`. |
| 4 Coverage | `PATCH /:id/coverage` | covered (> 0), semi-covered, open; boundary length / height / thickness (4.5″ / 9″) / plaster sides required with a boundary wall. |
| 5 Rooms | `POST /floors/:id/rooms`, `PATCH·DELETE /rooms/:id`, `POST /rooms/:id/openings`, `PATCH·DELETE /openings/:id`, `POST /floors/:id/copy`, `GET /projects/:id/floors` | Height defaults to the floor ceiling; name defaults to the type ("Bedroom 2"); bath / powder room / kitchen are wet unless overridden (`isWet`, `null` = automatic). Openings larger than the walls → `400 OPENINGS_EXCEED_WALL`. Copy takes the target's ceiling height; non-empty target needs `replace: true` (`409 FLOOR_NOT_EMPTY`). |
| 6 Review | `GET /:id/review` | `{ ready, errors[], warnings[], summary }`. Errors: missing tab fields, stages ≠ 100 %, no GROUND floor, no rooms, contract value / rate missing. Warnings: plot vs front × depth > 10 %, room area vs covered > 15 % ("walls and passages"), no PM, no Munshi, end < 3 months after start. |

Each wizard PATCH validates its section, saves, adds the tab to `wizardCompletedSteps` and returns the full project.

### Calculations (`projects/calc.ts`, Decimal-safe, 2 dp)

- **Plot:** marla × standard; kanal = 20 marla; frontage = front × depth; `plotAreaMismatch` when they differ by > 10 %.
- **Room:** floor = L × W; gross wall = 2 × (L + W) × H; openings = Σ w × h × qty; net wall = gross − openings. (16 × 14 × 11 with a 3.5 × 7 door and a 5 × 4 window → 224 / 660 / 44.5 / 615.5.)
- **Floor / project totals:** rooms, total floor area, net wall area, wet rooms.
- **Billing amounts:** contract value × % (labour-only: rate × covered area), each rounded to the rupee, last stage absorbs the rounding; recomputed when the contract or covered area changes.

Audit actions: `client.create`, `client.update`, `project.create`, `project.delete`, `project.update_basic`, `project.team_update`, `project.update_contract`, `project.update_plot_structure`, `project.update_coverage`, `project.room_*`, `project.opening_*`, `project.floor_copy`, `project.activate`, `project.status_change`.

**Seed.** Malik & Sons: 6 clients; DHA Phase 6 · 10 Marla (`MSB-2026-012`, ACTIVE, grey structure, Rs 1,85,00,000, full wizard with 17 rooms on Ground / First / Mumty, PM Bilal, Munshi Rafaqat), Johar Town · 5 Marla (`MSB-2026-008`, ACTIVE, PM Bilal), Bahria Town · 1 Kanal (`MSB-2026-014`, ACTIVE, basement, Munshi **Asif Mehmood** `03224567890` OTP), Valencia · 7 Marla (`MSB-2025-031`, HANDED_OVER, labour-only Rs 450/sq ft) and a DRAFT Model Town · 1 Kanal (tabs 1–2). Ahmed Constructions: Wapda Town · 5 Marla (`AC-2026-001`, ACTIVE). Older seed rows are renamed in place, so foreign keys survive.

## Procurement & Inventory

`src/modules/inventory` (locations, stock ledger, costing, usage, counts), `src/modules/procurement` (purchase orders, purchases, returns, corrections, supplier ledger + payments) and `src/modules/dispatch` (dispatches, receiving, shortages, owner deliveries).

### Stock ledger

- **Locations** (`StockLocation`): every company has one **Central Store** (`systemKey CENTRAL_STORE`) and one **In transit** location; every non-draft project has a **SITE** location (created on activation, or on first use). The migration backfilled existing companies and projects.
- **All stock changes are one append-only `StockMovement` row** (`PURCHASE_IN`, `PURCHASE_RETURN_OUT`, `DISPATCH_OUT`, `TRANSIT_IN`, `TRANSIT_OUT`, `RECEIPT_IN`, `OWNER_DELIVERY_IN`, `USAGE_OUT`, `COUNT_ADJUSTMENT`, `CORRECTION`). Balances are `SUM(quantity)` / `SUM(valuePaisa)` — never stored. app_user has **SELECT + INSERT only** on `StockMovement` and `SupplierLedgerEntry`.
- **Costing:** weighted average per (location, material, `ownerSupplied = false`). Stock in carries its own cost; stock out leaves at the current average (taking the last unit takes exactly the remaining value — no rounding residue). 200 @ 1,500 + 400 @ 1,430 → 1,453.33. Owner-supplied stock is a separate bucket at cost 0.
- Stock-out operations take a per-location advisory lock (`lockLocations`) and check availability first → `400 INSUFFICIENT_STOCK { materialId, available, items[] }`.
- Quantities are `Decimal(14,3)` (API: number or numeric string, ≤ 3 dp); money BigInt paisa.
- **Numbers** from `TenantCounter` via `nextNumber(tx, tenantId, format)` (gap-free inside the transaction): `PUR-2026-0001` (yearly), `GP-0001`, `PRN-0001`, `PO-0001`, `SC-0001`.
- **Who sees money:** rates, amounts, values and supplier balances need `rates.view` (THEKEDAR, PM); for MUNSHI the fields are omitted. Project-scoped endpoints use the project access rules (outside → 404).

### Purchases

| Who / where | Flow |
|---|---|
| THEKEDAR / PM → **STORE** | Counted on arrival → `SAVED`, `PURCHASE_IN` at the rate |
| THEKEDAR / PM → **SITE** | `PENDING_RECEIPT` → appears in the site's Incoming; stock moves when the site counts it (`POST /purchases/:id/receive`) |
| MUNSHI → **SITE** only | No rates / payment (`400 RATES_NOT_ALLOWED`); counted now, stock in at cost 0 → `PENDING_RATE` until the office sends `PATCH /purchases/:id/rates` (bill + payment posted, stock value added) |

- Rates default from the purchase order, then the supplier's agreed rate (`400 RATE_REQUIRED`). The challan photo is required (kind `CHALLAN`).
- **Money:** the supplier's bill (`totalPaisa`, ledger debit) = Σ challan qty × rate; each line's `amountPaisa` = good qty (counted − damaged) × rate. Good < challan needs an item note (`400 SHORTAGE_NOTE_REQUIRED`) and creates `SUPPLIER_SHORT` / `DAMAGED` shortages.
- **Payment:** UDHAAR → ledger debit; CASH → debit + payment; PARTIAL → debit + payment (0 < paid < bill, `400 INVALID_PAID_AMOUNT`). `paidFrom: SITE_CASH` calls the documented hook `postCashPurchaseFromSiteCash()` for the Step 7 cash book.
- **Locked:** saved purchases never change. `POST /purchases/:id/corrections` (THEKEDAR, `{ reason, items: [{ purchaseItemId, qty?, ratePaisa? }] }`) writes a visible `PurchaseCorrection`, a `CORRECTION` movement and a ledger `ADJUSTMENT`; the original lines stay. `POST /purchases/:id/returns` → `PRN-…`, `PURCHASE_RETURN_OUT` at the purchase rate + supplier credit (`400 RETURN_EXCEEDS_STOCK` / `RETURN_EXCEEDS_PURCHASE`).
- **Purchase orders** (`/purchase-orders`, THEKEDAR + PM): status follows the linked purchases OPEN → PARTLY_RECEIVED → RECEIVED; edit only while OPEN; cancel only OPEN without purchases (`409 PURCHASE_ORDER_HAS_RECEIPTS`).

### Supplier ledger

`SupplierLedgerEntry` (OPENING / PURCHASE / RETURN / PAYMENT / PAYMENT_REVERSAL / ADJUSTMENT), signed (+ we owe more). `GET /suppliers` and `GET /suppliers/:id` add `udhaarBalancePaisa` + `oldestUnpaidDays` (FIFO: payments settle the oldest debits first) for rates.view. `GET /suppliers/:id/ledger` — running balance, filters project / dates. `POST /supplier-payments` (THEKEDAR; cheques start PENDING), `PATCH /supplier-payments/:id/cheque-status` (BOUNCED → `PAYMENT_REVERSAL`), `GET /supplier-payments`.

### Dispatch, receiving, shortages

- `POST /dispatches` (THEKEDAR from the store or any site; PM only from a site they manage, to the store or another of their sites): `DISPATCH_OUT` at average cost + `TRANSIT_IN` (same value), SMS to the destination PM / munshis: *"GP-0142: 200 bags cement aur 5,000 eent aap ki site par aa rahe hain (LES-4521)."* `POST /dispatches/:id/cancel` (ON_THE_WAY only) reverses it.
- **Blind count** (`TenantSettings.blindCountEnabled`, default true, `PATCH /company/settings`): `GET /projects/:id/incoming` leaves out `sentQty` / `challanQty`; MUNSHI never sees them on a pending dispatch / purchase.
- `POST /dispatches/:id/receive` (THEKEDAR / PM / MUNSHI with access): every item counted (`ITEMS_MISMATCH`), note when good < sent, `TRANSIT_OUT` (sent) + `RECEIPT_IN` (good at dispatch cost); differences → `DISPATCH_SHORT` / `DAMAGED` / `EXCESS` shortages with value; status RECEIVED / RECEIVED_WITH_SHORTAGE / RECEIVED_WITH_EXCESS; the response reveals sent vs counted vs difference; second receive → `409 ALREADY_RECEIVED`.
- `GET /shortages` (THEKEDAR; PM read-only for their projects; `meta.openCount` / `openValuePaisa`), `POST /shortages/:id/resolve` (THEKEDAR, note required): SEND_REMAINING (new dispatch, stock checked) · RETURN_TO_STORE (back to the source; EXCESS back from the site) · ACCEPT_LOSS · RECOVER_FROM_DRIVER (amount required) · SUPPLIER_CREDIT (purchase shortages → ledger credit). Each shortage lists its `allowedResolutions`; resolved → `409 SHORTAGE_RESOLVED`.
- `POST/GET /projects/:id/owner-deliveries`: only materials in a category the owner supplies on the project (`400 NOT_OWNER_SUPPLIED`; material group → supply category, e.g. AGGREGATES → SAND_BAJRI, PLUMBING → PIPES, FLOORING → TILES_FLOORING) → `OWNER_DELIVERY_IN` at cost 0.

### Stock views, usage, counts

- `GET /stock-locations` (scoped), `GET /stores/:locationId/stock` (THEKEDAR + PM: in store, in transit, average rate, value, last purchase, low-stock; summary value / low-stock count / dispatches on the way), `PUT /stores/:locationId/low-stock-levels` (THEKEDAR, `[{ materialId, minQty }]`, 0 removes), `GET /stock/movements` (ledger with filters), `GET /projects/:id/stock` (received contractor / owner, used, transferred out, adjustments, in stock, last count; values only with rates.view).
- `POST/GET /projects/:id/material-usage` (all roles with access; ≤ site balance → else `400 INSUFFICIENT_STOCK`; `USAGE_OUT` at average cost, owner bucket at 0; `ownerSupplied` defaults from the supply rules).
- `POST/GET /stock-counts` (sites: THEKEDAR / PM / MUNSHI with access; store: THEKEDAR only): the server takes the system quantity; a non-zero difference needs a reason (`HARDENED_IN_RAIN`, `BREAKAGE`, `THEFT_SUSPECTED`, `MEASUREMENT`, `OTHER` → `400 REASON_REQUIRED`) and becomes a `COUNT_ADJUSTMENT` (a surplus at the current average).

Audit actions: `stock.low_levels_update`, `stock.usage_record`, `stock.count`, `stock.owner_delivery`, `purchase_order.create|update|cancel`, `purchase.create|rates_set|receive|correct|return`, `supplier_payment.create|cheque_cleared|cheque_bounced`, `dispatch.create|cancel|receive`, `shortage.resolve`.

**Seed (`prisma/seedInventory.ts`, Malik & Sons, skipped when purchases exist; tests seed it on demand).** Store: CH-2198 200 cement @ 1,500 (15 Sep, cash), CB-1150 17,000 bricks @ 17 (Chaudhry, udhaar), store count SC-0001 on 28 Sep (cement −4 hardened in rain, bricks −50 breakage), CH-2231 400 cement @ 1,430 (Al-Madina, udhaar, 2 Oct → average ≈ 1,453), IT-8812 2 ton steel #4 @ 2,85,000 (part paid Rs 2,00,000). Direct to site: BT-451 400 cft Chenab sand @ 70 → DHA (cash, RECEIVED), CB-1190 10,000 bricks → Bahria (PENDING_RECEIPT). Gate passes: GP-0140 Johar 80 cement (RECEIVED), GP-0141 (cancelled), GP-0142 DHA 200 cement + 5,000 bricks, LES-4521, driver Nadeem 0300-1112233 (RECEIVED_WITH_SHORTAGE: cement 190, 200 bricks damaged → two OPEN shortages), GP-0143 Bahria 1 ton steel (ON_THE_WAY), GP-0144 DHA 100 cement (ON_THE_WAY). Supplier balances: Al-Madina 7,40,000 · Ittefaq 12,10,000 (with a bounced Rs 1,50,000 cheque) · Chaudhry 3,25,000 · Bilal Traders 1,15,000 · Punjab Shuttering 86,000 (OPENING entries as needed). DHA usage on the last three days. Store low-stock levels: cement 200, sand 500, PPR 100.

## Labor & Cash Book

`src/modules/labor` (team on site, hazri, work measurements, peshgi, weekly settlements, sub-contractor accounts) and `src/modules/cashbook` (cash accounts, floats, kharcha, top-ups, counts, handovers). Every new table has RLS, grants and composite FKs; money is BigInt paisa, quantities Decimal; every write is audited. `SubcontractLedgerEntry` is append-only (app_user SELECT + INSERT); `CashEntry` rows are never deleted (UPDATE only for status / acknowledgement / approval).

### Access

| | THEKEDAR | PM | MUNSHI |
|---|---|---|---|
| Projects | all | assigned | assigned |
| Hazri, measurements, peshgi, generate / submit settlement | ✓ | ✓ | ✓ (hazri ≤ 7 days back; peshgi and wages from **site cash only**) |
| Rates on assignment | set / override | set / override | default rate only (`403 RATE_CHANGE_NOT_ALLOWED`) |
| Approve / return settlements, verify measurements, approve kharcha | ✓ | assigned projects (not their own kharcha) | — |
| Sub-contract money (rates, contract value, accounts, payments) | ✓ | ✓ (payments only when `subcontractPaymentsByPm`) | never shown |
| Deductions, floats, top-up decisions | ✓ | — | — |
| Cash accounts | all | own + munshis on their projects | own only |

A project / record outside the caller's reach is 404.

### Rules

- **Settings** (`GET/PATCH /company/settings`): `settlementWeekStart` (MONDAY), `workingDays` (MON–SAT), `hoursPerDay` (8), `overtimeMultiplier` (null → the DAILY labour rate's, ×1.5), `subcontractPaymentsByPm` (false). `kharchaApprovalLimitPaisa` (Step 2) is the kharcha limit.
- **Offline**: hazri, measurements, peshgi, kharcha and top-up requests accept `clientId` (UUID v7) + `deviceCreatedAt`; sending the same `clientId` again returns the saved record with **200** (201 the first time). Hazri is an upsert per (project, worker, date).
- **Hazri**: worker must be on the project (`400 WORKER_NOT_ASSIGNED`; a worker taken off can still be back-filled up to their end date), no future days (`FUTURE_DATE`), MUNSHI ≤ 7 days back (`DATE_TOO_OLD`), a week with a SUBMITTED / APPROVED settlement is locked (`409 WEEK_LOCKED`).
- **Settlement maths**: daysWorked = full + ½ × half · OT pay = OT hours × rate / hoursPerDay × multiplier · gross = days × rate + OT · peshgi = outstanding worker advances dated ≤ week end, **oldest first**, up to gross (an office override with a note is kept on regenerate) · net = gross − peshgi. Generate regenerates DRAFT / RETURNED; SUBMITTED / APPROVED → `409 SETTLEMENT_LOCKED`. Approve locks the week and the peshgi it cut; return (comment) unlocks while nothing is paid (`409 SETTLEMENT_PAID`). Pay: APPROVED only; SITE_CASH posts one `WAGE_PAYMENT` per line.
- **Advances**: status OUTSTANDING → PARTLY_ADJUSTED → ADJUSTED (cut in an **approved** settlement). A sub-contractor advance posts `ADVANCE` to their ledger at once (status ADJUSTED). SITE_CASH posts `PESHGI` (`400 INSUFFICIENT_CASH`).
- **Sub-contractor account**: value = Σ WORK_VALUE (+ ADJUSTMENT) · retention = value × r% · held = retention − released · paid = advances + running payments · balanceDue = value − retention − paid − deductions (< 0 → `overpaid`). A verified measurement adds qty × rate; LUMPSUM uses cumulative `% progress`. Payments: RUNNING / FINAL ≤ balance due unless `allowAdvance` (`EXCEEDS_BALANCE`); FINAL closes the sub-contract; RETENTION_RELEASE ≤ held (`EXCEEDS_RETENTION`). Deductions (THEKEDAR) and shortage losses (`POST /shortages/:id/resolve` with `ACCEPT_LOSS` + `chargeToAssignmentId`) post `DEDUCTION`.
- **Cash book** (`cashbook/cash.ts`): one active `CashAccount` per holder (partial unique index), opened on the first float. Balance = Σ entries except `PENDING_ACK` floats; running balance follows posting order. Kharcha above the limit is `PENDING_APPROVAL` but already out of the cash; rejected kharcha stays out and is **recoverable from the holder**. Cost bucket follows the category (OWNER_PURCHASE → RECOVERABLE_FROM_OWNER). URGENT_MATERIAL with `supplierId` + `items` also creates a site purchase (PENDING_RATE, counted now); when the office sets its rates the purchase is paid from SITE_CASH by that kharcha (no second cash entry). The Step 6 hook `postCashPurchaseFromSiteCash` now posts a `PURCHASE` entry for purchases paid from site cash (skipped when a kharcha already covers it). A count with a difference needs a note → `COUNT_ADJUSTMENT`. Handover = `HANDOVER_OUT` + `HANDOVER_IN`. Deactivating a user who still holds cash → `409 CASH_BALANCE_OPEN` (`details.accountId`).
- **Suppliers list for MUNSHI**: `GET /suppliers` is now open to all roles so a munshi can pick who sold urgent material (udhaar balances still need rates.view; supplier detail, rates and ledger stay office-only).

### Endpoints

| Area | Endpoints |
|---|---|
| Team on site | `GET/POST /projects/:id/labor/workers`, `PATCH/DELETE /project-workers/:id`, `GET/POST /projects/:id/labor/subcontracts`, `PATCH /subcontract-assignments/:id` |
| Hazri | `POST /projects/:id/attendance` (bulk), `GET /projects/:id/attendance?from&to` (grid + totals), `GET /projects/:id/attendance/today` |
| Measurements | `POST/GET /projects/:id/work-measurements`, `POST /work-measurements/:id/verify`, `POST /work-measurements/:id/reject` (note) |
| Peshgi | `POST/GET /projects/:id/advances` |
| Settlements | `POST /projects/:id/settlements/generate {weekStart}`, `GET /projects/:id/settlements`, `GET /settlements` (office, e.g. `?status=SUBMITTED`), `GET /settlements/:id`, `PATCH /settlements/:id/lines/:lineId`, `POST /settlements/:id/submit\|approve\|return\|pay` |
| Sub-contract accounts | `GET /projects/:id/subcontract-accounts`, `GET /subcontract-assignments/:id/ledger`, `POST /subcontract-assignments/:id/progress\|payments\|deductions` |
| Office overview | `GET /labor/overview` (dashboard: hazri today, peshgi / kharcha this week, cash with site staff, approvals waiting), `GET /workers/:id/labor-summary`, `GET /subcontractors/:id/labor-summary` (THEKEDAR, PM — their projects) |
| Cash book | `GET /cash-accounts`, `GET /cash-accounts/:id`, `GET /cash-accounts/:id/entries`, `POST /cash-floats`, `POST /cash-floats/:entryId/acknowledge`, `GET/POST /cash-expenses`, `POST /cash-expenses/:id/approve\|reject`, `GET/POST /topup-requests`, `POST /topup-requests/:id/approve\|reject`, `GET/POST /cash-counts`, `POST /cash-handovers`, `GET /projects/:id/cashbook` |

Audit actions: `labor.worker_assigned|worker_reassigned|worker_updated|worker_removed|subcontract_assigned|subcontract_updated`, `attendance.mark`, `measurement.record|verify|reject`, `advance.create`, `settlement.generate|regenerate|line_adjust|submit|approve|return|pay`, `subcontract.progress|payment|deduction`, `cash.float_sent|float_acknowledged|expense|expense_approved|expense_rejected|topup_requested|topup_approved|topup_rejected|count|handover`.

**Seed (`prisma/seedLabor.ts`, Malik & Sons, one transaction, skipped when workers are already on a project; tests seed it on demand).** DHA team: Akram 2,800 · Nadeem 2,800 · Shahid / Jameel / Riaz / Arif 1,600 · Saleem 1,800 · Ghulam Rasool 1,200. Hazri for 14–19 Sep, 21–26 Sep and 28 Sep – 2 Oct. Week 14–19 Sep APPROVED + PAID (Rs 68,400, office cash). Week 21–26 Sep SUBMITTED: gross 83,600, peshgi 12,500, net 71,100 (Akram 6 d − 5,000 = 11,800 · Nadeem 5.5 d 15,400 · Shahid − 2,000 = 7,600 · Jameel 9,600 · Riaz 4 d − 1,500 = 4,900 · Arif − 3,000 = 6,600 · Saleem 5 d − 1,000 = 8,000 · Ghulam 7,200). Sub-contracts (5% retention): Sharif shuttering 45/sqft, 8,200 sqft verified (+ 650 sqft waiting), paid 3,20,000 → due 30,550 · Latif steel 9,000/ton, 14.2 ton, paid 1,45,000 → **overpaid 23,590** · Haji plumbing lump sum 1,20,000 at 40%, paid 30,000 → due 15,600 · Ali Electric 55/sqft, 1,382.5 sqft (35% of 3,950), paid 60,000. Rafaqat's cash: opening 8,400 (21 Sep) → Riaz peshgi 1,500 → count 28 Sep −100 ("Change to tea boy") → Easypaisa float 50,000 `EP88213` (1 Oct, acknowledged) → kharcha tea 1,200 · diesel 5,650 · rickshaw 2,500 · unloading 3,000 · urgent PPR fittings 4,350 · sand 28,000 (urgent, approved by Bilal when above the limit) · tile samples 2,800 (owner purchase) → **9,300**; top-up 40,000 PENDING. Asif (Bahria): float 75,000, spent 53,500 (pump rewinding 32,000 waits for approval) → **21,500**.

## Billing & Receivables

`src/modules/billing` (stages, running-bill progress, invoices, owner payments + allocations, receivables, statements, alerts) and `src/core/pdf` (HTML → PDF). New tables `BillingProgress`, `Invoice`, `InvoiceLine`, `ClientPayment`, `PaymentAllocation`, `BillingEvent` — RLS, grants, composite FKs. `PaymentAllocation` is append-only; payments are never edited or deleted.

**Access.** Every endpoint needs `billing.view`: THEKEDAR always, a PM only with financials and only on assigned projects, MUNSHI never (403; a project outside a PM's list is 404). Owner-only: issue, cancel, cheque status, manual (OTHER) invoices, stage expected date, company receivables and alerts. A PM with financials may mark stages ready, add progress and create drafts; they record payments only when `pmCanRecordPayments` is on.

**Settings** (`/company/settings`): `paymentTermsDays` (7), `taxRatePercent` (0) + `taxLabel` (used only when `taxEnabled`), `pmCanRecordPayments` (false).

### Stage flow

UPCOMING → **READY** (`POST /billing-stages/:id/mark-ready`, proof photos; returns `warning: PREVIOUS_STAGE_UNPAID` when an earlier stage's invoice is past due) → **INVOICED** (its invoice issued) → **PARTLY_PAID** → **PAID** (the stage follows its invoice). Cancelling the invoice puts the stage back to READY. A stage that is not ready can be invoiced with `force` + a note.

### Invoices

Draft types: **STAGE** (stage amount; `extraCashEntryIds` adds owner-recoverable kharcha), **RUNNING_BILL** (unbilled progress in a period × the contract rate per sq ft, less the retention %), **RECOVERABLE** (owner-recoverable kharcha from the cash book), **RETENTION** (after handover; the retention stage amount, or what running bills held back), **OTHER** (manual lines, THEKEDAR). Tax line = round(subtotal × taxRatePercent / 100) when tax is on. Issue → `INV-2026-0001`, due = issue + payment terms, the stage / progress / kharcha are locked to it, project credit is applied, the PDF is made (waited for at most 4 s; a slow or failed PDF never stops the issue — it is finished in the background or made on first download). Issued invoices never change; **cancel** (reason, no payments — else `409 INVOICE_HAS_PAYMENTS`) releases the sources.

### Allocation rules

- A payment (`RV-2026-0001`) settles the given invoices, or the **oldest due** ones first. Allocations ≤ each invoice's open amount and ≤ payment + WHT.
- What is left is **project credit**; it settles the next issued invoice automatically (oldest payment first).
- WHT (only when tax is on) counts towards the invoices.
- Invoice `paid` = cleared allocations, `pending` = allocations from cheques not cleared, `balance` = total − paid; status PAID / PARTLY_PAID / ISSUED follows.

### Cheque statuses

Cheques start **PENDING** (pending, not paid). `PATCH /payments/:id/cheque-status` → **CLEARED** (moves to paid) or **BOUNCED** (reason; its allocations stop counting so the balance comes back; CHEQUE_BOUNCED event + SMS to the owners, e.g. "MCB cheque 118845 (Rs 11,00,000) DHA Phase 6 · 10 Marla bounce ho gaya.").

### Receivables and own money

`GET /projects/:id/receivables`: contract, invoiced, received (cleared incl. WHT), pending cheques, outstanding (Σ balances), overdue + oldest days, credit, retention held, unbilled recoverables, next billable stage, and

**own money invested = spent to date − received** (negative = the owner has paid ahead).

Spent to date (`projectCost.service.ts`, reused by P&L in Step 9) = contractor material that reached the site (RECEIPT_IN + direct PURCHASE_IN − returns, owner stock at 0) + wages paid + peshgi + sub-contract payments / retention released + site kharcha (not owner-recoverable, not rejected) + losses written off (ACCEPT_LOSS). `GET /receivables` (THEKEDAR) lists every project with totals (`overdueOnly`).

### PDFs and sharing

`src/core/pdf`: Playwright chromium, A4, letterhead (logo, name, NTN, address, phone), Inter, page numbers. Templates: invoice, receipt (RV), owner statement. Stored as attachments (`INVOICE_PDF`, `RECEIPT_PDF`, `STATEMENT_PDF`). Every PDF endpoint returns `{ url, expiresAt, whatsappText, clientPhone }`. If chromium is missing → `503 PDF_UNAVAILABLE` (tests use a fake renderer). **Windows / new machine:** `npx playwright install chromium` once.

### Alerts

`BillingEvent` (one per type + reference): INVOICE_OVERDUE (daily job `billing-overdue`, 02:30 PKT, advisory-locked like the subscription job, safe to repeat), CHEQUE_BOUNCED (resolved once the invoices that cheque was for are paid or cancelled), STAGE_READY_UNBILLED (resolved when invoiced), PREVIOUS_STAGE_UNPAID. `GET /billing-events?openOnly=true` (THEKEDAR) with a link per alert.

### Endpoints

| Area | Endpoints |
|---|---|
| Stages | `GET /projects/:id/billing-stages`, `POST /billing-stages/:id/mark-ready`, `PATCH /billing-stages/:id` |
| Running bills | `GET/POST /projects/:id/billing-progress`, `PATCH/DELETE /billing-progress/:id` |
| Invoices | `GET/POST /projects/:id/invoices`, `GET/PATCH/DELETE /invoices/:id`, `POST /invoices/:id/issue`, `POST /invoices/:id/cancel`, `GET /invoices/:id/pdf` |
| Payments | `GET/POST /projects/:id/payments`, `GET /payments/:id`, `PATCH /payments/:id/cheque-status`, `GET /payments/:id/receipt-pdf` |
| Receivables | `GET /projects/:id/receivables`, `GET /receivables`, `GET /billing-events` |
| Statements | `GET /projects/:id/owner-statement`, `GET /projects/:id/owner-statement/pdf` |

Audit actions: `billing.stage_ready|stage_update|progress_add|progress_update|progress_delete`, `invoice.create|update|delete_draft|issue|cancel`, `payment.record|cheque_cleared|cheque_bounced`.

**Seed (`prisma/seedBilling.ts`, one transaction, skipped when invoices exist; tests seed it on demand).** DHA Phase 6 (1,85,00,000; 15/15/20/15/10/10/10/5): advance 27,75,000 issued 12 Mar, paid by HBL cheque 004512 (cleared); plinth 27,75,000 issued 10 Jun, Meezan IBFT FT26165 on 14 Jun; ground-floor slab 37,00,000 issued 27 Aug, due 3 Sep — MCB cheque 118830 15,00,000 cleared 2 Sep, cash 11,00,000 on 12 Sep, MCB cheque 118845 11,00,000 bounced 24 Sep ("insufficient funds") → 11,00,000 overdue; first-floor slab UPCOMING, expected 19 Nov; the tile samples (2,800, Step 7) stay unbilled. Johar Town: invoiced 88,30,000, received 79,00,000, outstanding 9,30,000 (4,50,000 overdue 21 days). Bahria Town: invoiced 1,10,40,000, received 1,02,00,000, outstanding 8,40,000 (not due). Valencia (labour-only, rate set to Rs 1,500 / sq ft on its 2,800 sq ft): four running bills, 42,00,000 gross less 5% retention → 39,90,000 billed and received, retention 2,10,000 held.

## Dashboard, Finance, Reports & Notifications

Read models over the existing modules — they never re-derive business maths: owner money from billing (`moneyOf`, `companyReceivables`), cost from the cost engine (`billing/projectCost.service.ts`), supplier dues from the FIFO supplier balances, stock from the ledger, labour from settlements / advances / sub-contract accounts, cash from the cash book. New modules: `notifications`, `approvals`, `dashboard`, `finance`, `reports`. New table `Notification` (RLS, SELECT / INSERT / UPDATE only) and `AttachmentKind.REPORT`.

**Access.** Money needs `billing.view` (P&L also `profit.view`); a PM sees only assigned projects (outside → 404); a MUNSHI gets only the site dashboard and their own notifications (403 elsewhere). Without `billing.view` the money keys are left out of the dashboard entirely.

**Cache.** Dashboard overview, cash-flow and P&L are cached in memory for 60 s per tenant + user + query; any successful POST / PUT / PATCH / DELETE of the tenant clears it (`invalidateOnWrite` on the API router). One process only (each instance has its own cache). Off in tests unless switched on. On the seed every endpoint answers in about 200 ms uncached (< 500 ms is tested).

### Cost engine

`costRows(tx, tenantId, { projectIds, from, to })` reads every cost in one SQL query, grouped by project × Karachi month × source. `projectCost()` (Step 8 receivables), `projectCosts()` (many projects) and the P&L buckets all add up the same rows:

| P&L bucket | Sources |
|---|---|
| MATERIALS | contractor material that reached the site (RECEIPT_IN + PURCHASE_IN − returns) + kharcha marked MATERIAL (urgent material) |
| LABOR_WAGES | wages paid (settlement lines) + worker peshgi + kharcha marked LABOR (unloading) |
| SUBCONTRACT | sub-contract running payments + retention released + sub-contractor advances |
| SITE_OVERHEAD | other kharcha (tea / water, transport, other) |
| EQUIPMENT | kharcha marked EQUIPMENT (fuel, repairs, small tools) |
| LOSSES | shortages written off (ACCEPT_LOSS) |

Owner-recoverable and rejected kharcha are never cost. Dates: movement / payment / entry time; wages use the paid time (or the week end); peshgi its date; losses when written off.

### Notifications

`notify(tx, { recipients, type, severity, title, body, projectId, ref, actionUrl, sms })` (`notifications.service.ts`) is called inside the module's transaction; `alerts.ts` holds every event's recipients, text and link.

- Recipients: `'THEKEDAR'`, `{ userIds }` or `{ projectRoles, projectId }` (active users only). The person who caused it is skipped unless CRITICAL.
- A MUNSHI only receives DISPATCH_CREATED, FLOAT_SENT and SETTLEMENT_RETURNED (never money); a PM without financials gets no billing or subscription notifications.
- Dedupe: the same (type, refId, user) at most once per 24 h. CRITICAL + `sms` also sends an SMS (the bounced-cheque SMS now goes through here).

| Event | Who | Severity |
|---|---|---|
| Dispatch created (to a site) | site PM + munshis | INFO |
| Shortage found on receiving (dispatch or purchase) | THEKEDAR | WARNING |
| Store stock falls below its low-stock level (dispatch) | THEKEDAR | WARNING |
| Munshi purchase waiting for rates (PENDING_RATE) | THEKEDAR + project PM | INFO |
| Settlement submitted / returned | THEKEDAR + project PM / the submitter | INFO / WARNING |
| Kharcha above the approval limit | THEKEDAR + project PM | WARNING |
| Top-up requested / float sent | THEKEDAR / the holder | INFO |
| Measurement recorded / sub-contractor becomes overpaid | project PM / THEKEDAR | INFO / WARNING |
| Invoice overdue (daily job) / stage ready but unbilled 3+ days (daily job, re-sent at most daily) / earlier stage unpaid | THEKEDAR + PM with financials | WARNING |
| Cheque bounced | THEKEDAR + PM with financials | CRITICAL + SMS |
| Plan ends in 3 / 1 days (job) / subscription payment approved / rejected | THEKEDAR | WARNING (CRITICAL at 1 day) / INFO / WARNING |
| Invitation accepted | THEKEDAR | INFO |

### My Approvals

`GET /approvals` groups everything waiting on the office: SETTLEMENT_SUBMITTED, EXPENSE_PENDING_APPROVAL, TOPUP_PENDING (owner), MEASUREMENT_TO_VERIFY, SHORTAGE_OPEN, PURCHASE_PENDING_RATE and, with `billing.view`, STAGE_READY_UNBILLED, INVOICE_DRAFT, CHEQUE_PENDING. Each item: title, project, amount (when allowed), age, `actionUrl` and the `quickActions` the caller may run (`needsNote` / `needsMethod`). `POST /approvals/bulk` runs each item through the owning service (approve / return settlements, approve / reject kharcha, send / reject top-ups, verify / reject measurements, issue drafts, clear / bounce cheques) and reports a result per item — one failure doesn't stop the rest.

### Dashboard

`GET /dashboard/overview?from&to&projectId` (default the last 30 days): KPIs (active projects + at risk = overdue invoice or own money > 10 % of contract; `delayed` 0 until the schedule exists; pending approvals; open shortages; dispatches on the way; and with `billing.view` receivables outstanding + collected %, overdue, supplier udhaar + oldest days + paid %, store stock value, cash with site staff, own money invested), project rows, site stats (hazri today by mistri / mazdoor / other, peshgi and kharcha this week, deliveries today, open shortages), labour (wages by worker type from the settlements of weeks starting in the period; sub-contractors overpaid), payments received by method (cheques cleared / pending / bounced) and alerts (latest open billing events + unread critical notifications).

`GET /dashboard/site/:projectId` (MUNSHI landing page; PM / THEKEDAR too): today's hazri, material on the way (quantities only), the caller's own cash + open top-up, to-dos (mark hazri, receive, confirm a float, submit / fix wages) and recent usage / own kharcha. No rates, values or company money.

### Finance

- `GET /finance/receivables` (THEKEDAR) — Step 8 company receivables + `ageing` (0–15 / 16–30 / 31–60 / 60+ days since the invoice was issued), per project and in total.
- `GET /finance/cash-flow?months=6` (THEKEDAR) — an **estimate**, with `assumptions[]`:
  - receipts = unpaid invoice balances by due date (overdue → this month) + stages with an expected date;
  - outflows = supplier udhaar due 30 days after each unpaid purchase (FIFO; past-due → this month) + the average weekly wages / sub-contract / kharcha of the last 8 weeks on running projects × days in the month (this month: days left);
  - new purchases, contracts and change orders are not included; own money invested starts at today's figure and goes down by each month's net.
- `GET /finance/pnl?projectId&from&to` (THEKEDAR; PM with `profit.view`, own projects) — per project revised contract, billed (live invoices before sales tax; recoverable invoices excluded — they pass the owner's purchases through), received, cost by bucket, gross profit = billed − cost, margin = gross profit ÷ billed, % billed, % cost of contract; `projectedMarginPercent: null` ("Available after the estimate engine (Phase 2)"); company totals; 12-month trend (billed by issue month vs cost by month).
- `GET /finance/cash-floats` (THEKEDAR / PM) — the Step 7 accounts + phone, active projects, total floated, spent this week, last count difference and pending top-up, with totals.

### Reports

`GET /reports/<name>?format=json|csv|xlsx|pdf&projectId&from&to` (THEKEDAR / PM; MUNSHI 403). JSON = `{ columns (key, label, type), rows, totals, notes }` for the screens (money in paisa). CSV (UTF-8 with BOM), Excel (exceljs) and PDF (the letterhead PDF service) are stored as a `REPORT` attachment and answer `{ url, expiresAt, fileName, … }` — a signed link, never the raw file; money is in rupees in files. Files are rendered outside the database transaction. Cloudinary raw files keep their extension in the public id so downloads open in the right app.

| Report | Who | What |
|---|---|---|
| `project-summary` | THEKEDAR, PM with `billing.view` | contract, billed, received, outstanding, cost by bucket, own money |
| `material-audit` | THEKEDAR, PM (value with `rates.view`) | per project × material: delivered (contractor / owner), used, sent away, count adjustments, losses, in stock, value |
| `labor-peshgi` | THEKEDAR, PM | per worker / sub-contractor: days, wages / work value, peshgi given / adjusted / outstanding, paid, retention, balance due |
| `cash-book` | THEKEDAR, PM | per holder × project: floats, kharcha by category, other payments, waiting approval, owed back, count differences, net |
| `supplier-ageing` | THEKEDAR | udhaar per supplier in 0–15 / 16–30 / 31–60 / 60+ (FIFO), oldest days, last payment |
| `receivables-ageing` | THEKEDAR | outstanding per project / client in the same buckets, overdue, pending cheques |
| `stock-valuation` | THEKEDAR | store + sites + transit: quantity × weighted-average cost (owner stock without value) |

### Endpoints

| Area | Endpoints |
|---|---|
| Notifications | `GET /notifications` (`unreadOnly`, `type`, `severity`, `projectId`, `page`, `limit`), `GET /notifications/unread-count`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` |
| Approvals | `GET /approvals`, `POST /approvals/bulk` |
| Dashboard | `GET /dashboard/overview`, `GET /dashboard/site/:projectId` |
| Finance | `GET /finance/receivables`, `GET /finance/cash-flow`, `GET /finance/pnl`, `GET /finance/cash-floats` |
| Reports | `GET /reports/project-summary`, `/material-audit`, `/labor-peshgi`, `/cash-book`, `/supplier-ageing`, `/receivables-ageing`, `/stock-valuation` |

**Seed (`prisma/seedNotifications.ts`, with the full demo only, written in the same run as the billing seed).** Replaces the notifications the demo seeds raised with a set pointing at real records, backdated: MCB cheque 118845 bounced (CRITICAL, SMS sent, unread), DHA and Johar invoices overdue (the older one read), GP-0142 shortages, Asif's Rs 32,000 water-pump kharcha waiting for approval (the only kharcha above the limit in the demo), wages 21–27 Sep submitted (Khalid read, Bilal unread), Rafaqat's Rs 40,000 top-up, Chenab sand below its store minimum (read), Latif overpaid Rs 23,590 (read), Sharif's mumty-slab measurement to verify (Bilal) and GP-0144 on the way to DHA (Rafaqat + Bilal). On a database that already has the demo, run `npm run db:seed:notifications` (replaces Malik's notifications).

## Daily Logs

`src/modules/dailylogs` — the site diary. Table `DailyLog` (RLS; SELECT / INSERT / UPDATE): project, `logDate`, `conditions[]` (NORMAL, RAIN, POWER_CUT, WATER_SHORTAGE, CURING, LABOUR_SHORT, MATERIAL_SHORT, OTHER), `workDone`, `note` (≤ 2000), `photoAttachmentIds[]` (SITE_PHOTO), `voiceAttachmentIds[]` (VOICE_NOTE), author, `clientId`, `deviceCreatedAt`; unique (project, day, author).

- `POST /projects/:id/daily-logs` (THEKEDAR / PM / MUNSHI with access): creates the log, or updates the author's log for that day — only on the same Karachi day, else `409 LOG_LOCKED`. Up to 7 days back (`DATE_TOO_OLD`), never in the future. A repeated `clientId` returns the saved log (200).
- `GET /projects/:id/daily-logs?from&to&author`, `GET /daily-logs/:id` (+ `summary`: hazri of the day, material used, kharcha — a MUNSHI sees only his own, `scope: MINE`), `PATCH /daily-logs/:id` (author, same day).
- `lateSync` = the server got it more than 48 h after `deviceCreatedAt`.
- Attachments: `POST /attachments` accepts `clientId` (a retry returns the same attachment, 200). Voice notes, and photos sent with a `clientId` (the app), must be ≤ 2 MB (the phone compresses); the web keeps 10 MB. Photos use the existing kind SITE_PHOTO (no separate PHOTO kind).
- **Missing-log job** (`src/jobs/missingLogs.ts`, every 15 min, advisory lock `missing-logs`): after `TenantSettings.missingLogAlertTime` (Karachi), every ACTIVE project with an assigned munshi and neither a log nor any hazri today → one MISSING_DAILY_LOG notification for the day to its PM(s) and the owner: "DHA Phase 6 · 10 Marla: aaj ka log nahi aaya", or, when the munshi's phone reports queued items (`Device.pendingUploads`), "…: 12 entries waiting to sync".

## Offline Sync

The Munshi app works offline: SQLite on the phone holds a read model plus an **outbox** of mutations. The server stays the source of truth.

```
 phone                                   API                                    PostgreSQL
 ─────                                   ───                                    ──────────
 1. POST /attachments (clientId) ──────▶ store file, Attachment.clientId
 2. POST /sync/push  outbox[≤100] ─────▶ for each mutation, in order:
                                          SyncIdMap(clientId)? → DUPLICATE
                                          resolve clientIds → server ids
                                          REST service (same rules) ───────────▶ rows change
                                          SyncIdMap APPLIED / REJECTED           │ triggers
 3. GET /sync/pull?cursor=N ◀──────────── SyncChange seq > N (≥ 30 s old) ◀─────┘ SyncChange
                                          → reload rows in the caller's scope
                                          → serializers (visibility) → upserts / deletes
```

**Change tracking.** `sync_track()` triggers (SECURITY DEFINER, migration owner — app_user can only read `SyncChange`, under RLS) write one row per insert / update / delete of every synced table, with `projectId` / `userId` where the row has them. Child rows (dispatch / purchase / usage / count / owner-delivery items, settlement lines) are recorded as an UPDATE of their parent; stock movements as the virtual `SiteStock` row of their location. Retention: `jobs/syncRetention.ts` (03:00 PKT) deletes changes older than 30 days and raises `SyncWatermark.prunedThroughSeq`.

**Pull** (`GET /sync/pull?cursor&limit`, default 500): no cursor = full snapshot; with a cursor = changed rows (by id) plus tombstones for deletes the caller could see; `hasMore` pages. `resetRequired: true` when the cursor is below the watermark or the caller's project access changed → wipe and pull a snapshot. A change is handed out only once it is 30 s old (longer than any transaction may run), and the cursor never passes a younger one — sequence numbers are taken at insert time but transactions commit in any order. `Device.lastSyncAt` is updated.

| Table | Scope | Never sent |
|---|---|---|
| projects | assigned ACTIVE / CLOSEOUT (owner: all running) | contract, rates, plot details |
| stock_locations, site_stock | the sites of those projects; quantities (contractor + owner) | values / costs |
| materials, material_groups, suppliers | company list; suppliers id + name | rates, supplier phone / balances |
| workers, project_workers | on those projects (+ workers the caller created) | — (daily wages are allowed) |
| subcontract_assignments | those projects | rate / contract value / retention for a MUNSHI |
| attendance (3 weeks), settlements (8 weeks, with lines), advances (90 days) | those projects | — |
| work_measurements (90 days) | those projects | values |
| dispatches, purchases (incoming + 30 days) | to those sites | unit costs, amounts; sent / challan qty for a MUNSHI while not counted (blind count) |
| owner_deliveries, material_usage, stock_counts, daily_logs (30 days) | those projects / sites | values |
| cash_accounts, cash_entries (60 days + pending), topup_requests | the caller's OWN account | anyone else's cash |
| settings, holidays, notifications (30 days, own) | company subset: blind count, kharcha limit, working days, week start, hours per day | — |

Every row goes through `sync/sync.serializers.ts` — the one place with the visibility rules (unit-tested; a test walks a munshi's whole snapshot for forbidden keys).

**Push** (`POST /sync/push`, `X-Pending-Mutations` header): mutation types WORKER_CREATE, PROJECT_WORKER_ASSIGN, ATTENDANCE_UPSERT, ADVANCE_CREATE, WORK_MEASUREMENT_CREATE, SETTLEMENT_GENERATE, SETTLEMENT_SUBMIT, SETTLEMENT_PAY, DISPATCH_RECEIVE, PURCHASE_RECEIVE, OWNER_DELIVERY_CREATE, MATERIAL_USAGE_CREATE, STOCK_COUNT_CREATE, CASH_EXPENSE_CREATE, FLOAT_ACKNOWLEDGE, TOPUP_REQUEST_CREATE, DAILY_LOG_UPSERT, SITE_PURCHASE_CREATE. Payload = the REST body plus its path ids; ids may be clientIds of earlier mutations or attachments.

| Result | When | Phone does |
|---|---|---|
| APPLIED | done (serverId) | mark sent |
| DUPLICATE | clientId seen before — nothing done again, same serverId | mark sent |
| REJECTED | permanent business error (WEEK_LOCKED, INSUFFICIENT_CASH, ALREADY_RECEIVED, INSUFFICIENT_STOCK, VALIDATION_ERROR, FORBIDDEN, …); `DEPENDENCY_REJECTED` when something it depends on was rejected | roll back the optimistic change, show under "Sync problems" |
| RETRY | transient (busy database, unexpected error, dependency not applied yet); everything after it in the batch is RETRY too | back off, send again |

Conflict rules: the server wins; each mutation goes through the same checks as REST at the time it arrives (a week locked meanwhile → REJECTED). `SyncIdMap` keeps both `deviceCreatedAt` and the server's received time for every mutation; entries received > 48 h after they were made show `lateSync`. The office screens get the same flag (`src/modules/sync/lateSync.ts`): hazri (`GET /projects/:id/attendance` cells and `/attendance/today` rows), cash entries (`lateSync` on kharcha / cash-book rows), dispatches (`GET /dispatches/:id`, set when the receipt came late) and purchases (list + detail, via the push log for PURCHASE_RECEIVE / SITE_PURCHASE_CREATE). `GET /sync/status` → per device (all devices for the owner): last sync, items waiting on the phone, last 10 rejected mutations.

**Mobile auth.** `GET /auth/mobile-config` (public): minimum / latest app version (`MOBILE_MIN_APP_VERSION`, `MOBILE_LATEST_APP_VERSION`), API version, OTP length + resend wait, sync interval, upload limit, feature flags. OTP verify with `client: "mobile"` returns tokens in the body and registers the phone (platform, model, app version); a phone the office revoked can't sign back in (`401 DEVICE_REVOKED`), pull or push — a fresh install registers as a new device. Refresh rotation detects reuse, so the app refreshes behind a mutex.

**Try it with curl** (after `npm run db:seed`, munshi Rafaqat; the OTP is printed in the API console):

```bash
curl -s localhost:4000/api/v1/auth/otp/request -H 'content-type: application/json' -d '{"phone":"+923211234567"}'
curl -s localhost:4000/api/v1/auth/otp/verify -H 'content-type: application/json' \
  -d '{"phone":"+923211234567","code":"123456","client":"mobile","device":{"deviceId":"curl-phone-0001","platform":"ANDROID","model":"curl"}}'
TOKEN=…accessToken…
curl -s localhost:4000/api/v1/sync/pull -H "authorization: Bearer $TOKEN"            # snapshot → note "cursor"
curl -s "localhost:4000/api/v1/sync/pull?cursor=1842" -H "authorization: Bearer $TOKEN"
curl -s localhost:4000/api/v1/sync/push -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'X-Pending-Mutations: 0' \
  -d '{"mutations":[{"clientId":"0199a8c0-0000-7000-8000-00000000ab01","type":"DAILY_LOG_UPSERT","payload":{"projectId":"<DHA id>","workDone":"Curing day 10","conditions":["CURING"]}}]}'
```

**Seed (`prisma/seedDailyLogs.ts`, with the labour demo).** Rafaqat's DHA logs for the last 5 days (curing day 7–10, power cut 2–5 PM, sand short) with a placeholder photo each; the day-3 entry reached the server ~2.5 days late (`lateSync`); phones: Rafaqat — Infinix Hot 30, synced 10 min ago, 0 waiting; Asif — Tecno Spark 10, last sync 2 days ago, 12 waiting.

## Error codes

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `USE_OTP_LOGIN`, `OTP_INVALID`, `CURRENT_PASSWORD_WRONG`, `FILE_REQUIRED`, `FILE_TOO_LARGE`, `INVALID_FILE_TYPE`, `INVALID_UPLOAD`, `HOLIDAY_IN_PAST`, `FINANCIALS_PM_ONLY`, `INVALID_PROJECT`, `THEKEDAR_HAS_ALL_PROJECTS`, `CANNOT_REVOKE_CURRENT_DEVICE`, `AMOUNT_MISMATCH`, `INVALID_PLAN`, `PLAN_REQUIRED`, `PAID_ON_IN_FUTURE`, `PAID_ON_TOO_OLD`, `SAME_PLAN`, `DOWNGRADE_USERS_OVER_LIMIT`, `KEEP_PROJECTS_REQUIRED`, `TOO_MANY_PROJECTS`, `INVALID_GROUP`, `UNIT_LOCKED`, `CATEGORY_ARCHIVED`, `CATEGORY_IS_DEFAULT`, `LAST_ACTIVE_CATEGORY`, `INVALID_MATERIAL`, `INVALID_LABOR_KEY`, `INVALID_LABOR_UNIT`, `PERCENT_TOTAL_INVALID`, `RETENTION_STAGE_INVALID`, `TEMPLATE_IS_DEFAULT`, `DAILY_RATE_REQUIRED`, `INVALID_CLIENT`, `INVALID_PM`, `INVALID_MUNSHI`, `INVALID_DATES`, `CONTRACT_VALUE_REQUIRED`, `RATE_REQUIRED`, `INVALID_TEMPLATE`, `QUALITY_CATEGORY_REQUIRED`, `QUALITY_CATEGORY_NOT_ALLOWED`, `INVALID_QUALITY_CATEGORY`, `OPENINGS_EXCEED_WALL`, `INVALID_TARGET_FLOOR`, `PROJECT_NOT_READY`, `INSUFFICIENT_STOCK`, `DATE_IN_FUTURE`, `REASON_REQUIRED`, `INVALID_LOCATION`, `SAME_LOCATION`, `SHORTAGE_NOTE_REQUIRED`, `DAMAGED_EXCEEDS_COUNTED`, `ITEMS_MISMATCH`, `INVALID_PAID_AMOUNT`, `CHALLAN_REQUIRED`, `INVALID_ATTACHMENT`, `RATES_NOT_ALLOWED`, `NOT_IN_PURCHASE`, `NOTHING_TO_CORRECT`, `RETURN_EXCEEDS_PURCHASE`, `RETURN_EXCEEDS_STOCK`, `PO_SUPPLIER_MISMATCH`, `SUPPLIER_INACTIVE`, `RESOLUTION_NOT_ALLOWED`, `NOT_OWNER_SUPPLIED`, `INVALID_WORKER`, `INVALID_SUBCONTRACTOR`, `WORKER_NOT_ASSIGNED`, `FUTURE_DATE`, `DATE_TOO_OLD`, `RANGE_TOO_LONG`, `INVALID_ASSIGNMENT`, `LUMPSUM_USES_PROGRESS`, `LUMPSUM_HAS_NO_RATE`, `NOT_LUMPSUM`, `PROGRESS_NOT_AHEAD`, `INVALID_WEEK_START`, `FUTURE_WEEK`, `ADVANCE_TOO_HIGH`, `EMPTY_SETTLEMENT`, `LINE_NOT_FOUND`, `EXCEEDS_BALANCE`, `EXCEEDS_RETENTION`, `NOTHING_TO_CHARGE`, `INSUFFICIENT_CASH`, `NO_CASH_ACCOUNT`, `INVALID_HOLDER`, `INVALID_RECEIVER`, `NOTE_REQUIRED`, `INVALID_END_DATE`, `NOT_RUNNING_BILLS`, `USE_RETENTION_INVOICE`, `NOTHING_TO_BILL`, `INVALID_RECOVERABLE`, `NO_RETENTION_STAGE`, `LINE_AMOUNT_REQUIRED`, `LINES_LOCKED`, `EMPTY_INVOICE`, `WHT_NOT_ENABLED`, `INVALID_ALLOCATION`, `ALLOCATION_EXCEEDS_BALANCE`, `ALLOCATION_EXCEEDS_PAYMENT`, `METHOD_REQUIRED`, `UNSUPPORTED_ACTION`, `DEVICE_MISMATCH` |
| 401 | `UNAUTHENTICATED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `SESSION_REVOKED`, `ACCOUNT_DISABLED`, `INVALID_CREDENTIALS`, `REFRESH_INVALID`, `REFRESH_TOKEN_REUSED`, `DEVICE_REVOKED` |
| 402 | `PLAN_LIMIT_REACHED` |
| 403 | `FORBIDDEN`, `COMPANY_SUSPENDED`, `ACCOUNT_READ_ONLY`, `INVALID_SIGNATURE`, `LINK_EXPIRED`, `CANNOT_CHANGE_OWN_ROLE`, `CANNOT_CHANGE_OWNER_ROLE`, `CANNOT_DEACTIVATE_SELF`, `LAST_THEKEDAR`, `RATE_CHANGE_NOT_ALLOWED`, `PAID_FROM_NOT_ALLOWED`, `OWN_EXPENSE` |
| 404 | `ROUTE_NOT_FOUND`, `NOT_FOUND`, `PHONE_NOT_REGISTERED`, `INVITE_NOT_FOUND`, `ATTACHMENT_NOT_FOUND`, `HOLIDAY_NOT_FOUND`, `USER_NOT_FOUND`, `DEVICE_NOT_FOUND`, `COMPANY_NOT_FOUND`, `SUBSCRIPTION_NOT_FOUND`, `NO_PENDING_CHANGE`, `TENANT_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `PLAN_NOT_FOUND`, `MATERIAL_NOT_FOUND`, `PLATFORM_MATERIAL_NOT_FOUND`, `CATEGORY_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `SUPPLIER_NOT_FOUND`, `WORKER_NOT_FOUND`, `SUBCONTRACTOR_NOT_FOUND`, `CLIENT_NOT_FOUND`, `PROJECT_NOT_FOUND`, `FLOOR_NOT_FOUND`, `ROOM_NOT_FOUND`, `OPENING_NOT_FOUND`, `LOCATION_NOT_FOUND`, `STORE_NOT_FOUND`, `PURCHASE_NOT_FOUND`, `PURCHASE_ORDER_NOT_FOUND`, `DISPATCH_NOT_FOUND`, `SHORTAGE_NOT_FOUND`, `PROJECT_WORKER_NOT_FOUND`, `ASSIGNMENT_NOT_FOUND`, `MEASUREMENT_NOT_FOUND`, `SETTLEMENT_NOT_FOUND`, `CASH_ACCOUNT_NOT_FOUND`, `FLOAT_NOT_FOUND`, `EXPENSE_NOT_FOUND`, `TOPUP_NOT_FOUND`, `STAGE_NOT_FOUND`, `PROGRESS_NOT_FOUND`, `INVOICE_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `NOTIFICATION_NOT_FOUND`, `DAILY_LOG_NOT_FOUND` |
| 409 | `ALREADY_EXISTS`, `PHONE_TAKEN`, `EMAIL_TAKEN`, `MULTIPLE_COMPANIES`, `INVITE_ALREADY_ACCEPTED`, `INVITE_CANCELLED`, `INVITE_PENDING`, `ALREADY_MEMBER`, `HOLIDAY_EXISTS`, `USER_ALREADY_ACTIVE`, `PAYMENT_PENDING`, `DUPLICATE_TRANSACTION`, `SLUG_TAKEN`, `PLAN_CODE_TAKEN`, `LAST_ACTIVE_PLAN`, `ALREADY_PROCESSED`, `CANNOT_EXTEND_TRIAL`, `TENANT_CLOSED`, `MATERIAL_EXISTS`, `MATERIAL_IN_USE`, `PLATFORM_MATERIAL_EXISTS`, `CATEGORY_EXISTS`, `TEMPLATE_EXISTS`, `SUPPLIER_EXISTS`, `WORKER_PHONE_TAKEN`, `SUBCONTRACTOR_EXISTS`, `CLIENT_PHONE_TAKEN`, `PROJECT_CODE_TAKEN`, `PROJECT_NOT_DRAFT`, `PROJECT_LOCKED`, `INVALID_STATUS_TRANSITION`, `SUPPLY_RULE_LOCKED`, `BILLING_STAGES_LOCKED`, `FLOOR_HAS_ROOMS`, `FLOOR_NOT_EMPTY`, `PROJECT_IS_DRAFT`, `PO_CLOSED`, `PURCHASE_ORDER_LOCKED`, `PURCHASE_ORDER_HAS_RECEIPTS`, `PURCHASE_ORDER_CANCELLED`, `RATES_ALREADY_SET`, `PURCHASE_NOT_FINAL`, `ALREADY_RECEIVED`, `DISPATCH_NOT_CANCELLABLE`, `DISPATCH_CANCELLED`, `SHORTAGE_RESOLVED`, `NOT_A_CHEQUE`, `CHEQUE_ALREADY_SETTLED`, `CASH_BALANCE_OPEN`, `WORKER_ALREADY_ASSIGNED`, `WEEK_LOCKED`, `SETTLEMENT_LOCKED`, `SETTLEMENT_NOT_SUBMITTED`, `SETTLEMENT_NOT_APPROVED`, `SETTLEMENT_PAID`, `ALREADY_PAID`, `MEASUREMENT_NOT_PENDING`, `ALREADY_ACKNOWLEDGED`, `EXPENSE_NOT_PENDING`, `TOPUP_PENDING`, `TOPUP_DECIDED`, `STAGE_NOT_READY`, `STAGE_ALREADY_INVOICED`, `SOURCE_ALREADY_BILLED`, `RETENTION_NOT_DUE`, `PROGRESS_BILLED`, `PROGRESS_ON_DRAFT`, `INVOICE_LOCKED`, `INVOICE_NOT_DRAFT`, `INVOICE_NOT_ISSUED`, `INVOICE_CANCELLED`, `INVOICE_HAS_PAYMENTS`, `LOG_LOCKED` |
| 410 | `OTP_EXPIRED`, `INVITE_EXPIRED`, `INVITE_CANCELLED` |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `RATE_LIMITED`, `OTP_RESEND_WAIT`, `OTP_LIMIT_REACHED`, `OTP_TOO_MANY_ATTEMPTS`, `INVITE_RESEND_WAIT` |
| 503 | `SERVICE_BUSY` (no database connection / transaction slot in time; `Retry-After: 1`, safe to retry), `PDF_UNAVAILABLE` (chromium missing — `npx playwright install chromium`) |

## Migrations

| Migration | What |
|---|---|
| `20261002192308_init_core_auth` | Core tenant schema, RLS policies, role grants |
| `20261003120000_company_team` | Attachment `kind` (url dropped — URLs are signed on demand), company profile fields, settings rules, holiday ranges/types, `User.deactivatedAt`, `UserStatus DISABLED → INACTIVE`, `Invitation.lastResentAt` + `(tenantId, phone, status)` index, device sync fields |
| `20261003130000_tenant_logo_fk` | Logo FK → `Attachment.id` (same-tenant enforced in the service) |
| `20261003140000_auth_indexes` | `Session(deviceId)` for device revocation, `OtpCode(phone, createdAt)` for the hourly OTP limit |
| `20261005090000_platform_admin` | `Plan.sortOrder`; PlatformHoliday `date → startDate` (renamed) + `endDate`, `type`, `updatedAt`; payment `reviewedById` (PlatformAdmin) + `reviewNote`; `JobRun` table (platform-level, no RLS; app_user has no access) |
| `20261004090000_subscription` | SubscriptionStatus `PAST_DUE → GRACE`, `EXPIRED → LAPSED`; PaymentStatus `PENDING/PAID/FAILED → PENDING_REVIEW/APPROVED/REJECTED`; `PaymentMethod` enum; `Plan.maxProjects → maxActiveProjects` + `features`; subscription period/grace/pending-change/reminder fields; payment `transactionId` (globally unique), `paidOn`, slip, `receiptNo`; `AttachmentKind.PAYMENT_SLIP`; `ProjectStatus.READ_ONLY` |
| `20261006090000_master_data` | Platform `MaterialGroup` + `PlatformMaterial` (app_user SELECT only); tenant `Material`, `QualityCategory`, `MaterialRate`, `LaborRate`, `Supplier`, `SupplierRate`, `Worker`, `Subcontractor`, `PaymentScheduleTemplate` with RLS (ENABLE + FORCE + `tenant_isolation`), grants and composite FKs. Existing companies: run `npm run backfill:master-data` once. |
| `20261007090000_clients` | `Client` (tenant, RLS, unique phone per company) |
| `20261007100000_projects` | `ProjectStatus` → DRAFT / ACTIVE / CLOSEOUT / HANDED_OVER / CLOSED / READ_ONLY (old ON_HOLD → ACTIVE, COMPLETED → HANDED_OVER, ARCHIVED → CLOSED; default DRAFT); Project wizard columns (code backfilled as `PRJ-<year>-NNN` for existing rows, then NOT NULL + unique per company); `ProjectSupplyRule`, `ProjectBillingStage`, `Floor`, `Room`, `Opening` with RLS, grants and composite FKs |
| `20261008090000_procurement_inventory` | `TenantCounter`, `StockLocation` (+ backfill: Central Store + transit per company, a site per non-draft project), append-only `StockMovement` and `SupplierLedgerEntry` (app_user SELECT + INSERT only), `LowStockLevel`, purchase orders, purchases (+ items, corrections, returns), supplier payments, dispatches (+ items), shortages, owner deliveries, material usage, stock counts — all with RLS, grants and composite FKs; `AttachmentKind.CHALLAN`; `TenantSettings.blindCountEnabled` |
| `20261009090000_labor_cashbook` | `TenantSettings` labour fields (`settlementWeekStart`, `workingDays`, `hoursPerDay`, `overtimeMultiplier`, `subcontractPaymentsByPm`); `ProjectWorker`, `SubcontractAssignment`, `Attendance`, `WorkMeasurement`, `Advance`, `WageSettlement` (+ lines, `SettlementAdvance` allocations), append-only `SubcontractLedgerEntry` (SELECT + INSERT), `CashAccount` (partial unique: one active per holder), `CashEntry` (SELECT / INSERT / UPDATE, no DELETE), `TopupRequest`, `CashCount` — RLS, grants, composite FKs, `(tenantId, clientId)` uniques for offline creates |
| `20261010090000_billing_receivables` | `TenantSettings` billing fields (`paymentTermsDays`, `taxRatePercent`, `taxLabel`, `pmCanRecordPayments`); `BillingStageStatus` + READY / PARTLY_PAID; stage `readyAt`, `readyById`, `readyNote`, `proofAttachmentIds`, `expectedDate`, `milestoneId`; `AttachmentKind` + INVOICE_PDF / RECEIPT_PDF / STATEMENT_PDF; `CashEntry.billedInvoiceId`; `BillingProgress`, `Invoice` (+ lines), `ClientPayment`, append-only `PaymentAllocation`, `BillingEvent` — RLS, grants, composite FKs |
| `20261015090000_notifications_reports` | `NotificationSeverity`, `NotificationType`, `Notification` (RLS, SELECT / INSERT / UPDATE; indexes for the inbox and the 24 h dedupe); `AttachmentKind.REPORT` |
| `20261016090000_daily_logs` | `SiteCondition`, `DailyLog` (RLS, SELECT / INSERT / UPDATE), `Attachment.clientId` (unique per company), `NotificationType.MISSING_DAILY_LOG` |
| `20261016100000_sync_changes` | `SyncOp`, `SyncChange` (bigserial seq; RLS; app_user SELECT only) written by the `sync_track()` SECURITY DEFINER trigger on every synced table, `SyncWatermark` |
| `20261016110000_sync_push` | `SyncMutationStatus`, `SyncIdMap` (clientId → server entity / rejection, device, deviceCreatedAt; RLS, SELECT / INSERT) |

Prisma's `migrate dev` refuses to run non-interactively when a change has warnings (enum value removed). Generate SQL with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-edit renames (e.g. `ALTER TYPE … RENAME VALUE`, `RENAME COLUMN`) so data is kept, save it as a new migration folder and run `npx prisma migrate deploy`.

## Tests

`npm test` uses `.env.test` (copy `.env.test.example`). Global setup creates the `construction_test` database and applies the migrations; every test starts from a truncated + re-seeded database. The suite refuses to run against a database whose name doesn't end in `_test`.
