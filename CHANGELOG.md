# Changelog

All notable changes to the Construction Platform API are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no version tags yet, so releases are listed by date.

> **Adding entries:** put each change under `## [Unreleased]` in the right group (Added / Changed / Fixed / Removed / Security), as one short plain-English line about what users or API clients notice. Call out breaking API changes and name any new `prisma/migrations` folder.

## [Unreleased]

_Nothing yet._

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
