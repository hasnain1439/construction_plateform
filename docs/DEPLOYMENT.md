# Deployment

How the Construction Platform (API + web, plus the mobile app's builds) is run on a single VPS per
environment, released from GitHub, backed up and rolled back. Providers (SMS, email, files, WhatsApp)
are covered in [README → Providers](../README.md#providers); security in [SECURITY.md](SECURITY.md).

```
              ┌──────────────── VPS (Ubuntu 24.04, Docker) ────────────────┐
 browser ───► │ Caddy :443 ── app.example.pk ──► web  (Next.js :3000) ──┐   │
 mobile  ───► │ (HTTPS)    ── api.example.pk ──► api  (Express :4000) ◄─┘   │
              │                                   │  /api/v1 proxied        │
              │                                   ▼                         │
              │                               postgres:18 (volume pgdata)   │
              └─────────────────────────────────────────────────────────────┘
```

| File | What it is |
|---|---|
| `Dockerfile` (this repo) | API image: Node 24 slim, `npm ci` → `prisma generate` → `tsc` → production deps (+ Prisma CLI), Playwright chromium for PDFs, user `node`, `HEALTHCHECK /health`. Commands: `start` (default), `migrate`, `migrate-status`. |
| `construction-web/Dockerfile` | Web image: Next.js `output: "standalone"`, Node 24 alpine, user `node`, `HEALTHCHECK /api/health`. |
| `deploy/docker-compose.prod.yml` | postgres, one-shot `migrate`, api, web, caddy. |
| `deploy/docker-compose.build.yml` | Override that builds both images from source (local smoke test). |
| `deploy/Caddyfile` | HTTPS for both domains, security headers, compression, JSON access logs. |
| `deploy/postgres/init/01-app-roles.sh` | Creates `app_user` / `app_admin` on the first start of an empty volume. |
| `deploy/deploy.sh` | Pull → migrate → `up -d --wait` → readiness check; records tags in `.deploy-history`. |
| `deploy/env/*.env.example` | `staging` / `production`: stack settings (`.env`) and API settings (`api.env`). |
| `scripts/backup/pg-backup.sh`, `restore-check.sh` | Nightly dump with retention + upload hook; restore test into a scratch database. |
| `.github/workflows/` | `ci.yml` (PRs), `release.yml` (main → staging), `deploy-production.yml` (manual). |

**Why the compose file lives in the API repo:** the API owns the database, migrations, roles and
backups, and its release workflow uploads `deploy/` to the server. The web repo only builds its image
and calls the same `deploy.sh --web <tag>`.

---

## 1. Server (once per environment)

Staging and production are **separate servers** (or at least separate Docker hosts): both stacks bind
ports 80/443 and use the same compose project name. A 2 vCPU / 4 GB / 40 GB SSD VPS is enough for the pilot
(chromium for PDFs is the biggest memory user). Pick a region close to Pakistan (e.g. Bahrain, Mumbai, Frankfurt).

```bash
# as root on a fresh Ubuntu 24.04
apt update && apt upgrade -y
adduser --disabled-password --gecos "" deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh

# Docker Engine + compose plugin (official repository)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker deploy          # the deploy user runs compose (docker group = root-equivalent: protect this key)

# Firewall: SSH + HTTP(S) only. Postgres is never published.
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw enable

# SSH: keys only
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh

# Security updates, time zone for logs/cron
apt install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
timedatectl set-timezone Asia/Karachi

# App + backup folders
mkdir -p /opt/construction /var/backups/construction
chown deploy:deploy /opt/construction /var/backups/construction
chmod 700 /var/backups/construction
```

> Docker publishes ports past ufw's rules; only Caddy publishes any (80/443), so that is fine. Do not add `ports:` to postgres / api / web.

**Pull access to GHCR** (images are private by default): create a GitHub *fine-grained* or classic
token with **`read:packages`** only, then as `deploy`:

```bash
echo '<token>' | docker login ghcr.io -u <github-user> --password-stdin
```

## 2. Domain and DNS

At your DNS provider create, for each environment:

| Record | Name | Value |
|---|---|---|
| A (and AAAA if the VPS has IPv6) | `app.example.pk` | production server IP |
| A / AAAA | `api.example.pk` | production server IP |
| A / AAAA | `staging.example.pk`, `api.staging.example.pk` | staging server IP |
| CAA (optional) | `example.pk` | `0 issue "letsencrypt.org"` |

Wait until `dig +short app.example.pk` returns the IP **before** the first start — Caddy requests the
certificates on start-up. If you use Cloudflare, set the records to *DNS only* (grey cloud) at first;
proxied mode also works later with SSL mode "Full (strict)". E-mail DNS (SPF / DKIM / DMARC for SES)
is in [README → Providers](../README.md#email--amazon-ses-mail_providerses).

## 3. SSL (Caddy)

Nothing to buy or configure: `deploy/Caddyfile` serves `{$APP_DOMAIN}` → web and `{$API_DOMAIN}` → api,
gets Let's Encrypt certificates automatically (HTTP-01 / TLS-ALPN on ports 80/443), renews them,
redirects HTTP → HTTPS and enables HTTP/3. Certificates live in the `caddy_data` volume (keep it; deleting
it re-issues and may hit rate limits). While testing DNS / firewall, uncomment the `acme_ca` staging line
in the Caddyfile. Headers: HSTS, nosniff, Referrer-Policy, Permissions-Policy are added when the app did not set them;
the web app's CSP and the API's helmet headers are kept.

## 4. Environment files

The first deploy (GitHub Actions or a manual `scp`) copies `deploy/` to `/opt/construction`. Then, as `deploy`:

```bash
cd /opt/construction
cp env/production.env.example .env            # staging server: env/staging.env.example
cp env/production.api.env.example api.env     # staging server: env/staging.api.env.example
chmod 600 .env api.env
nano .env api.env
```

- **`.env`** (compose): domains, `ACME_EMAIL`, image names (`ghcr.io/<owner-lowercase>/construction-api|web`), tags,
  Postgres superuser + `app_user` / `app_admin` passwords (`openssl rand -hex 32` — hex, they go into URLs),
  backup settings. The API never sees the superuser password.
- **`api.env`** (API container): JWT secrets (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
  different per environment), SMS / mail / storage / WhatsApp providers, Sentry / PostHog.
  `NODE_ENV`, `PORT`, `TRUST_PROXY=1`, `DATABASE_URL`, `DATABASE_ADMIN_URL`, `APP_URL`, `API_PUBLIC_URL`,
  `CORS_ORIGINS`, `STORAGE_DIR` are set by the compose file from `.env`.
- **Production** refuses to start with console SMS / mail or local storage. **Staging** may keep them with
  `ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true` (the example does; codes are printed in `docker compose logs api`).
- The **web** settings are baked into its image at build time (GitHub environment variables, see §10).

Never commit filled-in files (`deploy/.env`, `deploy/api.env`, `deploy/env/*.env` are git-ignored).

## 5. First start and migrations

```bash
cd /opt/construction
docker compose -f docker-compose.prod.yml up -d postgres           # first start runs postgres/init/01-app-roles.sh
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate   # prisma migrate deploy (schema + RLS + grants)
docker compose -f docker-compose.prod.yml up -d --wait
./deploy.sh                                                        # same thing in one go, plus the readiness check
```

Create the first platform admin (one-off; the image has no `tsx`, so run it from a checkout on your PC through an SSH tunnel,
or temporarily with the repo on the server):

```bash
ssh -L 15432:localhost:15432 deploy@server \
  "docker run --rm --network construction_default -p 127.0.0.1:15432:5432 alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:postgres:5432"
# on your PC, with DATABASE_ADMIN_URL / DATABASE_MIGRATION_URL pointing at localhost:15432:
npm run admin:create
```

**Migrations** run only through the one-shot `migrate` service (`deploy.sh` does it before restarting the
API; never on every container start). They are forward-only: write migrations so the previous API version still
works with the new schema (add columns / tables first, drop in a later release) — that keeps image rollbacks safe.
Check state: `docker compose -f docker-compose.prod.yml --profile tools run --rm migrate migrate-status`.

## 6. Health checks

| Check | Where | Meaning |
|---|---|---|
| `GET https://api.example.pk/health` | Docker `HEALTHCHECK`, Caddy upstream check | API process alive (no DB) |
| `GET https://api.example.pk/health/ready` | `deploy.sh` after every deploy, uptime monitor | DB, file storage and scheduler OK → `200`, else `503 NOT_READY` with details |
| `GET https://app.example.pk/api/health` | web `HEALTHCHECK`, Caddy | Next.js server alive |
| `pg_isready` | postgres healthcheck | API / migrate wait for it |

`docker compose -f docker-compose.prod.yml ps` shows `healthy` per container. Add an external uptime monitor
(UptimeRobot, Better Stack, Healthchecks.io) on `/health/ready` and `https://app.example.pk/api/health`.

## 7. Releases (GitHub Actions)

| Workflow | Trigger | Does |
|---|---|---|
| API `ci.yml` | pull request | `npm ci`, `prisma generate`, typecheck, Postgres 18 service → `db-setup` (roles) → `migrate deploy` on an empty DB → drift check → `npm test`; Docker build (no push) |
| API `release.yml` | push to `main` | CI → push `construction-api:sha-<7>` + `:main` → upload `deploy/` + `scripts/backup/` to staging → `deploy.sh --api sha-<7>` |
| API `deploy-production.yml` | manual (tag, migrate on/off) | `production` environment approval → tag `:production` → pre-deploy backup → `deploy.sh --api <tag>` |
| Web `ci.yml` | pull request | `npm ci`, typecheck, lint, unit tests, `next build` |
| Web `release.yml` | push to `main` | CI → build with staging settings → `construction-web:staging-<7>` → `deploy.sh --web … --no-migrate` |
| Web `deploy-production.yml` | manual (commit) | `production` approval → build with production settings → `construction-web:production-<7>` → deploy |
| Mobile `ci.yml` | pull request / main | typecheck, lint, jest |
| Mobile `eas-build.yml` | manual (profile, platform) | typecheck + tests → `eas build --profile <profile>` |

Typical flow: merge to `main` → staging updates itself → test on staging → run **Deploy production** with
the same API tag (`sha-…`) and the same web commit.

## 8. Backups

`scripts/backup/pg-backup.sh` runs `pg_dump -Fc` **inside the postgres container** (so client and server
versions match), writes `$BACKUP_DIR/construction_<UTC time>.dump` + `.sha256`, verifies it with
`pg_restore --list`, runs the optional upload hook and deletes dumps older than `BACKUP_RETENTION_DAYS`.
Settings come from `/opt/construction/.env` (`BACKUP_COMPOSE_DIR`, `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_UPLOAD_CMD`).

```bash
# crontab -e   (as deploy) — nightly 02:30 PKT, weekly restore test Sunday 04:00
30 2 * * * /opt/construction/backup/pg-backup.sh --env-file /opt/construction/.env >> /var/backups/construction/backup.log 2>&1
0 4 * * 0  /opt/construction/backup/restore-check.sh --env-file /opt/construction/.env >> /var/backups/construction/restore-check.log 2>&1
```

**Off-site copies** (a dump on the same disk is not a backup): install `rclone`, configure a remote
(Cloudflare R2 / S3 / Backblaze B2 bucket with object lock or versioning, a key limited to that bucket), and set
`BACKUP_UPLOAD_CMD='rclone copy --immutable "$1" r2:construction-backups/production/'`. Encrypt if the bucket is
not under your control (`rclone crypt` remote). Set a bucket lifecycle rule (e.g. 90 days). Uploaded files
(S3 / R2 bucket) are separate from the DB backup — enable versioning on that bucket too.

Locally (Windows / dev): `npm run db:backup -- --env-file .env` dumps `DATABASE_MIGRATION_URL` into `./backups`
(set `PG_BIN_DIR` if `pg_dump` is not on PATH; Git Bash).

## 9. Restore

**Test (non-destructive)** — `scripts/backup/restore-check.sh` restores the newest dump (or `--file X`) into a
scratch database `restore_check_<time>`, checks: checksum, `pg_restore --exit-on-error`, `_prisma_migrations`
present with no failed rows, number of applied migrations = migration folders (when the repo is next to it), core
tables, RLS enabled + forced on every `tenantId` table, prints exact row counts per table, then drops the scratch DB
(`--keep` leaves it). Exit code 1 on any failure. `npm run db:restore-check -- --env-file .env` locally.

**Real restore** (data loss / bad migration):

```bash
cd /opt/construction
docker compose -f docker-compose.prod.yml stop api web                         # no writes during the restore
./backup/pg-backup.sh --env-file .env                                          # keep the current state too
docker compose -f docker-compose.prod.yml exec -T postgres psql -U postgres -c "DROP DATABASE construction WITH (FORCE)" -c "CREATE DATABASE construction"
docker compose -f docker-compose.prod.yml exec -T postgres psql -U postgres -c "GRANT CONNECT ON DATABASE construction TO app_user, app_admin" -c "REVOKE ALL ON DATABASE construction FROM PUBLIC"
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore --exit-on-error -U postgres -d construction < /var/backups/construction/construction_<time>.dump
./deploy.sh --api <tag that matches that dump's migrations> --no-migrate       # or plain ./deploy.sh to migrate forward
```

The roles `app_user` / `app_admin` are cluster-wide, not in the dump; on a brand-new server they are created by the
init script (same passwords as in `.env`) before you restore.

## 10. Rollback

- **Bad API release, no migration in it:** `./deploy.sh --api sha-<previous> --no-migrate` on the server, or run
  **Deploy production** with the previous tag and *migrate* off. Previous tags: `/opt/construction/.deploy-history`,
  GHCR package page, or the release run.
- **Bad web release:** `./deploy.sh --web production-<previous> --no-migrate` (or **Deploy production** in the web repo with the previous commit).
- **Bad migration:** migrations are not rolled back automatically. Prefer a new forward migration that fixes it. If data is
  damaged, restore the dump taken before the deploy (production deploys take one automatically) as in §9, then deploy the
  previous API tag with `--no-migrate`.

## 11. Staging vs production

| | Staging | Production |
|---|---|---|
| Server / domains | separate VPS, `staging.example.pk`, `api.staging.example.pk` | `app.example.pk`, `api.example.pk` |
| Deploys | automatically on every push to `main` | manual workflow + reviewer approval (`production` environment) |
| API image | `sha-<7>` (same image is later promoted) | the tested `sha-<7>` + moving `:production` tag |
| Web image | `staging-<7>` (staging URLs / keys baked in) | `production-<7>` (rebuilt from the same commit with production settings) |
| Providers | console SMS / mail, local files allowed (`ALLOW_DEV_PROVIDERS_IN_PRODUCTION=true`) or real ones to rehearse | real SMS gateway, SES, S3 / R2 — required |
| Secrets | own JWT secrets, own DB passwords | own JWT secrets, own DB passwords |
| Backups | 7 days | 14 days + off-site |
| Sentry | `SENTRY_ENVIRONMENT=staging`, traces 100 % | `production`, traces 10 % |

## 12. Observability keys

- **API** (`api.env`): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`; `SENTRY_RELEASE` is baked in the image as
  `construction-api@<git sha>`. `POSTHOG_KEY`, `POSTHOG_HOST`. Empty = off. See README → Observability.
- **Web** (GitHub environment *variables*, baked at build): `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_KEY`,
  `NEXT_PUBLIC_POSTHOG_HOST`, `SENTRY_ORG`, `SENTRY_PROJECT`; secret `SENTRY_AUTH_TOKEN` for source maps. Server-side DSN
  override at runtime: `WEB_SENTRY_DSN` in `.env`.
- **Mobile**: EAS environment variables (`EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_KEY`, `SENTRY_AUTH_TOKEN`).
- Logs: `docker compose -f docker-compose.prod.yml logs -f api` (pino JSON, rotated by Docker: 5 × 20 MB per container).

## 13. GitHub set-up (owner checklist)

1. **Packages**: the workflows push to `ghcr.io/<owner>/construction-api` / `construction-web` with `GITHUB_TOKEN`
   (no set-up). After the first push, keep the packages private and give the server a `read:packages` token (§1).
2. **Environments** (each repo, Settings → Environments): `staging` and `production`.
   - `production`: *Required reviewers* (you), *Deployment branches*: `main` only.
   - Secrets in both (API and web repos): `SSH_HOST`, `SSH_USER` (`deploy`), `SSH_PRIVATE_KEY` (a dedicated
     ed25519 key whose public half is in `/home/deploy/.ssh/authorized_keys`), `SSH_KNOWN_HOSTS`
     (output of `ssh-keyscan -t ed25519 <host>`, checked against the server's fingerprint).
   - Variables: `STAGING_URL` / `PRODUCTION_URL` (shown on the run), `DEPLOY_PATH` (optional).
   - Web only — variables `API_PUBLIC_URL` (`https://api.example.pk`), optional `NEXT_PUBLIC_SENTRY_DSN`,
     `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `SENTRY_ORG`, `SENTRY_PROJECT`; secret `SENTRY_AUTH_TOKEN` (optional).
3. **Mobile repo**: repository secret `EXPO_TOKEN` (expo.dev → Access tokens), `npx eas init` once to link the project,
   EAS environment variables per profile (`EXPO_PUBLIC_API_BASE_URL=https://api.example.pk/api/v1` …).
4. **Branch protection** on `main`: require the CI checks to pass before merging.

## 14. Troubleshooting

| Symptom | Look at |
|---|---|
| Caddy keeps failing to get a certificate | DNS not pointing at the server yet, ports 80/443 closed at the provider's firewall, `docker compose logs caddy` |
| `migrate` fails `P1000` / `role "app_user" does not exist` | The volume was created before the init script existed or with other passwords: create / `ALTER ROLE` by hand (see the header of `postgres/init/01-app-roles.sh`) |
| API exits at start with an env error | `docker compose logs api` — the Zod message names the setting; production also refuses console / local providers |
| `/health/ready` 503 | `error.details` names the failing check (database, storage, scheduler) |
| PDFs answer `503 PDF_UNAVAILABLE` | image built with `INSTALL_CHROMIUM=false`, or too little memory for chromium |
| Web shows "cannot reach server" | web image built with a wrong `API_ORIGIN` (must be `http://api:4000` in this stack) |
