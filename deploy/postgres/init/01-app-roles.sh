#!/bin/sh
# Runs ONCE, when the Postgres container starts with an empty data volume
# (docker-entrypoint-initdb.d). Creates the two application roles the API connects as —
# the same roles and flags as prisma/roles.sql / scripts/db-setup.ts, with the passwords from .env:
#
#   app_user  LOGIN NOBYPASSRLS  — DATABASE_URL, row-level security applies
#   app_admin LOGIN BYPASSRLS    — DATABASE_ADMIN_URL, cross-tenant auth + platform admin only
#
# Table privileges are granted by the migrations (prisma/rls.sql and every later migration), so
# run `docker compose run --rm migrate` after this. To change a password later:
#   docker compose exec postgres psql -U postgres -c "ALTER ROLE app_user PASSWORD '…'"
set -eu

: "${APP_USER_PASSWORD:?APP_USER_PASSWORD is required}"
: "${APP_ADMIN_PASSWORD:?APP_ADMIN_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user_pw="$APP_USER_PASSWORD" -v app_admin_pw="$APP_ADMIN_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_user_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') \gexec
SELECT format('CREATE ROLE app_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD %L', :'app_admin_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO app_user, app_admin', :'db') \gexec
-- Nobody else may connect by default (Postgres grants CONNECT / TEMP to PUBLIC).
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL

echo "app_user / app_admin roles ready"
