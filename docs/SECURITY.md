# Security — Construction Platform

How the platform protects company data, and what to check before going live. Covers the API
(`construction-platform`), the web app (`construction-web`) and the Munshi app (`construction-mobile`).
Keep it current when auth, tenancy, permissions or limits change.

## 1. Threat model (summary)

| Asset | Who we protect it from | Main controls |
|---|---|---|
| A company's data (projects, money, rates, workers, phones) | Other companies; users of the same company without the permission; the public | Tenant from the verified token only, Postgres RLS, permission checks on every route + sync, field stripping |
| Accounts and sessions | Password guessing, OTP guessing, SMS pumping, stolen / replayed tokens | bcrypt, lock-out, rate limits, short-lived access tokens, rotating refresh tokens with reuse detection, httpOnly cookies |
| Platform admin power (sees every company) | A careless or curious admin; a stolen admin session | Separate admin table + audience, act-as only with a live, reasoned, time-boxed, audited support session, read-only by default |
| Files (bills, photos, voice notes, PDFs) | Anyone with a guessed URL; other companies | Signed, expiring URLs (HMAC / Cloudinary authenticated assets), type + magic-byte checks, size limit |
| Secrets (DB, JWT, SMTP, Cloudinary) | Leaks in git, logs, error responses | Env-only, Zod-validated at start-up, redacting logger, generic 500 bodies |

Out of scope for now: DDoS beyond per-IP rate limits (put a CDN / WAF in front), compromised
devices (a revoked phone loses access on its next request, but data already synced stays on it
until the app wipes it), insider abuse by a company owner inside their own company.

## 2. Tenant isolation

- A tenant is a construction company. The tenant id comes **only** from the verified access token
  (`ctx.tenantId`) — never from headers, query, body or URL.
- Three database roles: `app_user` (`DATABASE_URL`, row-level security applies), `app_admin`
  (`DATABASE_ADMIN_URL`, BYPASSRLS — only auth, platform-admin, jobs, seed, scripts, tests; a guard
  test greps for it) and the migration superuser (Prisma CLI only).
- Every table with a `tenantId` has RLS **ENABLE + FORCE** and a `tenant_isolation` policy
  (`prisma/rls.sql`); new tenant tables add the policy and explicit `GRANT … TO app_user` in their
  migration. Company code runs inside `withTenant(tenantId, tx => …)`, which sets the tenant for
  that transaction; outside it tenant tables return no rows.
- Composite `(tenantId, id)` foreign keys keep children in the parent's company.
- Out-of-scope projects answer **404**, not 403, so ids of other projects / companies don't leak.
- Two SECURITY DEFINER functions (owned by the migration role) write where app_user can't:
  `sync_track()` (SyncChange rows) and `purge_demo_data()` ("Remove demo data", migration
  `20261022090000_onboarding`). `purge_demo_data()` takes **no tenant parameter** — it reads the
  caller's own `app.tenant_id` (set by `withTenant`), refuses to run without it, filters every
  statement by that tenant, and only touches demo-tagged rows (`isDemo` project / client / supplier /
  workers / cash book and what hangs off them); EXECUTE is revoked from PUBLIC and granted to
  app_user only. The API refuses (`409 DEMO_IN_USE`) while real data uses demo rows.
- Spreadsheet imports (`/imports/:entity/*`) read uploads in memory only (≤ 2 MB, ≤ 1000 rows,
  zip signature check before exceljs), never store the file, and validate every row with the same
  rules as the create endpoints.
- Tests: `tests/rls.test.ts`, `tests/guards/prismaAdminImports.test.ts`, per-module cross-company tests.

## 3. Permissions

- Account types: THEKEDAR (owner, every permission), PM (office), MUNSHI (site). Platform admins
  live in a separate table and token audience.
- One catalogue of keys `<module>.<resource>.<action>` (`src/core/auth/permissionCatalog.ts`),
  role templates + custom roles + per-user ALLOW / DENY overrides, scopes (assigned / all projects),
  approval limits (`maxAmountPaisa`) and field permissions (`fields.rates|amounts|profit|contract`).
- Standard chain: `authenticate → tenantContext → readOnlyGuard → requirePerm(key) → validate`.
  Services re-check with `assertPerm / assertProjectScope / assertApprovalLimit`; DTOs strip fields
  the caller can't see. Offline sync applies the same rules (tables, fields, pushed mutations).
