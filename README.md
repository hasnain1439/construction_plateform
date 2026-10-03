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
- Logging out revokes the session. Access tokens are stateless and stay valid until they expire (max 15 min).

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

## Tests

`npm test` uses `.env.test` (copy `.env.test.example`). Global setup creates the `construction_test` database and applies the migrations; every test starts from a truncated + re-seeded database. The suite refuses to run against a database whose name doesn't end in `_test`.
