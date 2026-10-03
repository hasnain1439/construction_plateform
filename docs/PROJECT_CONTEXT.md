# PROJECT CONTEXT — Construction Platform API

Paste this at the start of a new AI/dev session. README.md is the detailed source of truth.

Backend for a multi-tenant Construction Management SaaS for Pakistani construction companies, in `D:\metaviz\construction-platform` (Windows 10 + PowerShell). Extend it following the existing patterns; don't rebuild what exists.

## Status

| Step | Modules | State |
|---|---|---|
| Phase 1 · Step 1 | Core infrastructure, **Auth** | done |
| Phase 1 · Step 2 | **Attachments**, **Company**, **Team** (users, invitations, devices) | done |
| Phase 1 · Step 3A | **Subscription** (company side), plan limits helper, lifecycle job | done |
| Phase 1 · Step 3B | **Platform admin** console: overview/health, companies, payment review + receipts, plans, holidays, audit log | done |

Tests: 235 passing in 30 files. Migrations: `init_core_auth`, `company_team`, `tenant_logo_fk`, `auth_indexes`, `subscription`, `platform_admin`.

## Stack
Node 24, Express 5, TypeScript 7 (strict ESM, NodeNext → imports end in `.js`), Prisma **7.10.0** (pinned; `@prisma/adapter-pg`; client generated to `src/generated/prisma`), PostgreSQL 18, Zod 4, zod-to-openapi 9, pino, jsonwebtoken, bcryptjs, multer 2, Vitest 5 + Supertest. Do not upgrade Prisma to 8 (npm `latest` is an RC).

## Product rules
- Tenant = construction company. Roles THEKEDAR (owner), PM, MUNSHI (site, phone OTP). PLATFORM_ADMIN is a separate table.
- Tenant always comes from the verified token (`ctx.tenantId`), never headers/query/URL.
- Web = httpOnly cookies; mobile = tokens in body + `Authorization: Bearer`; body `client: "web" | "mobile"`.
- Money BigInt paisa (sent as strings). IDs UUID v7. Times UTC. Phones E.164 `+92…` (mobile via `normalizePkPhone`, office/landline via `normalizePkAnyPhone`).
- Responses `{ success, data, meta? }` / `{ success: false, error: { code, message, details? } }`.
- Office users (plan limit) = active THEKEDAR + PM; Munshis are free; pending PM invites reserve a seat.