- Permissions are resolved from the database on each request (cached per user, invalidated by any
  change), so revoking a permission applies immediately. Owner-only keys and owners themselves
  can't be changed by non-owners; every change is audited with before / after.
- `tests/permissions/parity.test.ts` enumerates every company route and fails when a new route has
  no permission decision.

## 4. Platform admin "act as" (support sessions)

- An admin works inside a company only with `X-Act-As-Tenant` **and** `X-Act-As-Session` naming a
  live session of that admin for that company. Sessions need a reason (5–300 chars), default to
  60 minutes, start **read-only** (`403 ACT_AS_READ_ONLY` on writes) and need a second reason to
  switch to write mode; they can be ended at any time.
- Start / mode change / end are audited with the admin's name and reason; changes made while acting
  carry `actAsSessionId`, `adminName` and `actAsReason` in the company's audit log.
- The company owner gets an in-app notification and an email naming the reason, and can read the
  company audit log (`GET /company/audit-logs`).
- Inside the company the admin acts as a hidden system user, never as a real employee.

## 5. Authentication, tokens and cookies

- **Passwords**: bcrypt (`BCRYPT_ROUNDS`, ≥ 12 enforced in production), 8–72 chars with a letter and
  a number. 5 wrong passwords lock the account for 15 minutes (users and platform admins). A
  password reset revokes every session of that user.
- **OTP / login codes** (`OtpCode`): 6 digits, stored only as a hash, lifetime `OTP_TTL_SECONDS`
  (default 5 min, **capped at 10 min** by the env schema), single use (consumed on success; a new
  code consumes the old one; a race between two sign-ins lets only one win), **3 wrong tries**
  consume the code, resend after 60 s, at most 5 codes per phone per hour. The owner-issued munshi
  login code (`POST /users/:id/login-code`) is the same LOGIN code, shown once, never logged or
  audited in clear. Tests: `tests/auth/otp.test.ts`, `tests/auth/loginCodeRules.test.ts`,
  `tests/team/munshiSignIn.test.ts`.
- **Access token**: JWT (HS256, `JWT_ACCESS_SECRET` ≥ 32 chars), 15 minutes, audience `company` or
  `platform`. On every company request the API also checks the user is ACTIVE, the device is not
  revoked and the session family is alive — logout, deactivation and device revocation cut access
  at once.
- **Refresh token**: 48 random bytes, stored as a peppered hash (`JWT_REFRESH_PEPPER`), rotated on
  every use; reusing an old one revokes the whole family (theft detection). 30 days, or the
  browser session when "remember me" is off.
- **Web cookies** (`token.service.ts`): `HttpOnly`, `Secure` in production, `SameSite=Lax` for the
  access cookie (path `/`), `SameSite=Strict` for the refresh cookie and its marker, scoped to
  `/api/v1/auth` (or `/api/v1/admin/auth`). The web app proxies `/api/v1` through Next.js so the
  cookies stay first-party. Test: `tests/auth/cookieFlags.test.ts`.
- **Mobile**: tokens in the response body, kept in the OS secure store (expo-secure-store), sent as
  `Authorization: Bearer`. Revoked phones can't sign back in.
- **Invitations**: random token, stored hashed, 7 days, single use; a resend invalidates the old link.

## 6. Rate limits

In memory per API instance (`src/core/middleware/rateLimit.ts`); 429 `RATE_LIMITED` with
`details.retryAfterSeconds` and draft-8 `RateLimit` headers. `TRUST_PROXY` must match the number of
proxies in front of the API, or every client shares the proxy's IP.

