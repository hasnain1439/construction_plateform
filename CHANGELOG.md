# Changelog

All notable changes to the Construction Platform API are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no version tags yet, so releases are listed by date.

> **Adding entries:** put each change under `## [Unreleased]` in the right group (Added / Changed / Fixed / Removed / Security), as one short plain-English line about what users or API clients notice. Call out breaking API changes and name any new `prisma/migrations` folder.

## [Unreleased]

### Added
- Messages in the recipient's language (English / Roman Urdu / Urdu): server catalogues in `src/core/i18n` for notifications, SMS (login / reset codes, invites, dispatch, cash, subscription, payment review), emails (codes, invites, support-access notice), WhatsApp share texts, PDF labels, report files and enum labels (statuses, payment methods, roles, units, cost buckets, kharcha categories). A test fails when any key is missing in a language.
- `PATCH /auth/me/preferences` `{ language: 'en' | 'roman' | 'ur' }` → `{ language }` for any signed-in company user (also in a read-only company).
- Invitations take an optional `language` (default: the company's default language); the invite SMS / email use it and the new user starts with it. Invitation lists show it.
- Notifications are rendered per recipient and re-rendered in the reader's current language in the inbox, dashboard alerts and sync (stored with a text key + params); their SMS is in each recipient's language.
- Urdu PDFs (invoice, receipt, owner statement, reports): right-to-left with an embedded Noto Nastaliq Urdu font (`assets/fonts`, SIL OFL; copied into the Docker image). Invoice / receipt / statement PDFs and report files are in the requesting user's language, `?lang=en|roman|ur` overrides.
- `SMS_TEMPLATES` accepts language-specific entries (`"OTP.ur"`) that win over the type entry.
- Signup accepts an optional owner `language`.
- Migration: `20261023090000_languages` (`Invitation.language`, `Notification.textKey` / `params`).
- First-login setup checklist: `GET /onboarding/checklist` (logo, rates reviewed, team invited, workers, suppliers, first project — computed from the company's data, demo data excluded, with progress and the demo project), `POST /onboarding/checklist/dismiss` (hide / show, per company) and `POST /onboarding/checklist/rates-reviewed`. Owner only (`company.settings.manage`).
- Excel / CSV import of workers, sub-contractors, suppliers, custom materials and clients: `GET /imports/:entity/template` (xlsx with headers, an example row and an Instructions sheet in English / Roman Urdu / Urdu), `POST /imports/:entity/preview` (every row checked with the create endpoint's own rules, errors per cell, nothing written) and `POST /imports/:entity/commit` (send the same file again; all-or-nothing by default, `?skipInvalid=true` for only the valid rows; one transaction, one audit row). ≤ 2 MB, ≤ 1000 rows; each entity needs its create permission.
- Opening balances: `GET/POST /opening-balances` for supplier udhaar (supplier ledger OPENING), cash in hand per munshi / PM (new cash entry type `OPENING`), Central Store stock with its rate (new stock movement type `OPENING_IN`) and worker peshgi (an office-cash advance on the worker's project). One entry per item, locked once saved (`409 OPENING_LOCKED`), audited. New permission `company.opening.manage` (owner; can be granted, in no template).
- "Try with demo data": `POST /demo` creates one project tagged DEMO with a client, supplier, workers, hazri, a received site purchase, a small cash book with kharcha and a draft invoice; `DELETE /demo` removes all of it in one transaction (no leftovers in ledgers, stock or cash; refused with `409 DEMO_IN_USE` while real data uses demo records). The demo project never counts against the plan and uses no real document numbers. Projects, workers, suppliers and clients return `isDemo`.
- Migration: `20261022090000_onboarding` (`OpeningBalance`, `isDemo` columns, checklist fields on `TenantSettings`, `CashEntryType.OPENING`, `StockMovementType.OPENING_IN`, `purge_demo_data()`).
- Deployment kit (see `docs/DEPLOYMENT.md`): multi-stage `Dockerfile` (Node 24 slim, non-root, healthcheck, Playwright chromium for PDFs; its `migrate` command runs `prisma migrate deploy` as a separate one-shot, never on start), `deploy/docker-compose.prod.yml` (Caddy with automatic HTTPS, web, api, Postgres 18 with an init script creating `app_user` / `app_admin`, one-shot `migrate`), `deploy/deploy.sh` (pull, migrate, restart, readiness check, tag history for rollbacks), staging / production env examples in `deploy/env/`.
- GitHub Actions: pull requests run typecheck, migrations on an empty Postgres, a schema-drift check and the tests, and build the image; `main` pushes `ghcr.io/<owner>/construction-api:sha-<7>` and deploys it to staging over SSH; production is a manual workflow behind the `production` environment's approval (takes a backup first).
- `npm run db:backup` / `scripts/backup/pg-backup.sh` (nightly `pg_dump -Fc`, checksum, retention, optional upload hook) and `npm run db:restore-check` / `scripts/backup/restore-check.sh` (restores the newest dump into a scratch database and checks migrations, core tables, RLS and row counts).
- Permission-based access control. One permission catalogue (`src/core/auth/permissionCatalog.ts`, ~100 keys `<module>.<resource>.<action>` plus field permissions `fields.rates|amounts|profit|contract`, labels in English / Roman Urdu / Urdu, owner-only / scoped / approval-limit flags), served at `GET /permissions/catalog`.
- Role templates per company: system **Project Manager**, **Munshi** (exactly the old PM / MUNSHI access), **Accountant** and **Store Keeper** (read-only; duplicate to change), plus custom roles: `GET/POST /roles`, `GET/PATCH /roles/:id`, `POST /roles/:id/duplicate`, `PUT /roles/:id/permissions` (scope ASSIGNED_PROJECTS / ALL_PROJECTS and approval limit `maxAmountPaisa` per grant).
- Per-user extra / removed permissions and role: `GET /users/:id/permissions` (effective keys with their source), `PUT /users/:id/permission-overrides`, `PATCH /users/:id/role`. THEKEDAR or `team.member.manage`; owners and owner-only keys are protected; every change is audited with before / after (`role.create`, `role.update`, `role.permissions_update`, `user.permissions_update`, `user.role_change`).
- Approval limits: kharcha, top-up, settlement and measurement approval, invoice issue and supplier payments above the caller's limit → `403 APPROVAL_LIMIT_EXCEEDED`.
- `/auth/me` and every login result add `fieldAccess`, `scopes`, `approvalLimits`, `permissionRole` and `legacyPermissions` (the old 8 names, deprecated). `/sync/pull` returns the same block as `access`.
- Invitations accept `roleId`; accepting assigns it (default: the system template of the invited role). Team users carry `permissionRole`.
- `npm run backfill:permissions` (idempotent) — templates for existing companies, roles for existing users, `canSeeFinancials` PMs moved to overrides.
- Parity test over every company route (enumerated from the Express app) against a snapshot recorded from the old role checks.
- Migration: `20261019090000_permissions` (`Role`, `RolePermission`, `UserPermissionOverride`, `User.roleId` / `permVersion`, `Invitation.roleId`, RLS + grants, `UserAccess` sync change trigger).
- Super admin support sessions (act-as hardening): `POST /admin/act-as-sessions` (reason 5–300, `durationMinutes` default 60), `GET /admin/act-as-sessions` (filter `tenantId`, `adminId`, `active`), `GET /admin/act-as-sessions/:id`, `POST /admin/act-as-sessions/:id/mode` (WRITE needs a second reason), `POST /admin/act-as-sessions/:id/end`. Start / mode / end are audited (`admin.act_as_started|mode_changed|ended`) with the admin's name and reason.
- Company owners are told when platform support opens their account: in-app notification `PLATFORM_SUPPORT_ACCESS` and an email "Platform support accessed your account: <reason>".
- `GET /company/audit-logs` — the company's own audit log (new owner-only permission `company.audit.view`), with platform support rows naming the support person and their reason.
- Migration: `20261020090000_act_as_sessions` (`ActAsSession` + `ActAsMode`, RLS with company read-only access, `NotificationType.PLATFORM_SUPPORT_ACCESS`).
- SMS through any HTTP gateway: `SMS_PROVIDER=http` with configurable URL / method, auth (bearer, basic, header, query key), sender ID, body template (`{to}`, `{message}`, `{sender}`, `{type}`, `{templateId}`), phone format, success / failure detection and message id path; per-message-type text `SMS_TEMPLATES` and gateway template ids `SMS_TEMPLATE_IDS`. Console stays for development and tests.
- Email through Amazon SES: `MAIL_PROVIDER=ses` (`SES_REGION`, `MAIL_FROM`, optional `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY`, `SES_CONFIGURATION_SET`); smtp and console stay. README has the SPF / DKIM / DMARC set-up.
- WhatsApp Cloud API (Meta) adapter with template messages for invites, login codes, invoices and statements, off by default (`WHATSAPP_ENABLED`). When on, invites and login / reset codes also go by WhatsApp; SMS, email and the existing share links stay.
- File storage in a private S3-compatible bucket (AWS S3, Cloudflare R2, MinIO): `STORAGE_PROVIDER=s3`, server-side encryption, presigned download links. `npm run storage:migrate -- --from local|cloudinary --to s3 [--dry-run]` copies existing files and switches their keys (idempotent; source files kept).
- Delivery log: every SMS, email and WhatsApp message is recorded (channel, type, masked recipient, QUEUED / SENT / FAILED, provider message id, error). Migration: `20261021090000_message_deliveries` (`MessageDelivery`, platform-written, a company can read only its own rows).
- `.env.example` documents every setting, with a "what you must set up" list in README → Providers.
- `GET /health/ready` readiness probe: database, file storage (local folder / S3 HeadBucket / Cloudinary ping, cached 30 s) and the job scheduler, each with `ok` / `latencyMs` / error code → `200` or `503 NOT_READY` (per-check details in `error.details`). `GET /health` stays the liveness probe (no database), response unchanged. Both documented in OpenAPI.
- Sentry error + performance monitoring (`@sentry/node`), off unless `SENTRY_DSN` is set (`SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`). 500s are reported with `requestId` / `tenantId` / hashed user id tags; `npm start` / `npm run dev` preload `instrument.js` for Express / http / pg tracing.
- Optional PostHog product analytics (`POSTHOG_KEY`, `POSTHOG_HOST`): `project_activated`, `hazri_marked`, `purchase_saved`, `invoice_issued` and `sync_error` (failed `/sync/push` batches), hashed user id, company as group, allow-listed props only — no money or personal data. README → Observability.
- Log lines written during a request (and the request line) carry `tenantId` and `userId` (and `platformAdminId` in support sessions).

### Changed
- `user.language` in `/auth/me` and login results is now `'en' | 'roman' | 'ur'` (was ENGLISH / ROMAN_URDU / URDU); `PATCH /auth/me` accepts both forms. Team and company-settings responses keep the old values.
- Default (Roman Urdu) users now get notification titles / bodies, emails and PDFs in Roman Urdu instead of English; SMS texts that were already Roman Urdu are unchanged.
- **Breaking:** acting inside a company needs `X-Act-As-Session` (a live session of this admin for this company) next to `X-Act-As-Tenant`; without it `403 ACT_AS_SESSION_REQUIRED | ACT_AS_SESSION_INVALID | ACT_AS_SESSION_EXPIRED | ACT_AS_SESSION_ENDED`. Sessions are read-only until switched to write mode: writes get `403 ACT_AS_READ_ONLY`.
- Audit rows of changes made while acting as a company also carry `actAsSessionId`, `adminName` and `actAsReason`.
- **Breaking:** `permissions` in `/auth/me` and login results now lists permission keys (`projects.project.view`, …) instead of the 8 old names (those are in `legacyPermissions` for now).
- **Breaking:** a missing permission is `403 PERMISSION_DENIED` with `details.permission` (was `403 FORBIDDEN`) on every company route and on the service checks that replaced owner-only role checks.
- Permissions are resolved from the database on every request (cached per user, invalidated by any change), so role / permission changes apply immediately instead of at the next token refresh. The JWT `perms` claim only carries the legacy names.
- `POST /auth/otp/request` answers `503 SMS_UNAVAILABLE` when the code could not be sent by SMS (or WhatsApp); the undelivered code is dropped so the user can retry at once (was a generic 500).
- `canSeeFinancials` is deprecated: it now means the financial permission bundle as overrides (`PATCH /users/:id` and invites still accept it).
- Offline sync follows permissions: tables the user can't view come back empty, sub-contract rates need `fields.rates`, a permission change makes the next incremental pull answer `resetRequired`, and pushed mutations without their permission are `REJECTED` with `PERMISSION_DENIED`.
- API test suite runs test files in parallel: one copy of the migrated `construction_test` database per Vitest worker (`construction_w<n>_test`, made with `CREATE DATABASE … TEMPLATE` and dropped afterwards), and every test restores the seed from a snapshot instead of re-seeding — the full suite takes about 2 minutes instead of ~20. `npm run test:serial` keeps the old one-file-at-a-time run; `TEST_MAX_WORKERS` / `TEST_DB_POOL_MAX` tune it (README → Tests).
- The API loads the Sentry SDK only through `instrument.ts` (request middlewares use a light `sentryScope.ts`), and `exceljs` only when a report is exported — faster start-up, same behaviour.

### Fixed
- No more pg "client.query() when the client is already executing a query" warnings: queries inside one transaction run one after another (`inSequence` in the company audit log, notifications list and super admin company data; `SerialPgClient` for Prisma's own parallel include loading). A test setup file (`tests/setup/pgConcurrency.ts`) fails any test that overlaps queries on one connection.
- Signed attachment files can be shown in the web app's PDF preview frame (`frame-ancestors` allows `APP_URL` / `CORS_ORIGINS`; no `X-Frame-Options` on file responses).

### Security
- Errors and traces sent to Sentry are scrubbed (emails, phones, CNICs, tokens, cookies, auth headers, every request body, secret URL params, IP address); the SDK's own collection of user info, cookies, bodies, query strings, SQL values and local variables is off. See `docs/SECURITY.md` §11.
- Sign-in routes (login, signup, OTP request / verify, forgot / reset password, admin login, invitation accept) also have a per-IP budget across all of them: `AUTH_IP_RATE_LIMIT_MAX` (30 / min). Invitation accept is limited per invitation token.
- Routes that send a code (OTP request, forgot password) are capped per IP: `OTP_SEND_IP_RATE_LIMIT_MAX` (20 / hour), against SMS pumping.
- The API refuses to start in production with console SMS, console email or local file storage (override for staging: `ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true`).
- `POST /sync/push` is limited per signed-in user: `SYNC_PUSH_RATE_LIMIT_MAX` (60 / min) → `429 RATE_LIMITED` (documented).
- `OTP_TTL_SECONDS` (login codes and SMS codes) must be 60–600 s; the API refuses to start with a longer lifetime.
- nodemailer 7 → 10.1 (SMTP command / header injection fixes; no API change for us), `mysql2` (Prisma CLI) forced to 3.24.5 via `overrides`. Remaining `npm audit` items are listed in `docs/SECURITY.md`.
- New `docs/SECURITY.md`: threat model, tenant isolation, permissions, act-as sessions, tokens and cookies, rate limits, secrets, pre-launch checklist. Tests for cookie flags in production, rate-limit wiring and login-code rules.

## 2026-10-12 — Worker types, remember me, invite links

### Added
- Company-defined worker types (`GET/POST/PATCH /worker-types`): names in English, Roman Urdu and Urdu, daily rate, overtime multiplier and an active flag. They are the company's DAILY labour rates.
- Workers return `typeLabel`, `typeLabelRoman` and `typeLabelUrdu`; offline sync pulls a new `worker_types` table; dashboard wages are grouped by any worker type.
- `rememberMe` on web and admin login (`POST /auth/login`, `POST /admin/auth/login`, default `true`). With `false`, cookies last only for the browser session, and refreshing tokens keeps that choice.
- Team invites and the new-company owner invite return `inviteUrl`, so the inviter can share the link on WhatsApp or SMS or copy it. A resend creates a new link and the old one stops working.

### Changed
- **Breaking:** `Worker.type` is now a company worker type key (or `OTHER`) instead of a fixed enum. Existing values are kept. New workers must use an active type key (`400 INVALID_WORKER_TYPE`).
- Default daily types get plain-English labels (Mason, Tile mason, Labourer, Steel-fixer helper, Watchman) unless a company already renamed them.
- Migration: `20261018090000_worker_types` (drops the `WorkerType` enum and backfills labels).

## 2026-10-08 — Super admin company data, act-as, munshi sign-in, email invites

### Added
- `npm run admin:create` script to create a platform admin.
- Platform admins can view a company's projects, team and activity (`GET /admin/tenants/:id/projects|team|activity`). Every view is audited.
- `X-Act-As-Tenant` header lets a platform admin work inside a company as a hidden system user.
- Munshi sign-in: a munshi can be given a login code (`POST /users/:id/login-code`) or set a password (`PUT /users/:id/password`).
- Email delivery over SMTP (`MAIL_PROVIDER=smtp`, `SMTP_*` settings): owner and team invites now go by SMS and email, and login codes are also emailed (`emailed` flag in the response). Email delivery is best effort.
- Migration: `20261017090000_system_user`.

## 2026-10-07 — Offline sync and daily logs

### Added
- Daily logs per project, with a day summary (`POST/GET /projects/:id/daily-logs`, `GET/PATCH /daily-logs/:id`).
- Offline sync for the mobile app: `GET /sync/pull` (cursor, scope, deletions), `POST /sync/push` (safe to retry, matched by `clientId`) and `GET /sync/status`.
- `GET /auth/mobile-config`; attachments can be uploaded by `clientId`.
- Records synced late (attendance, cash entries, dispatches, purchase receipts) are flagged `lateSync`.
- Alerts for missing daily logs and a job that cleans up old sync data.
- Migrations: `20261016090000_daily_logs`, `20261016100000_sync_changes`, `20261016110000_sync_push`.

### Security
- Revoked devices are refused.

## 2026-10-06 — Labour, cash book, billing, dashboard and reports

### Added
- Labour: team on site, hazri (attendance), work measurements, peshgi (advances), weekly settlements, sub-contractor accounts and office summaries.
- Cash book: cash accounts, floats with acknowledgement, kharcha (expenses) with an approval limit, top-ups, counts, handovers and a project cash book.
- Billing: payment schedule, running-bill progress, invoices (`INV-YYYY-####`) with tax and project credit, owner payments (`RV-YYYY-####`) with allocation, cheque clear/bounce, receivables, owner statements, billing alerts and a nightly overdue job.
- Invoice, receipt and statement PDFs with ready-made WhatsApp share text.
- Company settings for payment terms, tax rate/label, and whether a PM can record payments.
- Notifications (in-app, plus SMS for critical events, de-duplicated over 24 hours) for procurement, dispatch, labour, cash, billing, subscription and team events.
- Approvals inbox with bulk actions, company dashboard and munshi site dashboard.
- Finance views (receivables ageing, cash-flow outlook, P&L by cost bucket, cash floats) and seven reports as JSON, CSV, Excel or PDF via signed links.
- Migrations: `20261009090000_labor_cashbook`, `20261010090000_billing_receivables`, `20261015090000_notifications_reports`.

### Changed
- Munshis may list suppliers; site-cash purchases and shortage charges now post to the cash book and sub-contract accounts.

## 2026-10-05 — Procurement and inventory

### Added
- Stock locations and a stock ledger with weighted-average cost.
- Purchase orders, purchases (to store, direct to site, munshi purchases awaiting rates), returns and corrections.
- Supplier ledger with ageing and payments.
- Dispatches with SMS, blind-count receiving, shortages and their resolution, owner deliveries, material usage and stock counts.
- Gap-free document numbers.
- Migration: `20261008090000_procurement_inventory`.

### Fixed
- A busy database now answers `503 SERVICE_BUSY` instead of `500` (larger connection pool, 10 s transaction wait).

## 2026-10-04 — Master data, clients and projects

### Added
- Platform material catalog copied into every company on signup; admins can push catalog changes to companies.
- Materials, quality categories, price list with rate history and bulk percent changes, labour rates, payment templates, suppliers with agreed rates, workers and sub-contractors.
- Clients (project owners without login).
- Project wizard: basics, team, contract and billing stages, plot and floors, coverage, rooms and openings with area calculations; review, activation and status changes.
- PMs and munshis see only their assigned projects; financial fields are hidden without billing permission.
- Migrations: `20261006090000_master_data`, `20261007090000_clients`, `20261007100000_projects`.

### Changed
- The project plan limit counts ACTIVE and CLOSEOUT projects.

## 2026-10-03 — Core platform

### Added
- Multi-tenant API with tenant isolation through PostgreSQL row-level security.
- Sign-in for web (cookies) and mobile (bearer tokens), phone OTP login, invitations and platform admin login.
- Swagger docs with ready-to-run examples for the seed accounts.
- Attachments: uploads up to 10 MB with file-type checks and signed download links; local or Cloudinary storage.
- Company profile, business settings and holiday calendar.
- Team management: users, invitations by Roman Urdu SMS (resend, cancel) and device revocation.
- Subscriptions: plans, manual payment slips (JazzCash, Easypaisa, Raast, IBFT), plan changes, plan limits and a daily lifecycle job (trial end, grace, lapse, reminder SMS). Lapsed companies become read-only.
- Platform admin console: overview and health, company management, payment review with receipts (`RCPT-YYYY-NNNN`), plans, platform holidays and audit log.
- Migrations: `20261002192308_init_core_auth`, `20261003120000_company_team`, `20261003130000_tenant_logo_fk`, `20261003140000_auth_indexes`, `20261004090000_subscription`, `20261005090000_platform_admin`.

### Security
- Refresh-token rotation with reuse detection.
- Access tokens are re-checked on every request, so logout, deactivation and device revocation take effect immediately.
- Fixes from review: OTP attempt race, company leak in password reset, login timing, invite cancel/accept race, seat reservation and secrets in logs.
