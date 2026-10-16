# Construction Platform API

Multi-tenant backend for a Construction Management SaaS. Express 5 · TypeScript (strict, ESM) · Prisma 7 · PostgreSQL (row-level security) · Zod.

Tenant = construction company. Company users are `THEKEDAR` (owner), `PM` (project manager, office account) and `MUNSHI` (site supervisor, phone OTP). What a PM or Munshi may do comes from **permissions** (role templates + per-user overrides, see [Permissions](#permissions)); the THEKEDAR always has every permission. Platform owners are `PLATFORM_ADMIN` in a separate table.

> Where the tables below say "THEKEDAR, PM" / "THEKEDAR" / "all", that is the **default** access (the system templates reproduce exactly the old role rules); the API checks permission keys.

Changelog: see [CHANGELOG.md](CHANGELOG.md). Deployment (Docker, VPS, HTTPS, CI/CD, backups, rollback): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
| `db:backup` / `db:restore-check` | `pg_dump -Fc` with retention into `./backups` · restore the newest dump into a scratch DB and run sanity checks (Git Bash / Linux; `-- --env-file .env`). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#8-backups) |
| `test` / `test:watch` | Vitest, test files in parallel — one copy of the `construction_test` database per worker (`.env.test`; see [Tests](#tests)) |
| `test:serial` | Same suite one file at a time on `construction_test` itself (fallback / debugging) |
| `typecheck` | Type-checks src, tests, prisma and scripts |
| `jobs:subscriptions` | Run the subscription lifecycle once (also runs in the server at start-up and daily 02:00 PKT) |
| `backfill:permissions` | Permission role templates for every company, a template for users without a role, `canSeeFinancials` PMs → overrides (idempotent) |
| `storage:migrate -- --from local\|cloudinary --to s3 [--dry-run]` | Copy existing attachment files to the S3 / R2 bucket and update their keys (idempotent, source files kept) — see [Providers](#providers) |
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

**Security overview:** [docs/SECURITY.md](docs/SECURITY.md) — threat model, tenant isolation, permissions, platform admin direct access (act-as), tokens / cookies, rate limits, secrets and the pre-launch checklist.

**Rate limits** (429 `RATE_LIMITED`): sign-in routes 10 / min per IP + phone / email (`AUTH_RATE_LIMIT_MAX`) and 30 / min per IP across all of them (`AUTH_IP_RATE_LIMIT_MAX`); OTP request + forgot password 20 / hour per IP (`OTP_SEND_IP_RATE_LIMIT_MAX`); `/sync/push` 60 / min per user (`SYNC_PUSH_RATE_LIMIT_MAX`); everything 300 / min per IP (`GENERAL_RATE_LIMIT_MAX`). Login / SMS codes: `OTP_TTL_SECONDS` ≤ 600, one use, 3 wrong tries. Full table in [docs/SECURITY.md](docs/SECURITY.md#6-rate-limits).

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

Codes never go to the structured (pino) log. Password-reset emails are printed the same way. Real SMS / email / WhatsApp: see [Providers](#providers).

### Email (invites and login codes)

Everything that goes by SMS also goes by email when the person has an email address:

- **New company** (platform console): the owner gets the invite link by SMS and email (owner email, or the company email).
- **Team invite** (PM / Munshi): the invite link by SMS and email (when the invite has an email). Resend does the same.
- **Login code** (`POST /auth/otp/request`): the code by SMS and to every email on that phone; the response says `emailed: true`.
- **Password reset**: as before.

Mail is best effort: a failed email never fails the request (the link can be resent). `MAIL_PROVIDER=console` prints mail to the terminal; for real email set `MAIL_PROVIDER=ses` (Amazon SES, recommended — see [Providers](#providers)) or `MAIL_PROVIDER=smtp` and `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (see `.env.example`; Gmail works with an App Password).

A Munshi signs in on the mobile app with **phone + code** or **phone + password**. The password is chosen when accepting the invite (optional for a Munshi) or set later by the Thekedar (`PUT /users/:id/password`).

### Remember me (web)

`POST /auth/login` and `POST /admin/auth/login` accept `rememberMe` (default `true`). With `false` the auth cookies are session cookies (no expiry, gone when the browser closes) and a `<refresh cookie>_session` marker keeps that choice when `/auth/refresh` rotates the tokens.

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
import { requirePerm } from '../../core/middleware/requirePerm.js';
import { validate } from '../../core/middleware/validate.js';
import { getCtx } from '../../core/context/requestContext.js';
import { withTenant } from '../../core/db/withTenant.js';

router.post(
  '/projects',
  authenticate,                 // 401 unless a valid company token (cookie or Bearer)
  tenantContext,                // 403 COMPANY_SUSPENDED; flags READ_ONLY companies
  readOnlyGuard,                // 403 ACCOUNT_READ_ONLY for writes on READ_ONLY companies
  requirePerm('projects.project.create'), // 403 PERMISSION_DENIED { permission } — keys in core/auth/permissionCatalog.ts
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

Every company route has a `requirePerm(key)` (or none for things every user may do: own profile, notifications, sync, uploads, holidays list, static presets). In services use `assertPerm(key, actor)`, `can(key, actor)`, `scopeAll(key, actor)`, `assertApprovalLimit(key, paisa, actor)` (`src/core/auth/access.ts`) and `assertProjectScope(tx, key, projectId)` (`projects/access.ts`). See [Permissions](#permissions).

### Endpoints

All under `/api/v1`, documented with examples at **`/api/docs`** (raw spec: `/api/docs.json`; disabled in production unless `ENABLE_DOCS=true`).

`POST auth/signup` · `POST auth/login` · `POST auth/otp/request` · `POST auth/otp/verify` · `POST auth/refresh` · `POST auth/logout` · `POST auth/logout-all` · `POST auth/password/forgot` · `POST auth/password/reset` · `GET|PATCH auth/me` · `GET auth/sessions` · `POST invitations/:token/accept` · `POST admin/auth/login|refresh|logout` · `GET admin/auth/me`

### Audit log

`tenant.signup`, `auth.login`, `auth.login_failed`, `auth.otp_verified`, `auth.refresh_reuse_detected`, `auth.logout`, `auth.logout_all`, `auth.password_reset`, `auth.password_changed`, `invite.accept`, `admin.login` — with IP, user agent and request id; never passwords, tokens or codes.

---

## Providers

Production needs real SMS, email and file storage. Every provider is chosen by environment variables (all listed in `.env.example`) and checked at start-up by `src/config/env.ts`. **With `NODE_ENV=production` the API refuses to start with `SMS_PROVIDER=console`, `MAIL_PROVIDER=console` or `STORAGE_PROVIDER=local`**; a staging server may set `ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true` to run with them anyway.

| Channel | Setting | Values | Code |
|---|---|---|---|
| SMS | `SMS_PROVIDER` | `console` (dev / tests) · `http` (any HTTP gateway) | `src/modules/auth/sms.provider.ts` |
| Email | `MAIL_PROVIDER` | `console` · `smtp` · `ses` (Amazon SES API v2) | `src/modules/auth/mail.provider.ts` |
| WhatsApp | `WHATSAPP_ENABLED` | `false` (default) · `true` (Meta Cloud API, template messages) | `src/modules/auth/whatsapp.provider.ts` |
| Files | `STORAGE_PROVIDER` | `local` · `cloudinary` · `s3` (AWS S3 / Cloudflare R2 / MinIO) | `src/modules/attachments/*.provider.ts` |

### What you must set up (owner checklist)

Nothing here is bought or created by the code — these are accounts and settings the owner arranges:

1. **SMS gateway** (Pakistan): an account with a PTA-compliant bulk SMS aggregator that offers an HTTP API, a **sender ID / mask** approved for your brand, and (if the gateway requires it) registered message templates. You need: endpoint URL, method, auth style + key, the answer it gives on success (for `SMS_HTTP_SUCCESS_MATCH` / `SMS_HTTP_ID_PATH`). Then set `SMS_PROVIDER=http` and the `SMS_HTTP_*` / `SMS_SENDER_ID` / `SMS_TEMPLATES` keys.
2. **Amazon SES**: an AWS account; in SES (a region such as `eu-west-1`, `ap-south-1` or `me-central-1`) **verify your sending domain** with Easy DKIM, add the SPF / DMARC records below, **request production access** (leave the sandbox), and create an IAM user or role allowed `ses:SendEmail` only. Optional: a configuration set publishing bounces / complaints. Then `MAIL_PROVIDER=ses`, `SES_REGION`, `MAIL_FROM` (+ `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` unless the server has an IAM role).
3. **DNS for email** (on the domain of `MAIL_FROM`, ideally a subdomain like `mail.example.pk`): SPF, DKIM, DMARC — see below.
4. **File bucket**: a **private** S3 bucket (Block Public Access on, default encryption SSE-S3) or a Cloudflare R2 bucket (no public access / no r2.dev URL), and an access key limited to that bucket (`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` for the migration's HeadObject). For uploads from the web app nothing else is needed (files go through the API; downloads are presigned URLs). Then `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION` (`auto` for R2), `S3_ENDPOINT` (R2 / MinIO only), keys. Run `npm run storage:migrate -- --from local --to s3 --dry-run`, then without `--dry-run`.
5. **WhatsApp (optional)**: a Meta Business account, a WhatsApp Business phone number in the Cloud API, a **permanent System User access token** with `whatsapp_business_messaging`, and the four **message templates approved** in WhatsApp Manager (names / variables below). Then `WHATSAPP_ENABLED=true`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`.
6. Keep every secret in the server's secret store / environment, never in git. Rotate them if they leak (see `docs/SECURITY.md`).

### Delivery log

Every SMS, email and WhatsApp message is recorded in `MessageDelivery` (migration `20261021090000_message_deliveries`): `channel` SMS / EMAIL / WHATSAPP, `type` (OTP, PASSWORD_RESET, INVITE, NOTIFICATION, SUBSCRIPTION_REMINDER, CASHBOOK, DISPATCH, PLATFORM, INVOICE, STATEMENT, GENERIC), `provider`, **masked** `to` (`+92300*****67`, `k***@example.pk`), `status` QUEUED → SENT / FAILED, `providerId` (gateway id, SES MessageId, WhatsApp `wamid`), `error` (no message text, no codes), `tenantId` (null for login codes and other platform messages). Message bodies are never stored. The platform writes it (app_admin); a company can only read its own rows (RLS, `SELECT` for app_user). Logging never blocks or fails a send.

### SMS — generic HTTP gateway (`SMS_PROVIDER=http`)

One adapter covers most gateways by configuration:

- `SMS_HTTP_URL` + `SMS_HTTP_METHOD` (GET / POST). Placeholders `{to}`, `{message}`, `{sender}`, `{type}`, `{templateId}` work in the URL (URL-encoded) and in `SMS_HTTP_BODY_TEMPLATE` (JSON-escaped for `SMS_HTTP_CONTENT_TYPE=json`, URL-encoded for `form`). Default bodies: `{"to":"{to}","message":"{message}","sender":"{sender}"}` / `to={to}&message={message}&sender={sender}`; a GET without `{message}` in the URL gets the form string as its query.
- Auth `SMS_HTTP_AUTH`: `none`, `bearer` (`Authorization: Bearer <SMS_HTTP_API_KEY>`), `basic` (`SMS_HTTP_USERNAME` / `SMS_HTTP_PASSWORD`), `header` (`<SMS_HTTP_AUTH_HEADER>: <key>`), `query` (`?<SMS_HTTP_AUTH_QUERY_PARAM>=<key>`).
- `{to}` format `SMS_HTTP_PHONE_FORMAT`: `international` 923001234567 (default), `e164` +923001234567, `local` 03001234567.
- Success = HTTP 2xx **and** `SMS_HTTP_SUCCESS_MATCH` matches the body (if set) **and** `SMS_HTTP_FAILURE_MATCH` doesn't (for gateways that answer 200 with an error). `SMS_HTTP_ID_PATH` (e.g. `data.messageId`) reads the gateway's id from a JSON answer. Timeout `SMS_HTTP_TIMEOUT_MS` (10 s).
- Per-type text: `SMS_TEMPLATES` JSON, e.g. `{"OTP":"Munshi App code: {code} ({minutes} min)","INVITE":"{company}: {url}"}`. Placeholders: OTP / PASSWORD_RESET `{code}`, `{minutes}`; INVITE `{name}`, `{company}`, `{role}`, `{url}`; every type `{message}` (the built-in text). A template with a placeholder the message doesn't have is ignored (built-in text sent). `SMS_TEMPLATE_IDS` JSON (`{"OTP":"1001"}`) fills `{templateId}` for gateways with registered templates.
- If the login-code SMS fails (and WhatsApp is off or failed too), `POST /auth/otp/request` answers `503 SMS_UNAVAILABLE` and the undelivered code is dropped, so the user can retry at once. Other SMS (notifications, dispatch, cash, invites) stay best effort.

Example (JSON API with bearer key):

```env
SMS_PROVIDER=http
SMS_SENDER_ID=MUNSHI
SMS_HTTP_URL=https://sms-gateway.example.pk/api/v1/send
SMS_HTTP_AUTH=bearer
SMS_HTTP_API_KEY=…
SMS_HTTP_BODY_TEMPLATE='{"recipient":"{to}","text":"{message}","mask":"{sender}"}'
SMS_HTTP_SUCCESS_MATCH='"status":\s*"(ok|success)"'
SMS_HTTP_ID_PATH=data.id
```

### Email — Amazon SES (`MAIL_PROVIDER=ses`)

`SendEmail` (SES API v2, `@aws-sdk/client-sesv2`) with text + HTML, from `MAIL_FROM`, optional `SES_CONFIGURATION_SET`. Credentials: `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` when both are set, otherwise the standard AWS chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, profile, IAM role). Mail stays best effort (a failure is logged FAILED; the request still succeeds).

**SPF / DKIM / DMARC** — without them mail lands in spam or is rejected (Gmail and Yahoo require them for bulk senders):

- **DKIM**: in SES → Identities → your domain → Easy DKIM (2048-bit). SES gives three `CNAME` records `<token>._domainkey.mail.example.pk → <token>.dkim.amazonses.com`; add them all.
- **SPF**: with a custom **MAIL FROM domain** (SES → identity → "Custom MAIL FROM", e.g. `bounce.mail.example.pk`) add `MX 10 feedback-smtp.<region>.amazonses.com` and `TXT "v=spf1 include:amazonses.com ~all"` on that subdomain. If you also send from SMTP / Google Workspace on the same domain, keep **one** SPF record listing every sender.
- **DMARC**: `TXT` on `_dmarc.example.pk`: start with `v=DMARC1; p=none; rua=mailto:dmarc@example.pk`, watch the reports for a few weeks, then move to `p=quarantine` and `p=reject`.
- Request SES production access (out of the sandbox) and set up bounce / complaint handling (configuration set → SNS) before sending at volume.

### WhatsApp — Meta Cloud API (`WHATSAPP_ENABLED=true`)

Off by default. When on, **invites and login codes also go by WhatsApp** (an extra channel: SMS and email still go, and the web / mobile **share links stay the fallback**). Plain `fetch` to `https://graph.facebook.com/<WHATSAPP_API_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages` with `Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>`; failures are logged and never fail the request. Business-initiated messages must use templates approved in WhatsApp Manager, in `WHATSAPP_TEMPLATE_LANGUAGE` (default `en`):

| Type | Setting (default name) | Body variables | Wired |
|---|---|---|---|
| Invite | `WHATSAPP_TEMPLATE_INVITE` (`team_invite`) | {{1}} name, {{2}} company, {{3}} role, {{4}} invite link | team invites + new-company owner invites |
| OTP | `WHATSAPP_TEMPLATE_OTP` (`login_code`) | {{1}} code — an **Authentication** template with a copy-code button (the code is sent as the button parameter too) | login and password-reset codes |
| Invoice | `WHATSAPP_TEMPLATE_INVOICE` (`invoice_issued`) | {{1}} client, {{2}} invoice no, {{3}} amount, {{4}} PDF link | helper `whatsAppTemplates.invoice()` (not wired yet — invoices are shared by the existing WhatsApp share link) |
| Statement | `WHATSAPP_TEMPLATE_STATEMENT` (`account_statement`) | {{1}} client, {{2}} period, {{3}} balance, {{4}} link | helper `whatsAppTemplates.statement()` (same) |

### Files — S3-compatible (`STORAGE_PROVIDER=s3`)

See [Storage providers](#storage-providers). Objects go to `S3_BUCKET` under `<tenantId>/<yyyy>/<mm>/<attachmentId>.<ext>` with `ServerSideEncryption: AES256` (`S3_SERVER_SIDE_ENCRYPTION=none` only for a service that rejects the header) and no ACL (the bucket stays private). The stored key is `s3:<that key>`; clients get **presigned GET URLs** valid `SIGNED_URL_TTL_SECONDS`. Cloudflare R2: `S3_REGION=auto`, `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`; MinIO: `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE=true`.

**Moving existing files** — `npm run storage:migrate -- --from local|cloudinary --to s3 [--dry-run] [--tenant <id>] [--batch 100]` (`scripts/migrate-storage.ts`, needs the `S3_*` keys; `STORAGE_PROVIDER` may still be the old one): for each attachment still on the source it uploads the file unless the object is already in the bucket, then switches the row's key — only while the row still has its old key, so re-running is safe and resumes after an interruption. Failed files are listed and left untouched (exit code 1). Source files are **not** deleted: check the app, then remove `STORAGE_DIR` / the Cloudinary folder yourself. Switch `STORAGE_PROVIDER=s3` before or after — old keys stay readable either way.

### Tests

No test reaches a real provider: `tests/providers/` covers the HTTP gateway (mocked `fetch`, success / failure / delivery log rows / RLS), SES (`aws-sdk-client-mock`), WhatsApp disabled / enabled (mocked `fetch`), S3 put / presign / delete / migration (`aws-sdk-client-mock`; presigning is the real offline SDK code) and the production start-up refusal.

## Observability

Everything here is **optional and off by default**: with the env keys empty nothing is initialised and no data leaves the server. Code: `src/core/observability/` (`sentry.ts`, `scrub.ts`, `analytics.ts`, `hash.ts`), `src/instrument.ts`, `src/modules/health/`.

### Health

| Route | Use for | Checks | Answer |
|---|---|---|---|
| `GET /health` | liveness (restart) probe | none — no database | `200 { success, data: { status: "ok" } }` (unchanged) |
| `GET /health/ready` | readiness / load-balancer probe | **database** (`SELECT 1`, app_user pool) · **storage** (local folder writable / S3 `HeadBucket` / Cloudinary `ping`, cached 30 s) · **scheduler** (in-process jobs: `enabled`, `running`, last status of each `JobRun` via the admin pool) | `200 { data: { status: "ok", checks } }` or `503 { error: { code: "NOT_READY", details: { status: "fail", checks } } }` |

Each check has a 3 s budget and reports `ok`, `latencyMs` and on failure only an error **code** (`P1001`, `TIMEOUT`, `NoSuchBucket (404)`) — never hosts or connection strings. A FAILED background job is shown but does not make the API unready. Both routes sit outside `/api/v1` (no rate limit), are not request-logged and are never traced. Documented in OpenAPI (tag Health).

### Logs

pino (JSON in production). Every line written while handling a request — and the request line itself — carries `requestId`, `tenantId`, `userId` (and `platformAdminId` while a platform admin works inside a company) from the request context (`logger` mixin + pino-http `customSuccessObject`). Ids only; bodies, cookies, auth headers, passwords, tokens and codes stay redacted.

### Sentry (errors + performance)

`SENTRY_DSN` on → `Sentry.init` (`@sentry/node`) with `SENTRY_ENVIRONMENT` (default `NODE_ENV`), `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE` (default 0.1; `/health*` never sampled).

- **Errors**: every 500 (unhandled errors and `AppError` ≥ 500 except `503 SERVICE_BUSY`) is captured in `errorHandler` with tags `requestId`, `tenantId`, `actorType`, `userIdHash`, `route`; the Sentry user is `{ id: <hashed user id> }` only.
- **Performance**: Express / http / pg spans need Sentry loaded before Express — `npm start` runs `node --import ./dist/instrument.js dist/server.js` and `npm run dev` passes `--import ./src/instrument.ts` (server.ts also imports it first, so errors are reported either way). Transactions get the same tags (isolation scope set in `requestContext` / `authenticate`).
- **PII scrubbing** (`scrub.ts`, `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb`, plus SDK `dataCollection` off for user info, cookies, bodies, query strings, SQL values, local variables): emails, Pakistani / E.164 phones, CNICs, JWTs, `Bearer` values, long tokens, `token= / code= / sig= / password=` params, invitation tokens in URLs, signed-link query strings, `Authorization` / `Cookie` / `X-Act-As-Session` / `X-Forwarded-For` headers, **all request bodies** (auth bodies hold passwords and codes), IP address, and any key named like password / token / otp / code / phone / email / cnic / session. Money is not scrubbed (not personal data).

### Product analytics (PostHog)

`POSTHOG_KEY` on → `posthog-node` (batched, GeoIP off). One helper: `track(event, props)` in `src/core/observability/analytics.ts`.

| Event | Tracked by | Props |
|---|---|---|
| `login` | web + mobile apps (where identify happens) | `client`, `method`, `role` |
| `project_activated` | API `POST /projects/:id/activate` | `role` |
| `hazri_marked` | API attendance (REST, and sync with `source: "sync"`) | `count` (entries) |
| `purchase_saved` | API `POST /purchases` (REST, and sync `SITE_PURCHASE_CREATE`) | `kind` (STORE / SITE), `method` (payment mode) |
| `invoice_issued` | API `POST /invoices/:id/issue` | `kind` (invoice type) |
| `sync_error` | API: one per `/sync/push` batch with REJECTED / RETRY results; mobile: client-side sync failures | `kind`, `status`, `count`, `error_code` |

Rules (same allow-list in all three apps): only the props `client, platform, method, source, role, status, kind, count, error_code, app_version, offline, duration_ms`; numbers only for `count` / `duration_ms`; strings ≤ 64 chars that don't look like an email, a phone (≥ 7 digits), a token or an amount; keys containing amount / paisa / price / rate / total / balance / money / name / phone / email / cnic / address / token are dropped. **No money values, names, phones or free text.** Person = `distinctId` = first 32 hex of SHA-256(`"user:" + userId`) (web and mobile compute the same); company = PostHog group `company` keyed by the tenant id (never the name). Support sessions (platform admin acting as a company) are not tracked.

### Owner set-up

1. **Sentry**: create an organisation and three projects (Node API, Next.js web, React Native mobile); copy each DSN → `SENTRY_DSN` here, `NEXT_PUBLIC_SENTRY_DSN` in web, `EXPO_PUBLIC_SENTRY_DSN` in mobile. Optional: an auth token (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`) in the web / EAS build environments for source maps. In Sentry → Project settings → Security & Privacy also turn on "Data scrubber" and "Prevent storing of IP addresses".
2. **PostHog**: a project (US or EU cloud) → project API key → `POSTHOG_KEY` / `POSTHOG_HOST` here and the `NEXT_PUBLIC_POSTHOG_*` / `EXPO_PUBLIC_POSTHOG_*` keys in the apps. Enable "Group analytics" for the `company` group type (paid add-on; events still arrive without it).
3. Point the load balancer / container health checks at `GET /health` (liveness) and `GET /health/ready` (readiness).

## Languages

Everything the server writes for people — SMS, emails, in-app notifications, PDFs, report files and their enum labels — is in the **recipient's language**: English (`en`), **Roman Urdu** (`roman`, the default) or Urdu (`ur`, right-to-left).

**Where the language comes from**

| Message | Language |
|---|---|
| OTP / login code / password reset SMS and email | the user owning the phone / email (several companies: the one who signed in last) |
| Invite SMS + email | the invite's `language` (`POST /invitations` body, default: the company's `defaultLanguage`); it becomes the new user's language on accept. Platform-created owner invites: Roman Urdu |
| Notifications (+ their SMS) | each recipient's `User.language`, see below |
| Dispatch / cash / subscription / payment-review SMS | each recipient's language |
| Invoice / receipt / statement PDFs, report CSV / Excel / PDF | the requesting user's language; `?lang=en\|roman\|ur` overrides. The WhatsApp share text for the project owner follows the same language |

**API contract.** `User.language` stays the DB enum `Language` (ENGLISH / ROMAN_URDU / URDU); the API speaks the short codes. `/auth/me` and every login / OTP / invite-accept result have `user.language: 'en' | 'roman' | 'ur'`. `PATCH /auth/me/preferences` `{ language }` → `200 { language }` — any signed-in company user, also in a read-only company, not audited (a personal display setting). `PATCH /auth/me` still accepts `language` in either form. Team screens (`/users/:id`) and company settings keep the enum values.

**Catalogues** — `src/core/i18n/`: `catalog/en.ts` is the source of every key, `roman.ts` / `ur.ts` are `Record<MessageKey, string>` (TypeScript refuses a missing key) and `tests/unit/i18nCatalog.test.ts` fails on a missing / extra key, an empty text, different `{placeholders}` or Urdu text that isn't in Urdu script. Helpers: `tr(lang, key, params)`, `trCount` (`.one` / `.other`), `enumLabel(lang, 'ProjectStatus', v)`, `unitLabel`, `materialLine` ("200 bags cement" / "5,000 eent" / "200 بوری سیمنٹ"), `langOf` / `dbLanguage`, `langSchema` / `langQuery`. **Adding text:** add the key to `en.ts`, then `roman.ts` and `ur.ts`.

**Notifications** are stored with `textKey` + `params` (migration `20261023090000_languages`) **and** the title / body rendered in the recipient's language at creation. The inbox, dashboard alerts and `/sync/pull` render from key + params in the **reader's current language**, so switching language also changes old notifications (rows without a key show the stored text). Params are raw values; `unit`, `role`, `method` and `lines` are translated at render time. Response shapes are unchanged. Callers use `notify(tx, { …, text: { key, params } })` (`notifications/texts.ts` lists the keys); `title` / `body` remain for key-less callers.

**SMS templates.** `SMS_TEMPLATES` overrides still work; a language-specific entry wins: `{"OTP.ur": "…{code}…", "OTP": "…"}`. `{message}` is the built-in text in the recipient's language. WhatsApp template messages keep `WHATSAPP_TEMPLATE_LANGUAGE` (templates are approved per language by Meta).

**Urdu PDFs** are `<html lang="ur" dir="rtl">` with logical CSS (`text-align: end`, `margin-inline-start`), money / dates / codes in `<bdi dir="ltr">`, and **Noto Nastaliq Urdu** embedded as a base64 `@font-face` from `assets/fonts/NotoNastaliqUrdu-arabic.woff2` (SIL OFL 1.1, see `assets/fonts/NOTICE.txt`; copied into the Docker image) — no CDN or system font needed. If the file is missing the CSS falls back to system Urdu fonts (Jameel Noori Nastaleeq, Urdu Typesetting, Segoe UI, Tahoma) and a warning is logged. Stored invoice / receipt PDFs carry the language in the file name (`INV-2026-0010-ur.pdf`); asking in another language makes a new one. Report files translate the title, column headers, "Total" and status / type / unit cells; subtitles (filters, dates), names and numbers stay as built, and JSON reports are not translated.

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
| `s3` | Private S3 / R2 / MinIO bucket `S3_BUCKET`, object key `tenantId/yyyy/mm/<id>.<ext>`, SSE AES256, no ACL. Key stored: `s3:<object key>` | Presigned `GetObject` URL (SigV4, `X-Amz-Expires` = TTL). See [Providers](#files--s3-compatible-storage_providers3) |
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

The three `CLOUDINARY_*` credentials are validated at start-up only when `STORAGE_PROVIDER=cloudinary`. Switching is safe in both directions: each stored key says which provider holds it (`storageForKey`), so existing local files stay readable after moving to Cloudinary (keep `STORAGE_DIR` until you migrate them). Tests always use the local provider; the Cloudinary and S3 providers are tested with mocked SDKs (`tests/cloudinaryProvider.test.ts`, `tests/providers/s3Storage.test.ts`) and never call the services. `s3:` keys are read by the S3 provider whatever `STORAGE_PROVIDER` says; copy older files over with `npm run storage:migrate`.
- `GET /api/v1/attachments/:id` returns metadata + a fresh URL (RLS: other companies get 404).

Other modules call `signedUrlFor()` / `optionalSignedUrl()` from `attachments.service.ts` (company logo, user photo in `/auth/me`).

## Company

`src/modules/company` — mounted at `/api/v1/company`.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /company` | THEKEDAR, PM | Profile incl. signed `logoUrl` |
| `PATCH /company` | THEKEDAR | name 3–100, NTN `1234567-8`, logo (attachment of kind LOGO in this company, else 404), address, phone (mobile or landline → E.164), email, region, marlaStandard 225 / 272.25. Audit `company.update` stores changed field **names** only. |
| `GET /company/audit-logs` | owner (`company.audit.view`) | The company's own audit log, newest first, paginated; platform support rows name the support person and their reason (see [Working inside a company](#working-inside-a-company-company-data)). |
| `GET /company/settings` · `PATCH` | THEKEDAR | `kharchaApprovalLimitPaisa` (paisa as string), `overuseAlertPercent` 1–20, `missingLogAlertTime` HH:MM, `quoteValidityDays` 1–90, `taxEnabled`, `pmCanSeeFinancials` (default for new PM invites), `defaultLanguage`, `defaultMarginPercent` 0–100 (default 20) and `defaultFinishingAllowancePercent` 0–200 (default 0, FULL contracts only) for the contract value from the estimate. Audit `settings.update` with before/after. |
| `GET /company/holidays` | everyone | `year` or `from`+`to`. Platform holidays (nationwide or the company's region, `editable: false`) merged with company holidays, sorted. |
| `POST /company/holidays` · `DELETE /:id` | THEKEDAR | name, startDate (not in the past, company time zone), endDate ≥ startDate, type `NON_WORKING` / `PARTIAL`. Platform holidays can't be deleted (404). |

The seed adds the fixed-date national holidays (Kashmir Day, Pakistan Day, Labour Day, Independence Day, Iqbal Day, Quaid Day) for this year and next. Lunar holidays (Eids, Ashura) must be added per year by platform admins.

## Team

`src/modules/team` — users, invitations and devices.

**Users** (`/api/v1/users`)
- `GET /users` (THEKEDAR, PM): `search`, `role`, `status`, `projectId`, `page`, `limit` (25, max 100). `meta.usage = { officeUsers, maxOfficeUsers }` — office users are active THEKEDAR + PM; Munshis are free. PMs don't see `canSeeFinancials`.
- `GET /users/:id`, `PATCH /users/:id` (THEKEDAR): role only PM ↔ MUNSHI; nobody changes their own role (`CANNOT_CHANGE_OWN_ROLE`) or an owner's (`CANNOT_CHANGE_OWNER_ROLE`); `canSeeFinancials` only for PMs; MUNSHI → PM needs a free seat (`402`); duplicate phone `409 PHONE_TAKEN`. A role change also gives the user the default template of the new account type; permission changes apply on the user's next request.
- `DELETE /users/:id` = soft deactivate: status `INACTIVE`, all sessions and devices revoked. Not yourself (`CANNOT_DEACTIVATE_SELF`), never the last active THEKEDAR (`LAST_THEKEDAR`). `assertNoOpenCashBalance()` is the hook for the cash module (TODO → `409 CASH_BALANCE_OPEN`).
- `POST /users/:id/reactivate` (PM re-checks the seat limit), `PUT /users/:id/projects` replaces the project list in one transaction (`400 INVALID_PROJECT` for ids outside the company, `400 THEKEDAR_HAS_ALL_PROJECTS`).

**Invitations** (`/api/v1/invitations`, THEKEDAR; the public accept route stays in Auth)
- `POST` accepts `roleIds[]` / `roleId` and `permissionOverrides` (see [Permissions](#permissions)); `GET` items return `roleIds` and `permissionOverrides`.
- `POST` sends a Roman Urdu SMS — *"Malik & Sons Builders ne aap ko Project Manager ke taur par invite kiya hai: <APP_URL>/invite/<token>"*. The token is random, stored only as a hash, valid 7 days. `409 ALREADY_MEMBER`, `409 INVITE_PENDING`; PM invites count **pending PM invites** against the seat limit. Responses include `inviteUrl` (the one-time link) so the inviter can also share it on WhatsApp / SMS / copy; a resend makes a new link and the old one stops working. (`devInviteUrl`, the same link, is still returned outside production.)
- `GET` (status default PENDING; overdue ones are flipped to EXPIRED on read), `POST /:id/resend` (PENDING/EXPIRED, new link, once per 60 s → `429 INVITE_RESEND_WAIT`), `DELETE /:id` (cancel; accepting then gives `410 INVITE_CANCELLED`).

**Devices** (`/api/v1/devices`, THEKEDAR)
- `GET` lists devices with user, `lastSyncAt`, `pendingUploads` (filled by the future sync module) and `current`.
- `DELETE /:id` revokes the device and its sessions — its refresh then fails with `401 DEVICE_REVOKED` until the user logs in again. Your own current device → `400 CANNOT_REVOKE_CURRENT_DEVICE`.

Audit actions added: `attachment.upload`, `company.update`, `settings.update`, `holiday.create`, `holiday.delete`, `user.update`, `user.deactivate`, `user.reactivate`, `user.projects_update`, `invite.create`, `invite.resend`, `invite.cancel`, `device.revoke`.

## Permissions

`src/core/auth/permissionCatalog.ts` is the single source of every permission (exported as `GET /api/v1/permissions/catalog`); `src/core/auth/access.ts` resolves and checks them; `src/modules/permissions` manages roles and overrides. Contract for the web and mobile apps: `../PERMISSIONS_API.md`.

- **Keys** `<module>.<resource>.<action>` (view / create / edit / approve / manage), e.g. `labor.settlement.approve`, `cashbook.expense.create`, `procurement.dispatch.create`, `billing.invoice.view`. Each has a module, labels in English / Roman Urdu / Urdu, a description and flags: `ownerOnly` (never grantable: `company.settings.manage`, `subscription.manage`), `scoped` (project data: a grant is `ASSIGNED_PROJECTS` or `ALL_PROJECTS`), `limit` (approve keys accept `maxAmountPaisa`).
- **Field permissions** `fields.rates` (material / supplier / sub-contract rates, purchase amounts, stock values, supplier balances), `fields.amounts` (billing money, receivables, money KPIs), `fields.profit` (P&L, margins), `fields.contract` (contract value, rate, stage amounts). Serializers strip by them through one helper (`core/auth/fieldStrip.ts` — `visible()` / `stripFields()`), on REST and in the sync serializers.
- **Resolution**: THEKEDAR → every key, all projects, no limits. Others → the **union of their roles** (a member may hold several: `UserRoleAssignment`; a key in several roles gets the widest scope and the highest approval limit, "no limit" wins) + ALLOW overrides − DENY overrides (owner-only keys never). Resolved per request in `tenantContext` and cached per user; the cache key is `User.permVersion` + the `Role.version` of every assigned role (bumped by every change), so a change applies on the **next request** on every API instance (refresh also recomputes). The JWT `perms` claim now only carries the short legacy list — the full set (~100 keys) would bloat the cookie and could go stale.
- **Tables** (migration `20261019090000_permissions`, RLS + grants): `Role` (key, name / nameRoman / nameUrdu, `isSystem`, `baseRole` PM / MUNSHI / OTHER, version), `RolePermission` (key, scope, maxAmountPaisa), `UserPermissionOverride` (ALLOW / DENY, scope, limit, note), `User.roleId` (the primary role) + `permVersion`, `Invitation.roleId`. Migration `20261025090000_user_role_assignments`: `UserRoleAssignment` (tenantId, userId, roleId, position; RLS + grants; backfilled from `User.roleId`) and `Invitation.roleIds`. Migration `20261024090000_invitation_permission_overrides`: `Invitation.permissionOverrides` (JSONB `[{ key, effect, scope, maxAmountPaisa, note }]`).
- **System templates per company** (read-only; duplicate to change): **Administrator** (`ADMINISTRATOR`, office accounts) = every key except the owner-only ones, all projects, no limits, all amounts; **Project Manager** = exactly the old PM rights without financials; **Munshi** = the old MUNSHI rights; **Accountant** (billing, payments, cash, receivables, reports — all projects) and **Store Keeper** (purchases, receiving, dispatch, store, counts, usage — no rates). The old `canSeeFinancials` = the *financial bundle* (`billing.invoice.view|create`, `billing.payment.view|create`, `finance.pnl.view`, `fields.amounts|profit|contract`) as ALLOW overrides; `PATCH /users/:id { canSeeFinancials }` and invites still accept the flag and write those overrides (the column is kept in step for old clients).
- **Provisioning**: sign-up, admin company create and the seed call `provisionPermissions()`; existing companies: `npm run backfill:permissions` (idempotent; re-syncs system templates to the code, assigns templates, migrates `canSeeFinancials` PMs). Until it runs, a user without a role resolves to the code template (+ the bundle when `canSeeFinancials`), so access never changes.
- **Scope**: `projectScope(caller, key)` / `assertProjectScope(tx, key, projectId)`: assigned projects, or all with `ALL_PROJECTS` (outside → 404 as before).
- **Approval limits**: kharcha approve (`cashbook.expense.approve`), top-up approve, settlement approve (net), measurement verify (value), invoice issue (total), supplier payment (`amountFrom` on the route) → above the limit `403 APPROVAL_LIMIT_EXCEEDED { permission, maxAmountPaisa, amountPaisa }`. Also enforced through `/approvals/bulk` and sync push (the services check).
- **Account-type rules that stay with `User.role`** (not permissions): a MUNSHI marks hazri at most 7 days back, gives peshgi / pays wages from site cash only, gets blind count on receiving, sees only their own cash in day summaries; office seats count THEKEDAR + PM accounts.
- **Sync**: `/sync/pull` returns `access` (same as `/auth/me`), pulls only tables the caller may view (`TABLE_PERMISSIONS`) and strips fields by field permissions; a permission change records a `UserAccess` change → the next incremental pull answers `resetRequired`. `/sync/push` maps each mutation type to its key (`MUTATION_PERMISSIONS`); missing → `REJECTED` `PERMISSION_DENIED`.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /permissions/catalog` | any company user | modules, keys (labels, flags), templates, financial bundle |
| `GET /roles` · `GET /roles/:id` | THEKEDAR or `team.member.manage` | with permissions and user count |
| `POST /roles` | same | `{ name, nameRoman?, nameUrdu?, description?, baseRole?, fromRoleId?, permissions? }`; audit `role.create` |
| `POST /roles/:id/duplicate` | same | the way to edit a system template |
| `PATCH /roles/:id` | same | names / base role; system → `403 ROLE_IS_SYSTEM`; audit `role.update` |
| `PUT /roles/:id/permissions` | same | full list `[{ key, scope?, maxAmountPaisa? }]`; audit `role.permissions_update` (before / after) |
| `GET /users/:id/permissions` | same | effective keys with source (owner / role / override), scope, limit; overrides; denied |
| `PUT /users/:id/permission-overrides` | same | full list `[{ key, effect: ALLOW or DENY, scope?, maxAmountPaisa?, note? }]`; audit `user.permissions_update` |
| `PUT /users/:id/roles` | same | `{ roleIds }` (1–20; the first = primary) — several roles, each must fit the account (`ROLE_NOT_FOR_ACCOUNT`, `DUPLICATE_ROLE`); audit `user.role_change` (before / after lists) |
| `PATCH /users/:id/role` | same | `{ roleId }` = one role; base role must fit the account; audit `user.role_change` |

Rules: never a THEKEDAR (`403 CANNOT_EDIT_OWNER`), never owner-only keys (`OWNER_ONLY_PERMISSION`); a non-owner manager can't change their own permissions (`CANNOT_EDIT_OWN_PERMISSIONS`) and can only grant what they hold, scope and limit included (`GRANT_EXCEEDS_OWN`). Validation: `UNKNOWN_PERMISSION`, `SCOPE_NOT_SUPPORTED`, `LIMIT_NOT_SUPPORTED`, `DUPLICATE_PERMISSION`, `ROLE_NOT_FOR_ACCOUNT`, `ROLE_NAME_TAKEN`. Invitations accept `roleIds` (or `roleId`; default: the template of the invited role) and `permissionOverrides` (validated like `PUT /users/:id/permission-overrides`, stored on the invitation); accepting assigns every role and writes the overrides in the same transaction (audit `user.permissions_update`, `via: invitation`). `/auth/me`, login results and sync `access` carry `permissionRoles[]` next to `permissionRole` (the first).

`tests/permissions/parity.test.ts` calls every company route (enumerated from the Express app — `listRoutes()`, `src/core/http/routeList.ts`) as THEKEDAR, PM, PM with financials and MUNSHI and compares with `parity.snapshot.json`, recorded from the code before permissions existed.

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

`src/core/plan/planLimits.ts` — `getUsage`, `getLimits`, `assertWithinLimit(tx, tenantId, 'activeProjects' | 'officeUsers', adding = 1)` → `402 PLAN_LIMIT_REACHED { resource, limit, used }`; `null` limit = unlimited. Office users = active THEKEDAR + PM **+ pending PM invitations** (they reserve a seat); Munshis never count. Accepting an invitation uses `countPendingInvites: false` because that invite already holds its seat. Hold `lockPlanUsage(tx, tenantId)` around check-then-create. Team (invites, promote, reactivate) and invitation accept use it; the Projects module must call it for `activeProjects`. The demo project (`isDemo`, "Try with demo data") is never counted.

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

The super admin can view, add, edit and delete anything in any company — **direct, full access** (owner decision): no request, no reason, no read-only mode, no write-mode switch, no expiry, and the company is not notified. It goes through the **company's own API**, so every rule, calculation and delete check is the same as for the owner. The admin console sends the admin's own token plus `X-Act-As-Tenant: <companyId>` to the normal company routes (`src/modules/auth/actAs.ts`, `authenticate`):

- The admin token must be a live platform session of an active admin (logout or deactivation ends it at once); a company token with the header is refused (401). Unknown company → 404, a malformed id → 400.
- `X-Act-As-Session` (from the former support-session flow) is accepted and ignored. The `/admin/act-as-sessions` endpoints are gone; the `ActAsSession` table stays for history (nothing writes to it any more).
- **Silent audit trail only:** every change made inside the company is in its audit log with `actorType PLATFORM_ADMIN`, `actorId` = the real admin and `details.actingAsCompany = true` + `details.adminName`. Opening a company and reading leave no row. The owner reads the log at `GET /company/audit-logs` (`company.audit.view`, owner-only): `actor.name` "Platform support · <admin>", `platformSupport { sessionId, adminName, reason }` (`sessionId` / `reason` only on older rows), filters `actorType`, `action` prefix, `from` / `to`.
- The request runs as the company's hidden **"Super Admin (Platform)"** user (`User.isSystem`, role THEKEDAR, every permission), created the first time. It is `INACTIVE` so it can never sign in, and it is kept out of the team list, plan seat counts, owner SMS and notifications.
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
| `GET /labor-rates` · `PUT` | all · THEKEDAR | Upsert by kind + key; keys must match the kind (`INVALID_LABOR_KEY`; DAILY also accepts the company's own worker type keys), DAILY is per DAY; rows include `labelRoman`, `labelUrdu`, `isActive` |
| `GET /worker-types?includeInactive` | all | The company's worker types = its DAILY labour rates: `{ id, key, label, labelRoman, labelUrdu, ratePaisa, overtimeMultiplier, isActive, workerCount }`, active first then by name |
| `POST /worker-types` · `PATCH /:id` | THEKEDAR | `{ label, labelRoman?, labelUrdu?, ratePaisa, overtimeMultiplier? (1.5) }`; key generated from the English name (UPPER_SNAKE, `_2` … on a clash, never OTHER); `409 WORKER_TYPE_EXISTS` for the name of another active type; PATCH = names / rate / overtime / `isActive` (no delete; deactivating never touches workers) |
| `GET /payment-templates` · `POST` · `PATCH /:id` · `DELETE /:id` | THEKEDAR, PM · THEKEDAR | 1–15 stages, total exactly 100 (`400 PERCENT_TOTAL_INVALID { total }`), one retention stage max, default can't be deleted |
| `GET /suppliers` · `GET /:id` | THEKEDAR, PM | search (name / city / phone), category, isActive, page; detail has current agreed rates |
| `POST /suppliers` · `PATCH /:id` | THEKEDAR, PM | `409 SUPPLIER_EXISTS`; landline allowed |
| `POST /suppliers/:id/deactivate` · `/activate` · `PUT /:id/rates` | THEKEDAR | Rate history row only when changed; `GET /:id/rates` (THEKEDAR, PM) = current + history |
| `GET /workers` · `POST` | all · THEKEDAR, PM, MUNSHI | `type` = an ACTIVE worker type key or OTHER (`400 INVALID_WORKER_TYPE`); `dailyRatePaisa` defaults from the type's rate (OTHER → `DAILY_RATE_REQUIRED`); `409 WORKER_PHONE_TAKEN`; rows have `typeLabel`, `typeLabelRoman`, `typeLabelUrdu` |
| `PATCH /workers/:id` · `/deactivate` · `/activate` | THEKEDAR, PM | A new `type` must be active; a worker may keep a type deactivated since |
| `GET /subcontractors` · `POST` · `PATCH /:id` · `/deactivate` · `/activate` | all · THEKEDAR, PM | trade = a SUBCONTRACT key; `409 SUBCONTRACTOR_EXISTS` |

**Platform catalog** (`/api/v1/admin`): `GET /material-groups`, `GET /materials` (`groupId`, `search`, `supplyCategory`, `isActive`; `companies` = copies), `POST /materials` (`pushToTenants` default true → copied into every company; a company with a material of the same name keeps its own; `409 PLATFORM_MATERIAL_EXISTS`), `PATCH /materials/:id` (name / unitDetail / altUnits propagate only to copies with `isCustomised = false` whose company has no other material with the new name; unit is immutable).

Audit actions: `material.*`, `quality_category.*`, `price_list.update`, `price_list.bulk_percent`, `labor_rates.update`, `worker_type.create` / `.update` / `.activate` / `.deactivate`, `payment_template.*`, `supplier.*`, `supplier.rates_update`, `worker.*`, `subcontractor.*`, `admin.catalog_material_created` / `_updated`.

**Seed (Malik & Sons).** Rates A+ / A / B with specifications: cement 1,550 / 1,450 / 1,350 (plus an older A rate 1,400), bricks 19 / 17 / 14, steel #4 2,95,000 / 2,85,000 / 2,70,000, Chenab sand 85 / 70 / 60, bajri 190 / 180 / 165, floor tiles 450 / 220 / 140, PPR 1" 420 / 320 / 250, wire 7/29 14,500 / 11,800 / 9,500. Templates Residential standard (default), Labor-only monthly, Commercial. Suppliers Al-Madina Cement Agency (cement 1,430), Ittefaq Steel Traders, Chaudhry Bricks Kiln, Bilal Traders, Punjab Shuttering Yard. 14 workers (Pervaiz inactive) and 6 sub-contractors. Other companies get only the copied defaults.

## Onboarding & data import

`src/modules/onboarding` (Pilot · Part 7). Migration `20261022090000_onboarding`.

### Setup checklist (owner, `company.settings.manage`)

- `GET /onboarding/checklist` → `steps` LOGO (company logo), RATES (any rate / worker-type change in the audit log, or confirmed with `POST /onboarding/checklist/rates-reviewed`), TEAM (a PM / munshi or any invitation), WORKERS, SUPPLIERS, PROJECT — each `{ key, done }`, computed from the company's data with **demo data excluded** — plus `completed / total / percent / allDone`, `dismissed`, `counts` and `demo` (the demo project, if any).
- `POST /onboarding/checklist/dismiss { dismissed: true|false }` hides / shows the card for the whole company (`TenantSettings.onboardingDismissedAt`, audited).

### Excel / CSV import

Workers, sub-contractors, suppliers, custom materials and clients; each needs the permission of its own create endpoint.

| Endpoint | What |
|---|---|
| `GET /imports/:entity/template` | .xlsx (lazy-loaded exceljs): sheet **Data** = headers "English (Roman Urdu)", a note on each header in English / Roman Urdu / Urdu, phone / NTN columns as text, one example row; sheet **Instructions** = every column in three languages + the company's allowed values (worker types, trades, material groups). |
| `POST /imports/:entity/preview` | multipart `file` (.xlsx or UTF-8 .csv, ≤ 2 MB, ≤ 1000 rows). Headers match by key or any of the three labels; unknown columns are listed; rows containing "(example" are skipped. Every row is validated with the create endpoint's own Zod schema plus the create service's rules (active worker type, daily rate when the type has none, unique phone / name — against the company **and** within the file, material group). Returns every row with `errors: [{ column, message }]`. Writes nothing. |
| `POST /imports/:entity/commit` | The same file again. **All-or-nothing** by default: any row with an error → `400 IMPORT_HAS_ERRORS` (`details.rows`) and nothing is written; `?skipInvalid=true` imports only the valid rows. One transaction (60 s), bulk insert, one audit row `import.<entity>` with the new ids. |

Decision: **re-upload on commit, no server-side preview cache** — nothing is stored between requests, it works behind several API instances, and the rows are re-checked against the data as it is at commit time (a row someone added meanwhile → `409 IMPORT_CONFLICT`). Master data has no plan limits (plans limit active projects and office users only), so imports never hit 402. File errors: `FILE_REQUIRED`, `FILE_TOO_LARGE`, `INVALID_FILE`, `INVALID_FILE_TYPE`, `EMPTY_FILE`, `TOO_MANY_ROWS`, `MISSING_COLUMNS`.

### Opening balances (`company.opening.manage`)

New permission key — not in any template; the owner holds it and can grant it (e.g. to an accountant). One `OpeningBalance` row per item (`unique (tenantId, kind, entityId)`; app_user SELECT + INSERT only), **locked once saved** (`409 OPENING_LOCKED`), audited `opening_balance.create`. The money goes into the existing ledgers so balances, ageing, stock value, cost and reports include it:

| `kind` | Item | Posted as |
|---|---|---|
| `SUPPLIER_UDHAAR` | supplier | `SupplierLedgerEntry` type `OPENING` (existing type) → udhaar balance, FIFO ageing, cash-flow |
| `CASH_IN_HAND` | munshi / PM (never the owner) | `CashEntry` type `OPENING` (new enum value), POSTED, in the holder's cash account → balance, cash floats |
| `STORE_STOCK` | material + `quantity` + `ratePaisa` | `StockMovement` type `OPENING_IN` (new) at the Central Store → store stock, average cost, stock valuation |
| `WORKER_PESHGI` | worker + `projectId` | `Advance` paid from OFFICE_CASH on that project (the worker must be on its team) → cut from the next wages, project cost |

`GET /opening-balances?kind=` lists them with item name, project, who / when.

### Try with demo data (owner, `company.settings.manage`)

- `POST /demo` creates ONE demo project (`isDemo`, code `DEMO-001`, names start with "DEMO ·") through the real services: a client, a supplier, 4 workers on site, 6 days of hazri, a site purchase on udhaar (received → site stock + supplier ledger), an inactive "DEMO · Site cash" book with a float and 4 kharcha, and a **draft** invoice. `409 DEMO_EXISTS` for a second one.
- **Bounded, not counted:** the demo project never counts against `maxActiveProjects` (`planLimits`, plan fits / parking, admin usage filter `isDemo: false`), and uses no real document number (the purchase number is given back and renamed `DEMO-PUR-1`; the invoice stays a draft).
- `DELETE /demo` removes everything in one transaction through the SECURITY DEFINER function `purge_demo_data()` (scoped to the caller's `app.tenant_id`; it also deletes from the append-only ledgers) — no leftovers in ledgers, stock or cash; audit rows are kept; challan files are deleted after commit. Refused with `409 DEMO_IN_USE` (`details.uses`) while real data uses the demo: a dispatch to / from the demo site, real cash entries on the demo project, demo workers / supplier / client on real projects or stock.
- Project, worker, supplier and client DTOs carry `isDemo`.

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
| 2 Contract | `PATCH /:id/contract` | `contractValuePaisa` (FULL / GREY_OWNER_FINISHING) and `ratePerSqftPaisa` (LABOR_ONLY) are **optional while DRAFT** — usually set after the estimate (step 6, `POST /:id/contract/from-estimate`); the review's `CONTRACT_VALUE_MISSING` blocks activation instead. Omitted = unchanged (same contract type), `null` = cleared. Once not DRAFT a save that leaves no value → `400 CONTRACT_VALUE_REQUIRED` / `RATE_REQUIRED`. **RUNNING_BILLS** on any contract type keeps `ratePerSqftPaisa` as the billing rate per sq ft of progress (review error `RUNNING_BILLS_RATE_MISSING` without it; required once active); a stage schedule drops it for FULL / GREY. Stage amounts are 0 while the total is unknown and recompute when it is set. A user without `fields.contract` can save the tab (values hidden, omitted). Retention 0–10 %, defect 0–24 months. **Supply rules** start from the contract-type preset (`GET /supply-presets`: FULL all contractor; GREY → cement, bricks, steel, sand & bajri, pipes by contractor; LABOR_ONLY all owner) with the default quality category on contractor rows; `supplyRules` override categories (CONTRACTOR needs `qualityCategoryId`, OWNER must not have one); rows with `lockedAt` → `409 SUPPLY_RULE_LOCKED`. **Billing stages** from `billingStages`, `templateId`, or the company default template on first save; exactly 100 % (`PERCENT_TOTAL_INVALID {total}`), one retention max. |
| 3 Plot & structure | `PATCH /:id/plot-structure` | MARLA / KANAL / SQFT, marla standard 225 / 272.25, front × depth, corner, FRAMED / LOAD_BEARING, basement (+height). Floors upserted by level (GROUND required, BASEMENT only with a basement); dropping a floor with rooms → `409 FLOOR_HAS_ROOMS` unless `force: true`. Optional **`foundation`** (bunyaad, see below): omitted = unchanged, `null` = cleared. Optional **`floors[].roof`** (roof / lenter over that floor, see below): omitted = unchanged, `null` = cleared; each floor in the response carries `roof` and `slabSuggestion`. |
| 4 Coverage | `PATCH /:id/coverage` | covered (> 0), semi-covered, open; boundary length / height / thickness (4.5″ / 9″) / plaster sides required with a boundary wall. |
| 5 Rooms | `POST /floors/:id/rooms`, `PATCH·DELETE /rooms/:id`, `POST /rooms/:id/openings`, `PATCH·DELETE /openings/:id`, `POST /floors/:id/copy`, `GET /projects/:id/floors`, `PUT /rooms/:id/walls`, `POST /floors/:id/walls/auto` | Height defaults to the floor ceiling; name defaults to the type ("Bedroom 2"); bath / powder room / kitchen are wet unless overridden (`isWet`, `null` = automatic). Openings larger than the walls → `400 OPENINGS_EXCEED_WALL`; an opening may name its wall `side` (TOP / RIGHT / BOTTOM / LEFT, `null` = not placed) and must then fit that wall (`details.side`). **Walls** per room side (see below), also accepted as `walls` on room create. Copy takes the target's ceiling height and copies opening sides + walls (shared pairings re-pointed at the copies); non-empty target needs `replace: true` (`409 FLOOR_NOT_EMPTY`). |
| 6 Review | `GET /:id/review` | `{ ready, errors[], warnings[], summary }`. Errors: missing tab fields, stages ≠ 100 %, no GROUND floor, no rooms, contract value / rate missing (`CONTRACT_VALUE_MISSING`, tab 2), running bills without a rate (`RUNNING_BILLS_RATE_MISSING`, tab 2). Warnings: plot vs front × depth > 10 %, room area vs covered > 15 % ("walls and passages"), no foundation entered (`FOUNDATION_MISSING`, tab 3), no PM, no Munshi, end < 3 months after start. |

Each wizard PATCH validates its section, saves, adds the tab to `wizardCompletedSteps` and returns the full project.

### Foundation (bunyaad) — `projects/foundation.ts`

Stored in one nullable JSONB column `Project.foundation` (migration `20261026090000_project_foundation`); `null` = not entered, so older projects stay valid. Validated with zod on the way in and normalised so every key is always present (null where it doesn't apply to the type). All values are numbers in fixed units (ft / in / mm / count) so the Phase 2 material estimate can read them. Returned as `foundation` on `GET /projects/:id` and every wizard response (not in the Munshi basic view) and as `summary.foundation` in the review. Same permission (`projects.project.edit`) and lock (DRAFT / ACTIVE, else `409 PROJECT_LOCKED`) as the rest of tab 3. Not synced to phones (the project sync row carries only the basic fields).

| Field | Range / values | Applies to |
|---|---|---|
| `type` | STRIP (wall footing), ISOLATED (column footing), COMBINED, RAFT (mat), PILE | always |
| `excavationDepthFt` · `footingThicknessIn` · `plinthHeightFt` · `dpcThicknessIn` | 1–30 ft · 3–36 in · 0–6 ft · 0.5–6 in; excavation ≥ PCC + footing thickness | always |
| `footingWidthFt` | 1–20 ft (strip width, or pad W) | STRIP, ISOLATED, COMBINED |
| `footingCount` · `footingLengthFt` | 1–500 (whole) · 1–20 ft | ISOLATED, COMBINED |
| `pileCount` · `pileDiameterIn` · `pileDepthFt` | 1–1000 · 6–60 in · 5–150 ft | PILE |
| `masonry` · `pccMix` · `pccThicknessIn` | BRICK / STONE / RCC_ONLY · 1:4:8 / 1:3:6 / 1:2:4 · 2–12 in | always |
| `rccMix` · `mainBarMm` | 1:2:4 / 1:1.5:3 · 10 / 12 / 16 / 20 (#3–#6) | every type except a BRICK / STONE strip footing |
| `termiteTreatment` · `dpcMaterial` | default true · BITUMEN / PCC_WATERPROOF (default) | always |
| `soilType` · `waterTableDepthFt` · `dewateringNeeded` · `soilTestDone` · `soilTestNote` · `notes` | HARD / MEDIUM / SOFT / SANDY / FILLED / CLAY · 0–300 ft · bool · bool · ≤ 300 chars (kept only with a test) · ≤ 1000 chars | optional |

The wizard has no attachment slot anywhere, so the soil test report is a note (lab, report number, bearing capacity) rather than a file.

### Roof / slab (lenter, chhat) per floor — `projects/roof.ts`

Stored in one nullable JSONB column `Floor.roof` (migration `20261028090000_roof_walls`): the roof over that floor. `null` = not entered → the estimate keeps the % method of the estimate settings for that floor. Sent as `floors[].roof` of `PATCH /projects/:id/plot-structure` (strict zod; only `type` is required — everything else gets the Pakistani default) and normalised so every key is present (null where it doesn't apply to the type). Returned on every floor of `GET /projects/:id`, the wizard responses and `GET /projects/:id/floors`, with `slabSuggestion`.

| Field | Default · range | Applies to |
|---|---|---|
| `type` | `RCC_SLAB` (lenter) · `T_IRON_TILE` (garder / T-iron + bricks or tiles) · `PRECAST` (hollow-core planks) · `STEEL_DECK` | always |
| `concreteMix` · `steelGrade` | 1:2:4 (1:1.5:3) · G60 (G40 — price-list lookup) | always (slab / topping / screed, beams, columns) |
| `thicknessIn` | 5 · 3–12 in | RCC |
| `mainBar` @ `mainSpacingIn` | #4 (12 mm) @ 6″ · bars 3–6 (#3 = 10, #4 = 12, #5 = 16, #6 = 20 mm), spacing 3–18″; along the short span | RCC |
| `distBar` @ `distSpacingIn` | #3 (10 mm) @ 9″ | RCC |
| `topBars` · `coverIn` | true (extra top bars over the supports) · 0.75″ (0.5–2; recorded — bars run into the walls, so quantities don't use it) | RCC |
| `chajjaLengthFt` × `chajjaWidthFt` | none × 2 ft (1–4) — sunshade | RCC |
| beams `beamWidthIn` × `beamDepthIn`, `beamBars` × `beamBar`, `stirrupBar` @ `stirrupSpacingIn`, `beamRunFt` | 9 × 15″ (depth > slab), 4 #5, #3 @ 6″, run = the floor's wall run | every type, used for FRAMED |
| columns `columnCount`, `columnWidthIn` × `columnDepthIn`, `columnBars` × `columnBar`, `tieBar` @ `tieSpacingIn` | from the footprint, 12 × 12″, 6 #5, #3 @ 6″; height = the floor height | every type, used for FRAMED |
| `tIronSection` · `tIronSpacingFt` · `infill` · `screedThicknessIn` · `earthFillIn` | G5X3 (T3X3 2.7 · T4X4 4.5 · G4X3 4.5 · G5X3 5.0 · G6X3 5.4 kg/ft) · 3 ft (1–6) · BRICK / TILE · 3″ · 4″ | T_IRON_TILE |
| `plankAreaSqft` / `deckAreaSqft` · `toppingIn` · `mesh` | the footprint · 2″ precast / 4″ deck (average over the flutes) · true | PRECAST / STEEL_DECK |

**Suggestion** (`slabSuggestion { spanFt, suggestedIn, minIn, beamAdvised }`, by the floor's largest room short span): ≤ 12 ft → 4.5–5″ (5″), 12–15 ft → 5″, 15–18 ft → 6″, > 18 ft → 6–7″ or a beam across the room. **Soft warnings** (saved anyway; the estimate lists them for tab 3): `ROOF_TOO_THIN` (thickness below the minimum), `ROOF_SPAN_NEEDS_BEAM`, `ROOF_MAIN_SPACING_WIDE` / `ROOF_DIST_SPACING_WIDE` (spacing > min(12″, 2 × thickness)). Hard limits are `400 VALIDATION_ERROR` (spacing < 3″, unknown bar / type / field, beam not deeper than the slab).

### Walls per room side — `projects/walls.ts`, `walls.service.ts`

`Room.walls` (JSONB, null = not entered) holds exactly four sides `{ side, type, thicknessIn, innerLeafIn, cavityIn, sharedWithRoomId, sharedWithSide, existing }`; TOP / BOTTOM run along the room's length, LEFT / RIGHT along its width. `Opening.side` (enum `WallSide`, nullable) places a door / window in one of them.

| Type | Default thickness | Meaning |
|---|---|---|
| `EXTERNAL` | 9″ | outside wall |
| `SHARED` | 4.5″ RCC frame / 9″ load-bearing | wall with another room on the same floor (`sharedWithRoomId`) — counted once |
| `PARTY` | 9″ | boundary with the neighbour; `existing: true` = already built → no brickwork, not in the foundation |
| `DOUBLE` | outer 9″ + cavity 2″ + inner 4.5″ | cavity wall (`innerLeafIn`, `cavityIn`) |
| `OPEN` | — | no wall |
| `PASSAGE` | 4.5″ | wall to a corridor / stair that is not entered as a room |

`PUT /rooms/:id/walls { walls: [4 sides] | null }` (projects.project.edit, DRAFT / ACTIVE) returns the whole floor with rooms. **Pairing:** a SHARED side sets the other room's matching side to SHARED back — `sharedWithSide` when given (must be free, else `409 WALL_SIDE_TAKEN`), else the side it already points from, else the opposite side if free, else the free side closest in length (none free → 409); a room without walls first gets four EXTERNAL sides; the thickness is copied. Changing or removing a pairing turns the other room's side back into EXTERNAL 9″; deleting a room does the same for every side that pointed at it. Sharing with itself or a room on another floor → `400 INVALID_SHARED_ROOM`. **Auto-set:** `POST /floors/:id/walls/auto { replace? }` gives every room without walls four EXTERNAL sides (room positions are unknown, so nothing is guessed as shared — the user marks the shared sides); `replace: true` resets every room (pairings cleared). Audits `project.room_walls { roomId, walls, paired[] }`, `project.floor_walls_auto { floor, rooms, replace }`.

### Calculations (`projects/calc.ts`, Decimal-safe, 2 dp)

- **Plot:** marla × standard; kanal = 20 marla; frontage = front × depth; `plotAreaMismatch` when they differ by > 10 %.
- **Room:** floor = L × W; gross wall = 2 × (L + W) × H; openings = Σ w × h × qty; net wall = gross − openings. (16 × 14 × 11 with a 3.5 × 7 door and a 5 × 4 window → 224 / 660 / 44.5 / 615.5.)
- **Floor / project totals:** rooms, total floor area, net wall area, wet rooms.
- **Billing amounts:** contract value × % (labour-only: rate × covered area), each rounded to the rupee, last stage absorbs the rounding; recomputed when the contract or covered area changes.

Audit actions: `client.create`, `client.update`, `project.create`, `project.delete`, `project.update_basic`, `project.team_update`, `project.update_contract`, `project.update_plot_structure` (details carry `foundation: <type> | null` when it was sent and `roofs: ["GROUND:RCC_SLAB", …]`), `project.update_coverage`, `project.room_*`, `project.opening_*`, `project.floor_copy`, `project.room_walls`, `project.floor_walls_auto`, `project.activate`, `project.status_change`.

**Seed.** Malik & Sons: 6 clients; DHA Phase 6 · 10 Marla (`MSB-2026-012`, ACTIVE, grey structure, Rs 1,85,00,000, full wizard with 17 rooms on Ground / First / Mumty, PM Bilal, Munshi Rafaqat), Johar Town · 5 Marla (`MSB-2026-008`, ACTIVE, PM Bilal), Bahria Town · 1 Kanal (`MSB-2026-014`, ACTIVE, basement, Munshi **Asif Mehmood** `03224567890` OTP), Valencia · 7 Marla (`MSB-2025-031`, HANDED_OVER, labour-only Rs 450/sq ft) and a DRAFT Model Town · 1 Kanal (tabs 1–2). Ahmed Constructions: Wapda Town · 5 Marla (`AC-2026-001`, ACTIVE). Older seed rows are renamed in place, so foreign keys survive.

## Estimate (BoQ) — rulebook, revisions and the full BoQ

`src/modules/estimate/`: `engine.ts` (pure grey-structure quantities + costing, no database — unit-tested in `tests/unit/estimateEngine.test.ts` with a hand-checked 5-marla example), `boq.ts` (pure BoQ builder: 14 sections, build stages, traces, lump sums, overheads, contingency — `tests/unit/estimateBoq.test.ts`, a hand-checked 10-marla example), `rulebookDefs.ts` (every rule-of-thumb number as a rulebook parameter: key, labels, unit, v1 value per region, safe range), `rulebook.ts` (the three layers), `settings.ts` (the per-project layer: engine settings + BoQ keys, ranges), `estimate.service.ts` (live estimate + preview), `revisions.service.ts` (saved revisions, compare, owner shopping list, PDFs), routes / controller / docs. `src/modules/rulebook/` = the company rulebook API; `src/modules/platform-admin/rulebook.*` = the admin versions. The live `GET /projects/:id/estimate` keeps its grey-structure shape and adds `boq` — a preview of what Generate would save. See [Rulebook, revisions and the full BoQ](#rulebook-revisions-and-the-full-boq-step-11).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/projects/:id/estimate` | `projects.estimate.view` (scoped) | `{ settings, defaults, customised[], basis, stages[4] { lines[], totals[], materialsPaisa, ownerSuppliedPaisa, missingRates }, materials[], labour, cost, warnings[] }`. A project without rooms / foundation answers 200 with warnings — DRAFTs included: the web wizard shows it as step 6 (before Review) while the project is being set up. Warning `tab`s are wizard tabs 1–5. |
| PUT | `/projects/:id/estimate/settings` | `projects.estimate.manage` (scoped) | Body = any of the settings below (strict, ranges checked → `400 VALIDATION_ERROR`). Replaces the stored overrides: fields left out go back to the default, `{}` resets. Only values that differ from the default are stored. DRAFT / ACTIVE only (`409 PROJECT_LOCKED`). Returns the recomputed estimate. Audit `project.estimate_settings_update` `{ code, changed[], reset }`. |

| POST | `/projects/:id/contract/from-estimate` | `projects.project.edit` + `fields.contract` + `fields.rates` (scoped) | Sets the contract value (labour-only: the rate) from the live estimate — see [Contract value from the estimate](#contract-value-from-the-estimate). Body `{ marginPercent?, finishingAllowancePercent?, replace? }`. Returns the full project. |

Templates: Administrator (all), Project Manager view + manage, Accountant view (all projects); Munshi / Store Keeper none. Visibility: rates, amounts, stage / labour money and `cost` need `fields.rates`; `cost.contractTotalPaisa` needs `fields.contract`; `cost.marginPaisa` / `marginPercent` need `fields.contract` + `fields.profit`. Quantities are visible to everyone with the view permission.

Each line: `stage` FOUNDATION / WALLS / RCC / PLASTER, `floor` (null for the foundation), `element`, `kind` WORK (a volume / area / shuttering measurement) or MATERIAL, `material`, `netQuantity`, `wastagePercent`, `quantity` (with wastage = what to order), `unit`, `formula` `{ key, params }` + `formulaText` (English), and with `fields.rates`: `ratePaisa`, `rateUnit`, `rateQuantity` (quantity in the rate's unit), `amountPaisa`, `rateStatus` OK / RATE_MISSING / UNIT_MISMATCH, `suppliedBy`.

Warnings: `NO_FLOORS`, `NO_ROOMS` (tab 5), `FOUNDATION_MISSING` (tab 3 — foundation stage empty), `STRUCTURE_TYPE_ASSUMED` (RCC frame assumed), `COVERED_AREA_ESTIMATED` (rooms + 15 %), `FOUNDATION_LENGTH_UNKNOWN`, `ROOMS_BELOW_COVERED { percent }` (rooms < 70 % of the covered area — walls / plaster under-counted, tab 5), `RATES_MISSING { materials[] }` (contractor-supplied materials without a usable rate — left out of every total), `LABOUR_RATES_MISSING { items[] }`, `CONTRACT_VALUE_MISSING`, `CONTRACT_INCLUDES_FINISHING` (FULL contracts: the contract also covers finishing).

### Contract value from the estimate

The contract value is usually agreed **after** seeing the estimate, so tab 2 can be saved without it while DRAFT. `GET /projects/:id/estimate` returns `contractSuggestion` (needs `fields.contract` + `fields.rates`; null before a contract type is chosen):

| Contract | Suggestion | Rounding |
|---|---|---|
| FULL | value = cost × (1 + finishing %) × (1 + margin %) — the estimate is grey structure only, so a finishing allowance can be added | nearest Rs 1,000 |
| GREY_OWNER_FINISHING | value = cost × (1 + margin %) | nearest Rs 1,000 |
| LABOR_ONLY | rate = estimated labour × (1 + margin %) ÷ covered sq ft (the owner buys the material) | nearest Rs 5 |

`cost` = contractor-supplied materials + labour (owner-supplied material is never in it). Margin and finishing allowance come from the **company settings** (`defaultMarginPercent` 0–100, default 20; `defaultFinishingAllowancePercent` 0–200, default 0 — `PATCH /company/settings`) unless the project has its own (`Project.marginPercent` / `finishingAllowancePercent`, null = follow the company); `marginSource` / `finishingSource` say which (COMPANY / PROJECT). Pure maths in `estimate/contractValue.ts` (unit-tested), the web card recomputes the same numbers live.

`POST /projects/:id/contract/from-estimate { marginPercent?, finishingAllowancePercent?, replace? }` applies it: contract type, billing model, supply rules and stages stay; stage amounts recompute. Omitted percentages = the project override, else the company default. A percentage different from the company default is stored on the project (it sticks for the next suggestion); one equal to it clears the override. An existing value is overwritten only with `replace: true` (`409 CONTRACT_VALUE_EXISTS { currentPaisa, suggestedPaisa }` otherwise — the web asks the user first). `400 CONTRACT_MISSING` (no contract type), `400 ESTIMATE_COST_MISSING` (no cost / labour / covered area), `409 PROJECT_LOCKED`. Audit `project.contract_from_estimate` `{ code, contractType, kind, costPaisa, coveredAreaSqft, marginPercent, marginSource, finishingAllowancePercent, valuePaisa, previousPaisa }`. Migration `20261029090000_contract_margin_defaults`.

**Decision — a dedicated endpoint, not the full contract PATCH**: the PATCH needs the contract type, billing model, supply rules and stages and would re-apply presets on a type change; the dedicated endpoint changes only the value, computes it server-side from the same estimate the user saw (so the audit trail records the cost, margin and finishing used), and enforces the "no silent overwrite" rule with `replace`. **Decision — per-project override in columns, not `estimateSettings`**: `PUT /estimate/settings` replaces that JSON wholesale and its defaults are platform constants, while the margin defaults belong to the company; two nullable columns keep them independent.

### How the estimate is calculated

Units: ft, sq ft, cft (inches only in settings). **Every number below is a rulebook parameter** resolved in three layers — (1) the platform rulebook: the highest PUBLISHED version for the company's region (`Tenant.region`: PUNJAB_KP or KARACHI_SINDH; built-in v1 when none is published), (2) the company's own value (`PUT /rulebook/overrides`, inside the parameter's safe range), (3) the project's own value (`PUT /projects/:id/estimate/settings`). The bold values are Punjab v1; the ranges in brackets are what the project API accepts (rulebook safe ranges are narrower — `GET /rulebook`). Karachi / Sindh v1 differs in: concrete blocks (`blockMasonry` 1, 1.125 blocks per sq ft of wall face), 6″ external / 4″ internal walls, 6″ lintels, 0.10 cft mortar per cft.

**Materials (dry-volume method)**
- Concrete: dry volume = wet volume × **1.54** (1.2–1.7). Mix *c : s : a* → cement = dry × c / (c+s+a) ÷ **1.25 cft per 50 kg bag** (1–1.5); sand = dry × s / Σ; crush = dry × a / Σ. RCC mix **1:2:4** (or 1:1.5:3); foundation PCC and RCC footings use the foundation's own `pccMix` / `rccMix`; DPC is always 1:2:4.
- Brickwork: **13.5 bricks per cft** with mortar (10–16); wet mortar **0.25 cft per cft** of brickwork (0.15–0.4) × **1.33** dry factor (1.1–1.6), mix **1:6** (1:3 – 1:8) → cement = dry / 7 ÷ 1.25 bags, sand = dry × 6/7.
- Plaster: area × thickness ÷ 12 × 1.33, mix **1:6** internal + ceilings (**0.5″**; Phase 1 default was 1:4) and **1:4** external (**0.75″**; 1:6 option).
- Steel: concrete volume × steel % × **222 kg per cft** (7,850 kg/m³ ÷ 35.315; 1 % ≈ 2.22 kg/cft). Slab **1 %** (0.3–3), beams + columns **2.5 %** (0.8–6), lintels **1 %**, footings / raft / piles **0.8 %**.
- Wastage per material: bricks / blocks **5 %**, cement **2 %**, sand + crush **5 %**, steel **4 %**, tiles **7 %**, paint **5 %**, everything else **5 %** (`wastagePercent`; a project `wastagePercent` also covers cement / sand / steel unless those are set too — the Phase 1 meaning). Work lines (volumes, areas, shuttering) carry none.

**Walls and floors** (rooms are clear inside sizes; height = the floor's ceiling height)
- Σ room perimeters *P* counts every internal wall twice (once from each room) and every external wall once: *P = E + 2·I* → **internal run I = (P − E) ÷ 2**.
- **External run E** = perimeter of the floor footprint taken as a rectangle with the plot's front : depth ratio *r = depth / front* (square without dimensions): *E = 2 × (√(F / r) + √(F × r))*, capped at *P*.
- **Footprint F** of a floor = the project covered area shared over the floors by room area (rooms × 1.15 when the covered area is missing; covered ÷ floors when there are no rooms).
- Brickwork per floor = (E × H − windows & ventilators) × **9″** + (I × H − doors) × **4.5″** (doors are taken off internal walls, windows off external walls; lintels inside walls are not deducted).
- Roof parapet on the highest floor with rooms that is not the mumty: E × **3 ft** (0–6; 0 = none) × 4.5″, plastered both faces with the external mix.

**Stage 1 — Foundation** (needs the project foundation; wall run *L* = E + I of the lowest floor with rooms — or the detailed built wall run when every room there has its walls, see below — else the plot perimeter, or the `foundationWallLengthFt` setting; `basis.foundationWallLengthSource` SETTING / WALLS / ESTIMATED / PLOT; foundation walls are **9″** = the external wall thickness)
- Excavation: STRIP L × footing width × depth; ISOLATED / COMBINED / PILE a wall trench L × (9″ + 1 ft working space) × depth (+ pads N × l × w × depth); RAFT footprint × depth.
- PCC (lean concrete): the same plan area × PCC thickness, PCC mix.
- RCC: STRIP + RCC_ONLY L × width × thickness; pads N × l × w × thickness; raft footprint × thickness; piles N × π (d/2)² × depth (pile caps not included). Concrete in the foundation `rccMix` + steel at the footing %.
- Masonry to plinth (brick, or STONE → stone cft + the same mortar): brick / stone STRIP = stepped footing L × ((width − 0.5 ft) + 9″) / 2 × footing thickness + wall L × 9″ × (depth − PCC − footing + plinth); STRIP RCC_ONLY and RAFT walls from the RCC top (depth − PCC − footing + plinth); ISOLATED / COMBINED / PILE walls on their own strip PCC (depth − PCC + plinth).
- DPC: L × 9″ × DPC thickness, concrete 1:2:4 + **waterproofing compound 1 kg per cement bag** (PCC_WATERPROOF) or **bitumen 0.15 kg per sq ft** (BITUMEN).
- Termite (deemak) treatment: lowest-floor footprint × **0.005 L concentrate per sq ft** (1 L per 200 sq ft).

**Stage 2 — Walls**: brickwork per floor + parapet, as above (bricks + mortar cement / sand).

**Stage 3 — RCC**: roof slab over every floor = footprint × **5″** (4–9; 6″ for larger spans) → concrete, steel, shuttering = footprint (soffit). RCC frame only: beams + columns = **45 %** (0–100) of each floor's slab concrete, shuttering **4 sq ft per cft**. Lintels over every opening: Σ (width + **1 ft** bearing) × qty × **9″ × 6″**, shuttering length × (width + 2 × depth). The ground floor on grade, stairs, water tanks and boundary walls are not part of this estimate.

**Stage 4 — Plaster**: internal = Σ room 2 (L + W) × H − openings (both faces of internal walls + inner face of external walls); ceilings = Σ room floor areas; external = E × (H + slab) − windows; parapet both faces.

**Costing** — each material is priced from the company price list (rate history, current rate) in the project's quality category for its supply category (cement → CEMENT, bricks / stone → BRICKS, steel → STEEL, sand / crush → SAND_BAJRI, waterproofing / bitumen → WATERPROOFING; else the company's default category). Material: platform rulebook keys first (cement → Cement OPC / SRC, bricks → Class-1 / 2nd class, sand → Chenab / Ravi, crush → Margalla / Sargodha, steel → Grade-60 #4 / #3 / #5 / #6), then a name match among the company's own materials (`waterproof|compound`, `bitumen`, `termite|deemak`, `stone`); the first candidate with a rate wins. Quantities convert to the rate's unit (kg → ton ÷ 1000, nos → thousand ÷ 1000, cft → trolley ÷ 100, the material's alt units); no rate or no conversion → the line has no amount and the material is listed in `RATES_MISSING`. Owner-supplied categories are valued (`ownerSuppliedPaisa`) but not part of the contractor cost. **Labour** (`includeLabour`, default on): covered area × `labourRatePerSqftPaisa` when set; else the company SUBCONTRACT piece rates on the net work — BRICK_MASONRY per brick, PLASTER per sq ft of plaster, SHUTTERING per sq ft, STEEL_FIXING per ton (excavation and concreting labour are not included). **Cost** = contractor materials + labour; per sq ft = cost ÷ covered area; margin = contract total (contract value, or rate × covered area for labour-only) − cost, and % of the contract.

**DETAILED vs ESTIMATED.** Every line carries `method`. A floor whose rooms **all** have their four walls entered gets its walls, lintels, plaster (and, on the lowest floor, the foundation run) from the actual sides — DETAILED; a floor with **roof** data gets its slab / roof, beams and columns from the actual bars and sizes — DETAILED. Anything else keeps the rules above (ESTIMATED), so projects without the new data estimate exactly as before. Some rooms of a floor with walls and some without → the floor stays ESTIMATED with warning `WALLS_PARTIAL { missing, rooms }` (tab 5; the "Auto-set walls" button fills the rest). `basis.methods { walls, roof }` = DETAILED / ESTIMATED / MIXED; `basis.floors[]` adds `wallsMethod`, `roofMethod`, `walls { partyWallFt, partyExistingFt, openFt, builtRunFt, byThickness[] { thicknessIn, lengthFt, areaSqft, volumeCft, bricks } }` and `roof { type, thicknessIn, largestSpanFt, steelBySize[] { bar, mm, kg }, bars[] { use, bar, mm, count, lengthFt, label }, beamRunFt, columnCount, columnCountAuto }`.

**Detailed: walls** (`estimate/detailed.ts → detailedWalls`; side length = room length for TOP / BOTTOM, width for LEFT / RIGHT; height = the room's height — the clear height to the slab soffit, so the slab is not taken off again)
- Openings with a `side` are taken off that wall; openings without one are spread over the room's walls (non-OPEN sides) in proportion to their length. An opening on an OPEN side takes nothing off.
- SHARED pair (both rooms point at each other): counted **once** — length = the shorter of the two sides, height = the taller room, minus the openings of both sides; the rest of the longer side (remainder) is a wall of the same thickness to an unmodelled space (plastered both faces). A SHARED side whose partner does not point back counts as a PASSAGE wall (warning `WALLS_UNPAIRED`).
- PARTY `existing` and OPEN: no brickwork, not in the foundation / beam run. DOUBLE: outer leaf + inner leaf, nothing for the cavity.
- Brickwork per leaf thickness: net area × thickness → one line per thickness (`WALLS.<floor>.walls.t9`, `.t4_5`, …) with bricks + mortar as above (13.5 bricks / cft for every thickness).
- Plaster: internal = every room's inside faces (non-OPEN sides, incl. the inner face of a party wall — the room is plastered even when the neighbour built the wall) + the far face of PASSAGE walls and remainders; external = outer face of EXTERNAL and DOUBLE walls × (H + slab thickness) − their openings; ceilings as before.
- External run = EXTERNAL + DOUBLE; internal run = SHARED (once) + PASSAGE + remainders; built run = external + internal + PARTY (not existing) → the foundation wall run (unless the setting overrides it) and the default beam run. Parapet on the main roof = (external + party built) × parapet height × 4.5″.
- Lintels: each opening (width + 1 ft bearing) × the thickness of its wall (both leaves of a DOUBLE; the `lintelWidthIn` setting when not placed) × `lintelDepthIn`; steel 2 #4 bottom + 2 #3 top + #3 stirrups @ 9″ (1″ cover) instead of 1 %.

**Detailed: roof** (`estimate/detailed.ts`; bar weight **kg/m = d² / 162** (d in mm) → kg/ft = 0.3048 × d² / 162: #3 0.1881, #4 0.2709, #5 0.4817, #6 0.7526; each bar size is its own material `steel10` / `steel12` / `steel16` / `steel20`)
- Panels = every room (clear L × W; the footprint rectangle when the floor has no rooms). Short span *s*, long side *l*.
- RCC_SLAB: concrete = footprint × thickness (roof mix); **main** bars = ⌈*l* × 12 ÷ spacing⌉ + 1, each *s* + 2 × anchorage; **distribution** = ⌈*s* × 12 ÷ spacing⌉ + 1, each *l* + 2 × anchorage; anchorage = max(12 × bar diameter, 6″) each end; **top bars** (if on) = main size at 2 × main spacing along both long supports: 2 × (⌈*l* × 12 ÷ (2 × spacing)⌉ + 1), each 0.25 × *s* + anchorage. Slab area outside the rooms (passages, stairs) = footprint − rooms × 1.15 gets steel at the rooms' rate (lengths × (1 + extra ÷ room area)). Shuttering = footprint (soffit). Sunshade: L × W × 4″ average; #3 @ 6″ across (W + 18″ anchorage) + #3 @ 9″ along; soffit shuttering L × W.
- T_IRON_TILE: per room ⌈*l* ÷ spacing⌉ − 1 garders (at least 1), each *s* + 2 × 9″ bearing × kg/ft of the section (table above) → `tIron` kg; infill over the footprint: bricks laid flat **3.2 / sq ft** or tiles 12″ × 6″ **2 / sq ft** (`roofTile`) on a 0.5″ 1:4 bed; screed = footprint × screed thickness (roof mix); earth filling = footprint × thickness (volume only, not priced). No shuttering.
- PRECAST / STEEL_DECK: planks / deck sheet area (`precastPlank` / `steelDeck`, sq ft); topping = area × topping (roof mix); mesh #3 @ 12″ both ways = 2 × area × 1.1 (laps) ft of #3. No shuttering.
- RCC frame (FRAMED, any roof type): beams = run × width × (depth − slab) (the slab part is in the slab), main bars = count × run × 1.05 (laps / anchorage), stirrups ⌈run × 12 ÷ spacing⌉ + 1 × (2 × ((w − 3″) + (d − 3″)) + 20 × bar diameter) (1.5″ cover, two hooks); beam sides 2 × run × (depth − slab) shuttering. Columns = count × w × d × floor height; bars count × bars × (height + slab + 50 × bar diameter lap); ties count × (⌈height × 12 ÷ spacing⌉ + 1) of the same stirrup length; shuttering count × 2 (w + d) × height. Default column count = (⌈a ÷ 15⌉ + 1) × (⌈b ÷ 15⌉ + 1) on the footprint rectangle a × b (25 × 45 → 12).
- Without roof data the slab stays footprint × `slabThicknessIn` with the % steel, and an RCC frame stays `frameConcretePercent`.

**Costing of steel by size**: `steel10` → Steel Grade-60 #3, `steel12` → #4, `steel16` → #5, `steel20` → #6 (rulebook keys `steel_g60_3…6`; a company material named "Grade-40 … #n" first when a roof's `steelGrade` is G40). A size with no rate takes the generic steel rate — `rateFallback: true` on the material and warning `STEEL_RATE_GENERIC`. `tIron` → a company material named T-iron / garder / girder / RSJ / I-beam, `roofTile` → roof / clay tile / khaprail, `precastPlank` → precast / hollow-core / plank, `steelDeck` → deck. Steel fixing labour counts every bar size (not the garders); brick masonry labour counts wall and foundation bricks (not roof infill).

**Detailed worked examples** (unit tests `tests/unit/estimateDetailed.test.ts`):
- *12 × 15 ft room, 5″ RCC, #4 @ 6″, #3 @ 9″, top bars*: main #4 ⌈180 / 6⌉ + 1 = 31 × (12 + 2 × 0.5) = 403 ft; distribution #3 ⌈144 / 9⌉ + 1 = 17 × 16 = 272 ft; top #4 2 × (⌈180 / 12⌉ + 1) = 32 × 3.5 = 112 ft → **#4 (12 mm) 515 ft × 0.2709 = 139.53 kg, #3 (10 mm) 272 ft × 0.1881 = 51.18 kg** (+5 % wastage: 146.51 / 53.74 kg); concrete 75 cft → 13.2 bags (the 1 % method would have said 166.5 kg of unsized steel).
- *Two 12 × 10 rooms sharing one 10 ft side (4.5″), rest EXTERNAL 9″, 10 ft high*: 9″ = 68 ft × 10 = 680 sq ft × 0.75 = **510 cft → 6,885 bricks**; 4.5″ = 10 × 10 × 0.375 = **37.5 cft → 506 bricks** (once — 75 cft if counted from both rooms); inside plaster 880 sq ft, outside 68 × (10 + 5/12) = 708.33 sq ft; foundation run 78 ft.
- *Party wall already built* (12 × 10 room, LEFT): 9″ brickwork 34 ft × 10 × 0.75 = 255 cft (330 when the party wall is new). *Double wall* on TOP: 9″ 330 cft + 4.5″ inner leaf 45 cft.

**Worked example** (the unit test): 5 marla 25 × 45, covered 1,125 sq ft, single storey 10 ft, load-bearing, brick strip footing 5 ft × 3 ft × 9″, rooms 1,000 sq ft with P = 320 ft, 7 doors 3 × 7, 5 windows 4 × 4, 2 ventilators 2 × 1.5. E = 2 × (√(1125/1.8) + √(1125 × 1.8)) = 2 × (25 + 45) = 140 ft, I = (320 − 140) / 2 = 90 ft, foundation run 230 ft. Excavation 230 × 3 × 5 = 3,450 cft; walls (140 × 10 − 86) × 0.75 + (90 × 10 − 147) × 0.375 = 1,267.88 cft → 17,116 bricks; slab 1,125 × 5/12 = 468.75 cft → 82.5 bags, 1,040.6 kg steel. Totals with wastage: cement **289.04 bags**, bricks **38,849**, sand **1,481.85 cft**, crush **645.14 cft**, steel **1,144.23 kg**, waterproofing 3.98 kg, termite 5.91 L. At Malik's A-standard rates (cement 1,450, bricks 17, sand 70, crush 180, steel 2,85,000 / ton) materials ≈ Rs 16,25,505; piece-rate labour Rs 5,34,018; total ≈ Rs 21,59,524 (≈ Rs 1,920 / sq ft).

### Rulebook, revisions and the full BoQ (Step 11)

**Rulebook.** Platform tables `Rulebook` (region PUNJAB_KP / KARACHI_SINDH, version, DRAFT / PUBLISHED, publishedAt, notes) + `RulebookParameter` (key, group, labels en / roman / ur, unit, value, safeMin, safeMax, reviewStatus PENDING_ENGINEER_REVIEW / REVIEWED) — read-only for companies (GRANT SELECT to app_user), written by platform admins. The parameter set is defined in code (`estimate/rulebookDefs.ts`, 68 keys in 14 groups); v1 of both regions is inserted PUBLISHED by migration `20261101090000_estimation_rulebook` (and by the seed) with **every value PENDING_ENGINEER_REVIEW**. A company's own values live in `CompanyRulebookOverride` (tenant table, RLS) and must stay in the safe range (`400 OUT_OF_SAFE_RANGE { key, value, safeMin, safeMax }`); a project's own values in `Project.estimateSettings` (the Phase 1 setting keys are the same rulebook keys — stored mixes "1:6" are read as 6; a stored `wastagePercent` still covers cement / sand / steel). Region = `Tenant.region` (chosen at sign-up; PUNJAB_KP when missing).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/rulebook` | `rulebook.override.view` | Every parameter with platform value, company value / note, value in effect + `source` RULEBOOK / COMPANY, safe range, review status, `projectOverridable`. |
| GET | `/rulebook/overrides` | `rulebook.override.view` | The company's own values. |
| PUT | `/rulebook/overrides` | `rulebook.override.manage` | `{ overrides: [{ key, value, note? }] }` upsert; `UNKNOWN_PARAMETER`, `OUT_OF_SAFE_RANGE`. Audit `rulebook.override_set`. |
| DELETE | `/rulebook/overrides/:key` | `rulebook.override.manage` | Back to the platform value (`404 OVERRIDE_NOT_FOUND`). Audit `rulebook.override_delete`. |
| GET / POST | `/admin/rulebooks` | platform admin | List per region; create DRAFT version n + 1 copied from `copyFromId` or the latest. |
| GET / PATCH / DELETE | `/admin/rulebooks/:id` | platform admin | Detail with parameters; notes; delete a DRAFT (`409 RULEBOOK_PUBLISHED`). |
| PATCH | `/admin/rulebooks/:id/parameters/:key` | platform admin | Value / safe range on a DRAFT only; review status and labels any time. |
| POST | `/admin/rulebooks/:id/publish` | platform admin | DRAFT → PUBLISHED; companies of the region use it from now on. All admin writes audited `admin.rulebook_*`. |

**Saved estimates.** `Estimate` (projectId, revision, status DRAFT / APPROVED / SUPERSEDED, `rulebookVersionId`, region, `overridesSnapshot` { company, project, parameters with source }, `ratesSnapshot` { materials, labour }, `basis` + warnings, covered area, direct / overhead / contingency / total paisa, `ratesOutdated`, generated / approved by + at) + `EstimateLine` (lineKey, section, stageKey, kind, description, material, materialId (snapshot reference, no FK), unit, quantity, wastage %, quantity with wastage, suppliedBy, formula, trace, rate, rate unit + factor, rate quantity, amount, rate status, override quantity / rate / note / by / at). Stored line amounts are the effective ones (after overrides). One APPROVED per project (partial unique index), one DRAFT at a time.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/projects/:id/estimates` | `projects.estimate.manage` | Generate DRAFT Rev n (`409 ESTIMATE_DRAFT_EXISTS { estimateId }`, `409 PROJECT_LOCKED`). Audit `estimate.generate`. |
| GET | `/projects/:id/estimates` | `projects.estimate.view` | Revisions, newest first. |
| GET | `/estimates/:id` | `projects.estimate.view` | Sections with lines + trace + overrides, stage totals, direct / overheads / contingency / total, cost per sq ft, margin vs the contract. |
| POST | `/estimates/:id/regenerate` | `projects.estimate.manage` | DRAFT only (`409 ESTIMATE_LOCKED`): current project, rulebook and rates; overrides kept by lineKey; `ratesOutdated` cleared. |
| PATCH | `/estimates/:id/lines/:lineId` | `projects.estimate.manage` | `{ quantity?, ratePaisa?, note }` (null clears; note required; rate needs `fields.rates`; `LINE_NOT_EDITABLE` for overheads / contingency; `OWNER_SUPPLIED_NO_RATE`). Totals recomputed. Audit `estimate.line_override`. |
| POST | `/estimates/:id/approve` | `estimate.revision.approve` | DRAFT → APPROVED, the previous APPROVED → SUPERSEDED (`409 ESTIMATE_NOT_DRAFT`; `409 RATES_OUTDATED` unless `confirmOutdatedRates`). Audit `estimate.approve`. |
| GET | `/estimates/:a/compare/:b` | `projects.estimate.view` | Line diffs by lineKey (ADDED / REMOVED / CHANGED / UNCHANGED), section and total deltas (b − a). `400 DIFFERENT_PROJECTS`. |
| GET | `/estimates/:id/pdf?lang=` | `projects.estimate.view` | Internal BoQ PDF (money columns only with `fields.rates`), stored as a REPORT attachment, signed link + WhatsApp text. |
| GET | `/projects/:id/owner-shopping-list[?estimateId]` | `projects.estimate.view` | Owner-supplied materials: item, quantity, unit, `neededBy` stage + per-stage quantities; from the APPROVED revision, else the DRAFT, else the live preview. Never a rate. |
| GET | `/projects/:id/owner-shopping-list/pdf` | `projects.estimate.view` | The list as a PDF for the owner + WhatsApp text and the client phone. |

A price-list change (`PUT /price-list`, `POST /price-list/bulk-percent`) marks DRAFT estimates that use a changed material `ratesOutdated` (APPROVED / SUPERSEDED never change). `POST /projects/:id/activate` answers `nextStep: "GENERATE_ESTIMATE"`. Field visibility as for the live estimate; the Munshi has no estimate permission.

**The BoQ** (`boq.ts`, built from the engine lines). One line per section × build stage × material / labour item, with a `trace` (every contributing engine line with its formula and numbers) and a one-line `formula`:

| Section | What | Stage (`stageKey`) |
|---|---|---|
| EXCAVATION_EARTHWORK | excavation cft × **Rs 12 / cft**; plinth filling = lowest footprint × plinth height × **Rs 10 / cft**; termite chemical | FOUNDATION_PLINTH |
| CONCRETE | cement / sand / crush of PCC, footings, DPC, slabs, beams, columns, lintels, topping | per floor (basement → FOUNDATION_PLINTH, ground → GF_STRUCTURE, first → F1_STRUCTURE …, mumty → MUMTY_ROOF) |
| STEEL | steel (by bar size when detailed) of footings, slabs, frame, lintels | per floor |
| MASONRY | bricks (or blocks, or stone) + mortar of foundation walls, walls and the roof parapet | per floor; parapet → MUMTY_ROOF |
| PLASTER | cement / sand of every plaster face | PLASTER_MEP |
| ROOF_WATERPROOFING | DPC compound / bitumen; T-iron roofs (garders, infill, screed, earth at Rs 10 / cft), planks, deck; roof waterproofing over the main roof footprint at the company WATERPROOFING sub-contract rate, else **Rs 60 / sq ft** | FOUNDATION_PLINTH (DPC), the floor, MUMTY_ROOF |
| FLOORING_TILES | floor tiles = Σ room floor areas; wall tiles = baths / wet rooms 2 (L + W) × **7 ft** (capped at the room height) and kitchens 2 (L + W) × **3 ft** splash, minus doors up to that height; **1″ 1:4** bed under the floor tiles | FINISHING |
| PAINT | painted area = all plastered faces − wall tiles; emulsion = area × **2 coats** ÷ **350 sq ft per gallon**; primer = area × **1 coat** ÷ **400** | FINISHING |
| MEP_ROUGH_IN | electrical **Rs 150 / sq ft** covered; plumbing **Rs 35,000 per wet room** (baths + kitchen); sewerage + gas **Rs 75,000** lump sum (always contractor work) | PLASTER_MEP |
| GREY_LABOUR | sub-contract piece rates per stage: brick masonry (bricks / blocks), plaster, shuttering, steel fixing — or the project labour rate per sq ft × each floor's footprint | per stage |
| FINISHING_LABOUR | TILE_LAYING × tile area, PAINT × painted area (left out for GREY_OWNER_FINISHING) | FINISHING |
| EQUIPMENT_SHUTTERING | covered area × **Rs 60 / sq ft** (plates, props, mixer, vibrator, scaffolding) | FOUNDATION_PLINTH |
| SITE_OVERHEADS | **3 %** of the direct cost | — |
| CONTINGENCY | **5 %** of (direct + overheads) | — |

Supply split: MATERIAL lines follow the project supply rules; for GREY_OWNER_FINISHING every FINISHING-stage material is the owner's. OWNER lines keep the quantity, never a rate / amount (`rateStatus: OWNER_SUPPLIED`) and feed the owner shopping list. Material rates are matched as before plus `blocks` (/block/), `floorTiles` (/floor tile/), `wallTiles` (/wall tile/), `paint` (/emulsion|wall paint/, per gallon — 1 gallon = 3.64 L) and `primer` (/primer|sealer/). Norm checks: steel kg and RCC cft per sq ft of covered area more than 30 % away from the rulebook norm (frame **4.0 kg** / **0.6 cft**, load-bearing **2.5 kg** / **0.45 cft**) → warnings `STEEL_NORM_DEVIATION` / `RCC_NORM_DEVIATION`.

**Worked 10-marla BoQ** (`tests/unit/estimateBoq.test.ts`, every section total written out): plot 30 × 75, covered 1,440 sq ft, load-bearing single storey, Punjab v1, FULL contract → excavation & earthwork Rs 88,632 · concrete 3,74,093.90 · steel 4,11,597 · masonry 10,65,612.44 · plaster 1,30,069.60 · roof & waterproofing 45,640 · tiles 5,17,267.60 · paint 1,99,150 · MEP 3,96,000 · grey labour 6,58,995.42 · finishing labour 2,62,750 · equipment 86,400 → direct 42,36,207.96 + overheads 1,27,086.24 + contingency 2,18,164.71 = **Rs 45,81,458.91** (Rs 3,181.57 / sq ft).

**Rulebook values still to be reviewed by a civil engineer** (all v1 values are PENDING_ENGINEER_REVIEW; these matter most): bricks per cft 13.5; blocks per sq ft 1.125 and block mortar 0.10 cft / cft (Karachi); mortar 0.25 cft / cft; masonry mortar 1:6; internal plaster 1:6 ½″ (Phase 1 used 1:4), external 1:4 ¾″; dry factors 1.54 / 1.33; cement bag 1.25 cft; slab 5″; beams + columns 45 % of slab concrete; steel % slab 1 / frame 2.5 / lintel 1 / footing 0.8 (the norm check flags these as far below the 4.0 / 2.5 kg per sq ft norms); norms RCC 0.6 / 0.45 cft and steel 4.0 / 2.5 kg per sq ft; wastage bricks 5, cement 2, sand 5, steel 4, tiles 7, paint 5, others 5 %; DPC compound 1 kg / bag, bitumen 0.15 kg / sq ft, termite 0.005 L / sq ft; paint 2 coats + 1 primer, coverage 350 / 400 sq ft per gallon; wall tiles 7 ft baths / 3 ft kitchen splash, 1″ 1:4 tile bed; all Rs rates (excavation 12, earth filling 10, roof waterproofing 60, MEP 150 / sq ft, 35,000 per wet room, 75,000 lump sum, equipment 60 / sq ft) and overheads 3 % / contingency 5 %; Karachi wall thicknesses 6″ / 4″ and lintel width 6″; productivity and curing days for the schedule (excavation 500 cft, bricks 1,500, blocks 400, concrete 400 cft, shuttering 300 sq ft, steel 400 kg, plaster 250 sq ft, tiles 120 sq ft, paint 600 sq ft per team-day; slab 14, columns 7, plaster 7 curing days).

**Decisions.** Rulebook keys = the existing setting keys (no mapping table; mixes stored as the sand parts n of 1:n / 1:n:2n). The live estimate keeps its grey-structure `cost` (the contract-value suggestion still uses it) and adds the `boq` preview. Owner-supplied lines carry no money at all (Phase 1 valued them as `ownerSuppliedPaisa` in the live view, which stays). MEP rough-in lump sums are always contractor work. `materialId` on estimate lines is a snapshot reference without a foreign key (material deletes must not be blocked by old estimates). Estimate PDFs are REPORT attachments (no new enum value).

## Schedule (Step 13) — milestones, curing, holidays, stoppages, delays

`src/modules/schedule/`: `calendar.ts` (PURE working calendar), `scheduler.ts` (PURE forward pass + pace), `generator.ts` (PURE: approved estimate lines → stages, milestones, efforts, curing lags, quotas), `schedule.shared.ts` (calendar from the database, DTOs, plan recompute + plan versions), `schedule.service.ts` (generate / read / re-plan / baseline / versions / milestone edit), `progress.service.ts` (site progress + stage-lock warning), `stoppages.service.ts`, `insights.service.ts` (delays, quotas, Aaj). Unit tests `tests/schedule/engine.test.ts`, API tests `tests/schedule/schedule.test.ts`. **Nothing in the schedule carries money** (quotas are quantities); the only amounts are the stage-lock warning's balances, with `fields.amounts`.

**Model.** `Schedule` (one per project: start date, teams, current plan `version`, `planFloor` of a "re-plan from today", `changeOrderDays` — the Step 15 hook) → `ScheduleStage` (estimate stage keys FOUNDATION_PLINTH, GF_STRUCTURE, F1–F3_STRUCTURE, MUMTY_ROOF, PLASTER_MEP, FINISHING) → `Milestone` (stable `key` such as `GF_STRUCTURE.SLAB`, effort `workDays`, planned window, `curingDays`, `startNoEarlierThan`, status PLANNED / IN_PROGRESS / CURING / DONE / BLOCKED, progress, actual dates, `billingStageId`) with `MilestoneDependency` (FS / SS + lag in calendar days) and `MilestoneQuota` (material, unit, planned quantity from the APPROVED estimate). `MilestoneUpdate` = site progress log (append-only). `ScheduleBaseline` (the first plan) and `SchedulePlanVersion` (every revised plan) are frozen: app_user has SELECT / INSERT only. `StoppageDay` (dates, reason, category, PENDING / APPROVED / REJECTED, photos).

**Generator** (from the APPROVED estimate; without one → `409 NO_APPROVED_ESTIMATE`). Effort (team-days, net quantities ÷ rulebook productivity ÷ teams, rounded up): excavation cft ÷ `productivityExcavationCftPerDay`; foundation = bricks + steel + concrete; per floor **walls** (columns & brickwork: bricks ÷ `productivityBricksPerDay`, blocks ÷ `productivityBlocksPerDay`) and **slab** (shuttering sq ft ÷ `productivityShutteringSqftPerDay` + steel kg ÷ `productivitySteelKgPerDay` + concrete cft ÷ `productivityConcreteCftPerDay`, concrete = crush ÷ (dry factor × 2n / (1 + 3n))); mumty structure + roof waterproofing; MEP (covered sq ft ÷ 300 a day — schedule default); plaster sq ft ÷ `productivityPlasterSqftPerDay`; tiles ÷ `productivityTileSqftPerDay`; paint (gallons × coverage ÷ coats) ÷ `productivityPaintSqftPerDay`. Stages without quantities (e.g. no foundation details) use default efforts flagged in `basis`. Curing = FS lags: walls → slab `curingDaysColumns`, slab → next floor / mumty / MEP `curingDaysSlab`, plaster → tiles `curingDaysPlaster`; plaster starts 7 days after MEP (SS). Quotas: each MATERIAL line of the stage goes to the milestone of its section (masonry → walls, concrete / steel → slab, tiles / paint → finishing milestones), converted to the material's own unit (steel kg → ton). Billing stages are linked by label to the first milestone of their schedule stage (foundation, ground, first, second, third, roof, plaster / MEP, tiles / finishing).

**Calendar.** Capacity of a day: 0 on weekly off days (`TenantSettings.workingDays` — drop FRIDAY for Friday off), platform (nationwide + company region) and company NON_WORKING holidays and APPROVED stoppage days of the project; 0.5 on PARTIAL holidays; × `ramadanDayFactor` (company setting, default 0.75) in Ramadan (`ramadanPeriods`, null = built-in approximate Pakistan dates 2025–2030). Lags are calendar days, then the next working day.

**Plan.** One forward pass (dependencies, `startNoEarlierThan`, schedule start, `planFloor`): DONE / CURING milestones sit on their actual dates, IN_PROGRESS ones start on their actual start. It runs on generate (version 1 + baseline), re-plan (`fromToday` default true → floor = today; `refreshQuantities` re-reads the current APPROVED estimate), milestone edits (Gantt drag = `startNoEarlierThan`; `dryRun` previews the shifts) and stoppage approval (approved days push not-done milestones and their successors). Each recompute that moves a date writes a `SchedulePlanVersion`; the baseline never changes.

**Delays** (`GET /projects/:id/schedule/delays`): original end = project end date (contract), else the baseline end; revised end = original + APPROVED OWNER + EXCUSABLE stoppage working days + change-order days; projected end = remaining effort from today at the current pace (earned ÷ planned work to date, 0.5–1); contractor days = working days the projected end is past the revised end (contractor stoppages + SLOW_PROGRESS), with the reasons; pending stoppages listed, not counted.

**Site.** `POST /milestones/:id/progress` (and sync `MILESTONE_PROGRESS`, idempotent by clientId): progress > 0 starts a milestone, 100 % finishes it (CURING when it has curing days), BLOCKED needs a note, DONE reopens only with `schedule.plan.manage`. Warnings never block: `PREDECESSOR_NOT_DONE`, and the **stage-lock warning** `PREVIOUS_STAGE_UNPAID` when the milestone starts a billing stage while an earlier stage's invoice still has a balance (BillingEvent PREVIOUS_STAGE_UNPAID `refType: MILESTONE` + notification `milestoneStageLock` to the owner / PMs with billing). Stoppages: `POST /projects/:id/stoppages` (and sync `STOPPAGE_LOG`), photo required except HOLIDAY, overlapping days → 409. Usage entries may carry `milestoneId` (validated: `400 INVALID_MILESTONE`) → quota used.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/projects/:id/schedule` | `schedule.plan.view` | Gantt data: stages, milestones (planned / baseline / actual, curing, deps, quotas), calendar, stoppage bands, planned / baseline / projected end; `schedule: null` + `canGenerate` before generating |
| POST | `/projects/:id/schedule/generate` | `schedule.plan.manage` | `{ startDate?, teams? 1–6, note? }` → 201; 409 NO_APPROVED_ESTIMATE / SCHEDULE_EXISTS / PROJECT_LOCKED, 400 NO_START_DATE. Audit `schedule.generate` |
| POST | `/projects/:id/schedule/replan` | `schedule.plan.manage` | `{ note, fromToday?, refreshQuantities?, teams? }` → new version, baseline kept. Audit `schedule.replan` |
| GET | `/projects/:id/schedule/baseline` · `/versions` · `/delays` · `/quotas` · `/today` | `schedule.plan.view` | frozen baseline · plan versions · delay breakdown · Milestones & Quotas · Aaj (today / upcoming 7 days / late) |
| GET · POST | `/projects/:id/stoppages` | `schedule.plan.view` · `schedule.stoppage.create` | list with approved days per category · log (PENDING). Audit `stoppage.create` |
| GET · PATCH | `/milestones/:id` | `schedule.plan.view` · `schedule.plan.manage` | detail + updates · edit (name, workDays, curingDays, startNoEarlierThan, dependsOn, billingStageId, dryRun). Audit `milestone.update` |
| POST | `/milestones/:id/progress` | `schedule.progress.edit` | site progress / status (+ warnings). Audit `milestone.progress` |
| GET | `/stoppages/:id` | `schedule.plan.view` | |
| POST | `/stoppages/:id/approve` · `/reject` | `schedule.stoppage.approve` | approve (category) → plan pushed · reject (note). Audits `stoppage.approve` / `stoppage.reject` |

Templates: Administrator all; Project Manager all five; Munshi `schedule.plan.view`, `schedule.progress.edit`, `schedule.stoppage.create`; Accountant `schedule.plan.view` (all projects). Sync pull tables `milestones` (not DONE + DONE in the last 14 days, quota planned / used) and `stoppages` (PENDING + 60 days). Seed: DHA Phase 6 · 10 Marla has a generated schedule (2 teams) + baseline, foundation and ground floor DONE, first-floor walls CURING, first-floor slab IN_PROGRESS, one APPROVED RAIN and one PENDING SMOG_BAN stoppage (`prisma/seedSchedule.ts`).

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

`src/core/pdf`: Playwright chromium, A4, letterhead (logo, name, NTN, address, phone), Inter, page numbers. Templates: invoice, receipt (RV), owner statement. Stored as attachments (`INVOICE_PDF`, `RECEIPT_PDF`, `STATEMENT_PDF`). Every PDF endpoint returns `{ url, expiresAt, whatsappText, clientPhone }`, in the requesting user's language or `?lang=en|roman|ur` (see **Languages**; Urdu = RTL with an embedded Nastaliq font). If chromium is missing → `503 PDF_UNAVAILABLE` (tests use a fake renderer). **Windows / new machine:** `npx playwright install chromium` once.

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

`notify(tx, { recipients, type, severity, text: { key, params }, projectId, ref, actionUrl, sms })` (text rendered per recipient language — see **Languages**) (`notifications.service.ts`) is called inside the module's transaction; `alerts.ts` holds every event's recipients, text and link.

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

`GET /dashboard/overview?from&to&projectId` (default the last 30 days): KPIs (active projects + at risk = overdue invoice or own money > 10 % of contract; `delayed` 0 until the schedule exists; pending approvals; open shortages; dispatches on the way; and with `billing.view` receivables outstanding + collected %, overdue, supplier udhaar + oldest days + paid %, store stock value, cash with site staff, own money invested), project rows, site stats (hazri today by mistri / mazdoor / other — company-defined types count as other, peshgi and kharcha this week, deliveries today, open shortages), labour (wages by worker type — `{ type, label, labelRoman, labelUrdu, days, wagesPaisa }`, any type key — from the settlements of weeks starting in the period; sub-contractors overpaid), payments received by method (cheques cleared / pending / bounced) and alerts (latest open billing events + unread critical notifications).

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
| worker_types | the company's worker types (DAILY labour rates, active and inactive): id, key, label, labelRoman, labelUrdu, ratePaisa, overtimeMultiplier, isActive, updatedAt | — (daily wages are allowed) |
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
| 400 | `UNKNOWN_PERMISSION`, `SCOPE_NOT_SUPPORTED`, `LIMIT_NOT_SUPPORTED`, `DUPLICATE_PERMISSION`, `DENY_HAS_NO_SCOPE`, `ROLE_NOT_FOR_ACCOUNT`, `VALIDATION_ERROR`, `INVALID_JSON`, `USE_OTP_LOGIN`, `OTP_INVALID`, `CURRENT_PASSWORD_WRONG`, `FILE_REQUIRED`, `FILE_TOO_LARGE`, `INVALID_FILE_TYPE`, `INVALID_UPLOAD`, `HOLIDAY_IN_PAST`, `FINANCIALS_PM_ONLY`, `INVALID_PROJECT`, `THEKEDAR_HAS_ALL_PROJECTS`, `CANNOT_REVOKE_CURRENT_DEVICE`, `AMOUNT_MISMATCH`, `INVALID_PLAN`, `PLAN_REQUIRED`, `PAID_ON_IN_FUTURE`, `PAID_ON_TOO_OLD`, `SAME_PLAN`, `DOWNGRADE_USERS_OVER_LIMIT`, `KEEP_PROJECTS_REQUIRED`, `TOO_MANY_PROJECTS`, `INVALID_GROUP`, `UNIT_LOCKED`, `CATEGORY_ARCHIVED`, `CATEGORY_IS_DEFAULT`, `LAST_ACTIVE_CATEGORY`, `INVALID_MATERIAL`, `INVALID_LABOR_KEY`, `INVALID_LABOR_UNIT`, `PERCENT_TOTAL_INVALID`, `RETENTION_STAGE_INVALID`, `TEMPLATE_IS_DEFAULT`, `DAILY_RATE_REQUIRED`, `INVALID_CLIENT`, `INVALID_PM`, `INVALID_MUNSHI`, `INVALID_DATES`, `CONTRACT_VALUE_REQUIRED`, `RATE_REQUIRED`, `INVALID_TEMPLATE`, `QUALITY_CATEGORY_REQUIRED`, `QUALITY_CATEGORY_NOT_ALLOWED`, `INVALID_QUALITY_CATEGORY`, `OPENINGS_EXCEED_WALL`, `INVALID_TARGET_FLOOR`, `PROJECT_NOT_READY`, `INSUFFICIENT_STOCK`, `DATE_IN_FUTURE`, `REASON_REQUIRED`, `INVALID_LOCATION`, `SAME_LOCATION`, `SHORTAGE_NOTE_REQUIRED`, `DAMAGED_EXCEEDS_COUNTED`, `ITEMS_MISMATCH`, `INVALID_PAID_AMOUNT`, `CHALLAN_REQUIRED`, `INVALID_ATTACHMENT`, `RATES_NOT_ALLOWED`, `NOT_IN_PURCHASE`, `NOTHING_TO_CORRECT`, `RETURN_EXCEEDS_PURCHASE`, `RETURN_EXCEEDS_STOCK`, `PO_SUPPLIER_MISMATCH`, `SUPPLIER_INACTIVE`, `RESOLUTION_NOT_ALLOWED`, `NOT_OWNER_SUPPLIED`, `INVALID_WORKER`, `INVALID_SUBCONTRACTOR`, `WORKER_NOT_ASSIGNED`, `FUTURE_DATE`, `DATE_TOO_OLD`, `RANGE_TOO_LONG`, `INVALID_ASSIGNMENT`, `LUMPSUM_USES_PROGRESS`, `LUMPSUM_HAS_NO_RATE`, `NOT_LUMPSUM`, `PROGRESS_NOT_AHEAD`, `INVALID_WEEK_START`, `FUTURE_WEEK`, `ADVANCE_TOO_HIGH`, `EMPTY_SETTLEMENT`, `LINE_NOT_FOUND`, `EXCEEDS_BALANCE`, `EXCEEDS_RETENTION`, `NOTHING_TO_CHARGE`, `INSUFFICIENT_CASH`, `NO_CASH_ACCOUNT`, `INVALID_HOLDER`, `INVALID_RECEIVER`, `NOTE_REQUIRED`, `INVALID_END_DATE`, `NOT_RUNNING_BILLS`, `USE_RETENTION_INVOICE`, `NOTHING_TO_BILL`, `INVALID_RECOVERABLE`, `NO_RETENTION_STAGE`, `LINE_AMOUNT_REQUIRED`, `LINES_LOCKED`, `EMPTY_INVOICE`, `WHT_NOT_ENABLED`, `INVALID_ALLOCATION`, `ALLOCATION_EXCEEDS_BALANCE`, `ALLOCATION_EXCEEDS_PAYMENT`, `METHOD_REQUIRED`, `UNSUPPORTED_ACTION`, `DEVICE_MISMATCH`, `INVALID_FILE`, `EMPTY_FILE`, `TOO_MANY_ROWS`, `MISSING_COLUMNS`, `IMPORT_HAS_ERRORS`, `NOTHING_TO_IMPORT` |
| 401 | `UNAUTHENTICATED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `SESSION_REVOKED`, `ACCOUNT_DISABLED`, `INVALID_CREDENTIALS`, `REFRESH_INVALID`, `REFRESH_TOKEN_REUSED`, `DEVICE_REVOKED` |
| 402 | `PLAN_LIMIT_REACHED` |
| 403 | `PERMISSION_DENIED` (`details.permission`, `details.anyOf`), `APPROVAL_LIMIT_EXCEEDED` (`details.permission / maxAmountPaisa / amountPaisa`), `OWNER_ONLY_PERMISSION`, `ROLE_IS_SYSTEM`, `CANNOT_EDIT_OWNER`, `CANNOT_EDIT_OWN_PERMISSIONS`, `GRANT_EXCEEDS_OWN`, `FORBIDDEN`, `COMPANY_SUSPENDED`, `ACCOUNT_READ_ONLY`, `INVALID_SIGNATURE`, `LINK_EXPIRED`, `CANNOT_CHANGE_OWN_ROLE`, `CANNOT_CHANGE_OWNER_ROLE`, `CANNOT_DEACTIVATE_SELF`, `LAST_THEKEDAR`, `RATE_CHANGE_NOT_ALLOWED`, `PAID_FROM_NOT_ALLOWED`, `OWN_EXPENSE` |
| 404 | `ROLE_NOT_FOUND`, `ROUTE_NOT_FOUND`, `NOT_FOUND`, `PHONE_NOT_REGISTERED`, `INVITE_NOT_FOUND`, `ATTACHMENT_NOT_FOUND`, `HOLIDAY_NOT_FOUND`, `USER_NOT_FOUND`, `DEVICE_NOT_FOUND`, `COMPANY_NOT_FOUND`, `SUBSCRIPTION_NOT_FOUND`, `NO_PENDING_CHANGE`, `TENANT_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `PLAN_NOT_FOUND`, `MATERIAL_NOT_FOUND`, `PLATFORM_MATERIAL_NOT_FOUND`, `CATEGORY_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `SUPPLIER_NOT_FOUND`, `WORKER_NOT_FOUND`, `SUBCONTRACTOR_NOT_FOUND`, `CLIENT_NOT_FOUND`, `PROJECT_NOT_FOUND`, `FLOOR_NOT_FOUND`, `ROOM_NOT_FOUND`, `OPENING_NOT_FOUND`, `LOCATION_NOT_FOUND`, `STORE_NOT_FOUND`, `PURCHASE_NOT_FOUND`, `PURCHASE_ORDER_NOT_FOUND`, `DISPATCH_NOT_FOUND`, `SHORTAGE_NOT_FOUND`, `PROJECT_WORKER_NOT_FOUND`, `ASSIGNMENT_NOT_FOUND`, `MEASUREMENT_NOT_FOUND`, `SETTLEMENT_NOT_FOUND`, `CASH_ACCOUNT_NOT_FOUND`, `FLOAT_NOT_FOUND`, `EXPENSE_NOT_FOUND`, `TOPUP_NOT_FOUND`, `STAGE_NOT_FOUND`, `PROGRESS_NOT_FOUND`, `INVOICE_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `NOTIFICATION_NOT_FOUND`, `DAILY_LOG_NOT_FOUND`, `DEMO_NOT_FOUND` |
| 409 | `ROLE_NAME_TAKEN`, `ROLE_IN_USE`, `ALREADY_EXISTS`, `PHONE_TAKEN`, `EMAIL_TAKEN`, `MULTIPLE_COMPANIES`, `INVITE_ALREADY_ACCEPTED`, `INVITE_CANCELLED`, `INVITE_PENDING`, `ALREADY_MEMBER`, `HOLIDAY_EXISTS`, `USER_ALREADY_ACTIVE`, `PAYMENT_PENDING`, `DUPLICATE_TRANSACTION`, `SLUG_TAKEN`, `PLAN_CODE_TAKEN`, `LAST_ACTIVE_PLAN`, `ALREADY_PROCESSED`, `CANNOT_EXTEND_TRIAL`, `TENANT_CLOSED`, `MATERIAL_EXISTS`, `MATERIAL_IN_USE`, `PLATFORM_MATERIAL_EXISTS`, `CATEGORY_EXISTS`, `TEMPLATE_EXISTS`, `SUPPLIER_EXISTS`, `WORKER_PHONE_TAKEN`, `SUBCONTRACTOR_EXISTS`, `CLIENT_PHONE_TAKEN`, `PROJECT_CODE_TAKEN`, `PROJECT_NOT_DRAFT`, `PROJECT_LOCKED`, `INVALID_STATUS_TRANSITION`, `SUPPLY_RULE_LOCKED`, `BILLING_STAGES_LOCKED`, `FLOOR_HAS_ROOMS`, `FLOOR_NOT_EMPTY`, `PROJECT_IS_DRAFT`, `PO_CLOSED`, `PURCHASE_ORDER_LOCKED`, `PURCHASE_ORDER_HAS_RECEIPTS`, `PURCHASE_ORDER_CANCELLED`, `RATES_ALREADY_SET`, `PURCHASE_NOT_FINAL`, `ALREADY_RECEIVED`, `DISPATCH_NOT_CANCELLABLE`, `DISPATCH_CANCELLED`, `SHORTAGE_RESOLVED`, `NOT_A_CHEQUE`, `CHEQUE_ALREADY_SETTLED`, `CASH_BALANCE_OPEN`, `WORKER_ALREADY_ASSIGNED`, `WEEK_LOCKED`, `SETTLEMENT_LOCKED`, `SETTLEMENT_NOT_SUBMITTED`, `SETTLEMENT_NOT_APPROVED`, `SETTLEMENT_PAID`, `ALREADY_PAID`, `MEASUREMENT_NOT_PENDING`, `ALREADY_ACKNOWLEDGED`, `EXPENSE_NOT_PENDING`, `TOPUP_PENDING`, `TOPUP_DECIDED`, `STAGE_NOT_READY`, `STAGE_ALREADY_INVOICED`, `SOURCE_ALREADY_BILLED`, `RETENTION_NOT_DUE`, `PROGRESS_BILLED`, `PROGRESS_ON_DRAFT`, `INVOICE_LOCKED`, `INVOICE_NOT_DRAFT`, `INVOICE_NOT_ISSUED`, `INVOICE_CANCELLED`, `INVOICE_HAS_PAYMENTS`, `LOG_LOCKED`, `IMPORT_CONFLICT`, `OPENING_LOCKED`, `DEMO_EXISTS`, `DEMO_IN_USE` |
| 410 | `OTP_EXPIRED`, `INVITE_EXPIRED`, `INVITE_CANCELLED` |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `RATE_LIMITED`, `OTP_RESEND_WAIT`, `OTP_LIMIT_REACHED`, `OTP_TOO_MANY_ATTEMPTS`, `INVITE_RESEND_WAIT` |
| 503 | `SERVICE_BUSY` (no database connection / transaction slot in time; `Retry-After: 1`, safe to retry), `PDF_UNAVAILABLE` (chromium missing — `npx playwright install chromium`), `SMS_UNAVAILABLE` (the login code could not be sent by SMS or WhatsApp; the code was dropped — retry at once) |

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
| `20261019090000_permissions` | `RoleBase`, `PermissionScope`, `PermissionEffect`; `Role`, `RolePermission`, `UserPermissionOverride` (RLS, grants; Role no DELETE); `User.roleId` + `permVersion`, `Invitation.roleId` (composite FKs); trigger `sync_track_access` on `User.permVersion` (sync change `UserAccess` → phone resync). Then run `npm run backfill:permissions` once. |
| `20261020090000_act_as_sessions` | `ActAsMode`, `ActAsSession` (RLS: a company may only read its own rows), `NotificationType.PLATFORM_SUPPORT_ACCESS` (kept for history; since direct access nothing writes to them) |
| `20261021090000_message_deliveries` | `MessageChannel`, `MessageStatus`, `MessageDelivery` (delivery log of every SMS / email / WhatsApp: masked recipient, status, provider id, error; tenantId nullable) — written by app_admin; RLS + `SELECT` for app_user (own company only) |
| `20261022090000_onboarding` | `TenantSettings.onboardingDismissedAt` / `onboardingDismissedById` / `ratesReviewedAt`; `isDemo` on `Project`, `Client`, `Worker`, `Supplier`, `CashAccount`; `CashEntryType.OPENING`, `StockMovementType.OPENING_IN`; `OpeningBalanceKind` + `OpeningBalance` (RLS, SELECT + INSERT); SECURITY DEFINER `purge_demo_data()` (EXECUTE for app_user only) |
| `20261018090000_worker_types` | Company-defined worker types: `Worker.type` enum → text (values kept; `WorkerType` enum dropped); `LaborRate.labelRoman`, `labelUrdu`, `isActive`; default DAILY types backfilled with Roman Urdu / Urdu names and plain-English labels (Mason, Tile mason, Labourer, Steel-fixer helper, Watchman — only where the label was still the old default); `sync_track` trigger on `LaborRate` (sync table `worker_types`). RLS / grants on `LaborRate` unchanged |
| `20261105090000_schedule` | Step 13: `MilestoneStatus`, `DependencyType`, `StoppageReason`, `StoppageStatus`, `DelayCategory`; `Schedule`, `ScheduleStage`, `Milestone`, `MilestoneDependency`, `MilestoneQuota`, `StoppageDay` (RLS, full grants), `MilestoneUpdate`, `ScheduleBaseline`, `SchedulePlanVersion` (RLS, SELECT / INSERT only — frozen); composite FKs, `Milestone.billingStageId` ON DELETE SET NULL; `TenantSettings.ramadanDayFactor` / `ramadanPeriods`; sync triggers on the milestone tables, stoppages and milestone-linked usage |

Prisma's `migrate dev` refuses to run non-interactively when a change has warnings (enum value removed). Generate SQL with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-edit renames (e.g. `ALTER TYPE … RENAME VALUE`, `RENAME COLUMN`) so data is kept, save it as a new migration folder and run `npx prisma migrate deploy`.

## Tests

`npm test` uses `.env.test` (copy `.env.test.example`). The suite refuses to run against a database whose name doesn't end in `_test`, and never touches the dev database.

**How a run works** (about 2 minutes for the full suite on a 6-core / 12-thread machine; it was ~20 minutes one file at a time):

1. Global setup (`tests/setup/globalSetup.ts`) creates the roles and `construction_test` (`db:setup`), applies the migrations, and builds the **seed snapshots** in it (`tests/setup/buildSeedSnapshots.ts`): the test seed and the demo data sets of `tests/setup/demoSeeds.ts`, each copied into a `test_seed*` schema.
2. That database is the **template**: each Vitest worker gets its own copy, `construction_w<n>_test` (`CREATE DATABASE … TEMPLATE construction_test`, n = `VITEST_POOL_ID`), with the same schema, RLS policies, grants and snapshots. The roles are cluster-wide, so `app_user` (RLS) and `app_admin` (BYPASSRLS) behave exactly as in production.
3. `tests/setup/workerDatabase.ts` (first `setupFiles` entry, runs before any app module loads) points the worker's `DATABASE_URL` / `DATABASE_ADMIN_URL` / `DATABASE_MIGRATION_URL` at its copy, `STORAGE_DIR` at its own temp folder, and uses smaller pools (`DB_POOL_MAX=5`). Workers are separate processes (`pool: 'forks'`) and every test file gets a fresh process, so Prisma clients, caches, rate limiters and the console SMS / mail outbox are never shared.
4. Every test starts from the seeded database: `resetDatabase()` (`useFreshDatabase()`) deletes all rows and copies the snapshot back in one transaction (~50 ms instead of ~1.5 s of seeding). Same rows and ids as the seed; in-memory caches keyed by those ids are cleared. Files that need the bigger demo call `seedMalikDemo(seeded())` / `seedMalikStockAndLabor(seeded())` (`tests/dashboard/fixtures.ts`), restored the same way. To snapshot another data set, add it to `tests/setup/demoSeeds.ts` and load it with `withSeedSnapshot(name, seeded())`.
5. At the end the worker databases and the uploaded test files are dropped (also at the start of the next run, if one was interrupted).

| Setting | Default | |
|---|---|---|
| `TEST_MAX_WORKERS` | half the CPU threads | Parallel workers (= databases). Postgres and the workers share the CPU; more is rarely faster. |
| `TEST_DB_POOL_MAX` | `5` | Connections per pool per worker (each file opens up to two app pools + one reset pool) — keep workers × pools under Postgres `max_connections`. |
| `npm run test:serial` | | One file at a time on `construction_test` itself, no copies (`vitest run --mode serial`, or `TEST_SERIAL=1`). |

`DATABASE_MIGRATION_URL` must be a superuser (as for `db:setup`): it creates the worker databases, and the reset uses `session_replication_role = replica` (no FK checks or triggers while copying rows back). The test databases commit with `synchronous_commit = off` and the tests allow 30 s for a connection (`DB_TX_MAX_WAIT_MS`, production 10 s), so a busy CPU doesn't turn into `503 SERVICE_BUSY`.

`tests/setup/pgConcurrency.ts` (vitest `setupFiles`) fails any test in which two queries overlap on one pg connection — e.g. `Promise.all` on a `tx`. Inside a transaction use `inSequence([() => tx.a…, () => tx.b…])` (`src/core/db/inSequence.ts`) instead.