| Route(s) | Limit | Key | Env |
|---|---|---|---|
| `POST /auth/login`, `/auth/signup`, `/auth/otp/request`, `/auth/otp/verify`, `/auth/password/forgot`, `/auth/password/reset`, `/admin/auth/login`, `/invitations/:token/accept` | 10 / min | IP + phone / email (invite token) | `AUTH_RATE_LIMIT_MAX` |
| same routes, together | 30 / min | IP | `AUTH_IP_RATE_LIMIT_MAX` |
| `/auth/otp/request`, `/auth/password/forgot` (send an SMS / email) | 20 / hour | IP | `OTP_SEND_IP_RATE_LIMIT_MAX` |
| OTP / login code (service) | resend 60 s; 5 / phone / hour; 3 wrong tries | phone | — |
| Password (service) | 5 wrong → 15 min lock | account | — |
| `POST /sync/push` (≤ 100 mutations each) | 60 / min | signed-in user | `SYNC_PUSH_RATE_LIMIT_MAX` |
| `POST /users/:id/login-code` | owner only + the OTP limits above | phone | — |
| everything under `/api/v1` | 300 / min | IP | `GENERAL_RATE_LIMIT_MAX` |

Test: `tests/auth/rateLimits.test.ts` (wiring + 429 shape). Many users behind one carrier NAT share
an IP: raise `AUTH_IP_RATE_LIMIT_MAX` if a pilot site reports 429s at sign-in.

## 7. Web app headers

Set for every page in `construction-web/next.config.ts` from `src/lib/securityHeaders.ts`:
`Content-Security-Policy` (default-src 'self'; scripts / styles self + inline; images, media and
frames from self, `data:` / `blob:`, the API's public origin (`API_PUBLIC_URL` / `API_ORIGIN`) and
Cloudinary; `connect-src 'self'`; `object-src 'none'`; `base-uri` / `form-action 'self'`;
`frame-ancestors 'none'`; `upgrade-insecure-requests` in production; dev adds `'unsafe-eval'` and
websockets for hot reload), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone,
geolocation, payment, usb, serial, bluetooth, topics off), `Cross-Origin-Opener-Policy: same-origin`
and HSTS in production. Fonts are self-hosted by `next/font`, so no Google Fonts origin is needed.

The API uses helmet defaults; signed file responses allow framing only by the web app's origins
(`APP_URL` + `CORS_ORIGINS`) so PDF previews work.

## 8. Secrets and configuration

- All secrets come from the environment, validated by Zod at start-up (`src/config/env.ts`); the
  process refuses to start with missing / weak values (JWT secrets ≥ 32 chars, bcrypt ≥ 12 in
  production, SMTP / SES / SMS gateway / WhatsApp / Cloudinary / S3 keys when those providers are on). With
  `NODE_ENV=production` it also refuses dev providers (console SMS / mail, local storage) unless
  `ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true` (staging only).
- `.env*` files are git-ignored (only `*.example` files are committed). Never commit real values.
- The logger redacts auth headers, cookies, passwords, tokens and codes and never logs bodies;
  request logs carry the path without query secrets (`safeUrl`). 500 responses are generic.
- Rotate `JWT_ACCESS_SECRET` (signs everyone out within 15 min), `JWT_REFRESH_PEPPER` (signs
  everyone out), DB passwords, SMTP / SES / SMS gateway / WhatsApp tokens and Cloudinary / S3 keys if any leak.
- Message delivery log (`MessageDelivery`) stores masked recipients, status, provider id and a
  sanitised error only — never message text, codes or links. SMS gateway errors redact the message
  and the API key; the WhatsApp token and S3 / SES keys are never logged.
- Files in S3 / R2: private bucket, no ACLs, SSE AES256, presigned GET URLs that expire after
  `SIGNED_URL_TTL_SECONDS`; the access key should be limited to that one bucket.

## 9. Database connections

A transaction holds one pg connection, and one connection runs one query at a time. Don't
`Promise.all` queries on a `tx` — use `inSequence([...])` (`src/core/db/inSequence.ts`). Prisma's own
parallel include loading is serialised per connection by `SerialPgClient` (`src/core/db/prisma.ts`).
`tests/setup/pgConcurrency.ts` fails any test that overlaps queries on one connection.

## 10. Dependencies

