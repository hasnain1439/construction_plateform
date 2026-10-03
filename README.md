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

## Error codes

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `USE_OTP_LOGIN`, `OTP_INVALID`, `CURRENT_PASSWORD_WRONG`, `FILE_REQUIRED`, `FILE_TOO_LARGE`, `INVALID_FILE_TYPE`, `INVALID_UPLOAD`, `HOLIDAY_IN_PAST`, `FINANCIALS_PM_ONLY`, `INVALID_PROJECT`, `THEKEDAR_HAS_ALL_PROJECTS`, `CANNOT_REVOKE_CURRENT_DEVICE`, `AMOUNT_MISMATCH`, `INVALID_PLAN`, `PLAN_REQUIRED`, `PAID_ON_IN_FUTURE`, `PAID_ON_TOO_OLD`, `SAME_PLAN`, `DOWNGRADE_USERS_OVER_LIMIT`, `KEEP_PROJECTS_REQUIRED`, `TOO_MANY_PROJECTS` |
| 401 | `UNAUTHENTICATED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `SESSION_REVOKED`, `ACCOUNT_DISABLED`, `INVALID_CREDENTIALS`, `REFRESH_INVALID`, `REFRESH_TOKEN_REUSED`, `DEVICE_REVOKED` |
| 402 | `PLAN_LIMIT_REACHED` |
| 403 | `FORBIDDEN`, `COMPANY_SUSPENDED`, `ACCOUNT_READ_ONLY`, `INVALID_SIGNATURE`, `LINK_EXPIRED`, `CANNOT_CHANGE_OWN_ROLE`, `CANNOT_CHANGE_OWNER_ROLE`, `CANNOT_DEACTIVATE_SELF`, `LAST_THEKEDAR` |
| 404 | `ROUTE_NOT_FOUND`, `NOT_FOUND`, `PHONE_NOT_REGISTERED`, `INVITE_NOT_FOUND`, `ATTACHMENT_NOT_FOUND`, `HOLIDAY_NOT_FOUND`, `USER_NOT_FOUND`, `DEVICE_NOT_FOUND`, `COMPANY_NOT_FOUND`, `SUBSCRIPTION_NOT_FOUND`, `NO_PENDING_CHANGE` |
| 409 | `ALREADY_EXISTS`, `PHONE_TAKEN`, `EMAIL_TAKEN`, `MULTIPLE_COMPANIES`, `INVITE_ALREADY_ACCEPTED`, `INVITE_CANCELLED`, `INVITE_PENDING`, `ALREADY_MEMBER`, `HOLIDAY_EXISTS`, `USER_ALREADY_ACTIVE`, `PAYMENT_PENDING`, `DUPLICATE_TRANSACTION`, `CASH_BALANCE_OPEN` (future) |
| 410 | `OTP_EXPIRED`, `INVITE_EXPIRED`, `INVITE_CANCELLED` |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `RATE_LIMITED`, `OTP_RESEND_WAIT`, `OTP_LIMIT_REACHED`, `OTP_TOO_MANY_ATTEMPTS`, `INVITE_RESEND_WAIT` |

## Migrations

| Migration | What |
|---|---|
| `20261002192308_init_core_auth` | Core tenant schema, RLS policies, role grants |
| `20261003120000_company_team` | Attachment `kind` (url dropped — URLs are signed on demand), company profile fields, settings rules, holiday ranges/types, `User.deactivatedAt`, `UserStatus DISABLED → INACTIVE`, `Invitation.lastResentAt` + `(tenantId, phone, status)` index, device sync fields |
| `20261003130000_tenant_logo_fk` | Logo FK → `Attachment.id` (same-tenant enforced in the service) |
| `20261003140000_auth_indexes` | `Session(deviceId)` for device revocation, `OtpCode(phone, createdAt)` for the hourly OTP limit |
| `20261004090000_subscription` | SubscriptionStatus `PAST_DUE → GRACE`, `EXPIRED → LAPSED`; PaymentStatus `PENDING/PAID/FAILED → PENDING_REVIEW/APPROVED/REJECTED`; `PaymentMethod` enum; `Plan.maxProjects → maxActiveProjects` + `features`; subscription period/grace/pending-change/reminder fields; payment `transactionId` (globally unique), `paidOn`, slip, `receiptNo`; `AttachmentKind.PAYMENT_SLIP`; `ProjectStatus.READ_ONLY` |

Prisma's `migrate dev` refuses to run non-interactively when a change has warnings (enum value removed). Generate SQL with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-edit renames (e.g. `ALTER TYPE … RENAME VALUE`, `RENAME COLUMN`) so data is kept, save it as a new migration folder and run `npx prisma migrate deploy`.

## Tests

`npm test` uses `.env.test` (copy `.env.test.example`). Global setup creates the `construction_test` database and applies the migrations; every test starts from a truncated + re-seeded database. The suite refuses to run against a database whose name doesn't end in `_test`.