## Database & security
- `DATABASE_URL` app_user (RLS) → `withTenant(tenantId, tx => …)` for everything tenant-scoped.
- `DATABASE_ADMIN_URL` app_admin (BYPASSRLS) → `prismaAdmin`, allowed only in `src/modules/auth/**`, `src/modules/platform-admin/**`, seed, scripts, tests (guard test enforces).
- `DATABASE_MIGRATION_URL` superuser → Prisma CLI only.
- RLS: ENABLE + FORCE + `tenant_isolation` policy on every `tenantId` table (`prisma/rls.sql`). New tenant tables need the policy and an explicit `GRANT … TO app_user` in their migration. Composite `(tenantId, id)` FKs for tenant-scoped parents — **but never include a model's own `id` in relation fields** (Prisma then stops generating its default; see `tenant_logo_fk`).
- `prisma migrate dev` refuses non-interactive runs with warnings and `migrate reset` is blocked for AI agents: generate SQL with `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-edit renames, save as a migration folder, `prisma migrate deploy`.

## Core (src/core, src/config)
env (Zod), logger (redacted), requestContext (ALS), AppError family, response/asyncHandler/pagination (`paginationQuery`, `skipTake`, `pageMeta`), utils (json BigInt, phone, crypto, slug, dates `isoDateSchema`/`todayIn`, `uuidv7`), auth (permissions, jwt), audit `writeAudit(tx, …)`, OpenAPI registry + light-theme Swagger at `/api/docs` with named examples (`jsonBody(schema, examples)`), middlewares.

**Standard chain:** `authenticate → tenantContext → readOnlyGuard → requireRole/requirePermission → validate → asyncHandler(controller)`.
**Module layout:** routes / controller (no logic) / service (transactions, audit) / repository (Prisma, takes `tx`) / schema (Zod + types) / docs.

## Modules
- **auth** — signup, password + OTP login, MULTIPLE_COMPANIES, refresh rotation + reuse detection (recomputes role/permissions from DB), logout(-all), forgot/reset, me, sessions, invitation accept (public), platform admin auth. SMS/mail providers (console in dev, outbox in tests).
- **attachments** — multipart upload ≤ 10 MB with per-kind types + magic-byte check; `StorageProvider` — `local` (default, `STORAGE_DIR`, HMAC-signed `/attachments/:id/file?tid&exp&sig`) or `cloudinary` (authenticated assets, `cloudinary:<resource_type>:<public_id>` keys, expiring `private_download_url`, optional thumbnails); `storageForKey()` picks the provider per stored key; links expire after `SIGNED_URL_TTL_SECONDS` (600). `signedUrlFor(att, { thumbnailWidth })` for other modules.
- **company** — profile (NTN, logo of kind LOGO, landline phone), settings (kharcha limit paisa, overuse %, missing-log time, quote validity, tax, pmCanSeeFinancials, default language), holidays (platform + company merge; seed has fixed national holidays).
- **team** — users (list with usage meta, detail, edit role/financials/phone, soft deactivate + revoke, reactivate, project assignment), invitations (create with Roman Urdu SMS, list with lazy expiry, resend 60 s, cancel), devices (list with sync fields, revoke). Hook `assertNoOpenCashBalance()` waits for the cash module.
- **subscription** — GET status/usage/limits, plans, payments (manual slip: JazzCash/Easypaisa/Raast/IBFT, amount = plan price, global unique transaction id, one pending at a time, allowed while READ_ONLY), change-plan (upgrade pending until approval; downgrade at period end with keepActiveProjectIds). Statuses TRIAL/ACTIVE/GRACE → company ACTIVE, LAPSED → READ_ONLY (`subscription.status.ts`).
- **core/plan/planLimits.ts** — `getUsage`, `getLimits`, `assertWithinLimit(tx, tenantId, 'activeProjects'|'officeUsers')` → 402; office users include pending PM invites. Projects module must use it.
- **jobs** — `src/jobs/subscriptionLifecycle.ts` (trial end → LAPSED, period end → GRACE +3 d → LAPSED, scheduled downgrades, 3-day/1-day reminder SMS), scheduled in-process at start-up + 02:00 PKT with `pg_try_advisory_lock`; `npm run jobs:subscriptions`. `src/jobs/**` may use prismaAdmin.
- **platform-admin** (`/api/v1/admin`, prismaAdmin allowed) — overview (counts, MRR, revenue), health (+ `JobRun`), tenants (list/detail, create TRIAL/PAID with a THEKEDAR invite, status actions, plan change), payments (queue with duplicate warnings, approve → period/plan/receipt `RCPT-YYYY-NNNN`/company ACTIVE/SMS, reject with reason), plans CRUD, platform holidays CRUD, audit log. Every write audited as PLATFORM_ADMIN.
- **subscription.rules.ts** — `assertPlanFits` / `parkProjectsOverLimit`, shared by company change-plan, admin plan change, payment approval and the lifecycle job. `planLimits` filters by tenantId explicitly (safe under prismaAdmin).
- **health**, **projects** (stub model only — status `READ_ONLY` exists for downgrades).

## Seed (`npm run db:seed`, idempotent)
Plans TRIAL / STARTER (3 office users) / PROFESSIONAL (10) / ENTERPRISE. Platform admin `admin@platform.local` / `Admin#2026`.
Malik & Sons Builders (Professional, NTN 1234567-8): Khalid THEKEDAR `03001234567` / `Thekedar#2026`; Bilal PM `03331112233` / `Bilal#2026`; Rafaqat MUNSHI `03211234567` (OTP).
Ahmed Constructions (Starter): Ahmed THEKEDAR `03331234567` / `Ahmed#2026`; Rafaqat also MUNSHI here; Easypaisa payment `EP2610010042` pending review.
Malik: ACTIVE Professional, period ends in 12 days, 3 approved payments (RCPT-2026-0371/0372/0381).
Valley Builders (GRACE, Zubair `03451000001` / `Valley#2026`), Old Town Contractors (LAPSED + READ_ONLY, Nasir `03451000002` / `OldTown#2026`).
Pending PM invite Kamran Shah `03009988776`, token `dev-invite-kamran-shah-2026-0001`.

## Tests
`npm test` → `.env.test` → `construction_test` (setup runs `db-setup` + `migrate deploy`; each test truncates + re-seeds; refuses non-`_test` DBs). Helpers: `api`, `useFreshDatabase`, `loginMobile`, `loginMunshi`, `refreshMobile`, `lastOtp`, `upload`, `pngBytes`, `pathOf`, `bearer`.

## Known notes
- Access tokens are re-checked on every company request (user ACTIVE, device not revoked, session family alive), so logout/deactivate/revoke cut access at once. Role/permission changes apply at the next refresh (≤ 15 min).
- Prisma 7.10's query engine triggers a `pg` "client.query() already executing" deprecation warning inside interactive transactions — upstream, harmless until pg@9.
- `npm audit` reports high-severity transitive issues (not force-fixed).
- Git commits show author "unknown" until `git config --global user.name` is set.

## Next task
<write the next step here, e.g. "PHASE 1 · STEP 3: Projects module (CRUD, plan project limit, site details, team assignment)">