`npm audit` in each repo; fix high / critical without breaking upgrades. Known leftovers (Oct 2026):
- API: `deepmerge-ts` (via the Prisma 7.10 CLI, dev-time only, fix = Prisma downgrade), `uuid`
  (moderate, via `exceljs`; we don't use the affected v3/v5/v6 buffer API).
- Web: `braces` via `shadcn` / `eslint-config-next` (CLI / lint tooling only, no fixed release).
- Mobile: `braces`, `node-forge` (no fixed release) and moderates via the Expo / Jest / Tailwind
  build tooling — not shipped in the app bundle.

## 11. Monitoring and analytics (PII scrubbing)

Sentry and PostHog are optional (empty `SENTRY_DSN` / `POSTHOG_KEY` → never initialised, nothing
leaves the server). When on:

- **Sentry** (`src/core/observability/sentry.ts` + `scrub.ts`): SDK collection of user info / IP,
  cookies, request bodies, query strings, SQL values and local variables is off, and every error,
  transaction and breadcrumb passes `scrubEvent` / `scrubBreadcrumb`: request bodies (all routes —
  auth bodies hold passwords and codes), cookies, `Authorization` / `Cookie` / `X-Act-As-Session` /
  `X-Forwarded-For` headers and query strings are dropped; emails, Pakistani / E.164 phones, CNICs,
  JWTs, `Bearer` values, long opaque tokens, `token= / code= / sig= / password=` params and
  invitation tokens in URLs are masked; any key named like password / token / otp / code / phone /
  email / cnic / session is `[REDACTED]`. The user is `{ id: sha256("user:" + id)[0..32] }` only;
  tags are `requestId`, `tenantId`, `actorType`, `userIdHash`. The web and mobile apps use the
  same rules (their own `scrub` modules). Tests: `tests/observability/scrub.test.ts`, `sentry.test.ts`.
- **PostHog** (`analytics.ts`, same in web / mobile): fixed event list, prop allow-list, numbers only
  for `count` / `duration_ms`, strings that look like emails / phones / tokens / amounts dropped —
  never money values, names, phones or free text. Person = hashed user id, company = tenant id as a
  group. Support sessions are not tracked. GeoIP off on the API.
- **Logs** add `tenantId` / `userId` (ids only) to request log lines.
- `/health/ready` reports error codes only, never hosts or connection strings.

## 12. Before launch — review checklist

- [ ] Production env: `NODE_ENV=production`, strong unique `JWT_ACCESS_SECRET` / `JWT_REFRESH_PEPPER`,
      `BCRYPT_ROUNDS` ≥ 12, `CORS_ORIGINS` = the real web origin(s) only, `APP_URL`, `API_PUBLIC_URL`,
      `COOKIE_DOMAIN` only if the API and web share a parent domain, `TRUST_PROXY` = real hop count,
      `ENABLE_DOCS` off (or behind auth).
- [ ] HTTPS everywhere (cookies are `Secure` in production; the web sends HSTS).
- [ ] Database: app connects as `app_user`, `app_admin` only for the auth / admin / jobs paths;
      superuser credentials only in the migration pipeline; RLS policy present on every tenant
      table (`SELECT relname FROM pg_class WHERE relrowsecurity` vs tables with `tenantId`).
- [ ] More than one API instance → move rate limits to a shared store (Redis) or the edge.
- [ ] Real providers: `SMS_PROVIDER=http`, `MAIL_PROVIDER=ses` (domain with SPF / DKIM / DMARC, out of the
      SES sandbox), `STORAGE_PROVIDER=s3` (private bucket, scoped key) and `npm run storage:migrate` run;
      `ALLOW_DEV_PROVIDERS_IN_PRODUCTION` unset. See README → Providers.
- [ ] Real SMS provider configured; watch OTP volume for SMS pumping; consider CAPTCHA on OTP
      request if abuse appears.
- [ ] `POST /auth/otp/request` answers `404 PHONE_NOT_REGISTERED` (lets anyone check whether a
      phone has an account) — accepted for munshi UX; revisit if enumeration becomes a concern.
- [ ] Web CSP still uses `'unsafe-inline'` for scripts (Next.js inline chunks + theme script);
      a nonce-based CSP via `proxy.ts` is the next hardening step.
- [ ] Platform admin accounts: few, named, strong passwords; review `admin.act_as_*` audit rows.
- [ ] Backups encrypted, restore tested; storage (Cloudinary) assets set to authenticated / S3 bucket private with Block Public Access.
- [ ] `npm audit` re-run on the release branch; no `.env` in git history.
- [ ] Log retention / access: logs contain masked phones and user ids, no tokens or codes.
- [ ] Sentry: IP storage off and server-side data scrubber on in each project; access limited to the team. PostHog: project in the region you want (EU / US), GeoIP off for web / mobile if not wanted.
