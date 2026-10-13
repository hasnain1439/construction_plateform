#!/usr/bin/env bash
# Proves the latest backup can be restored: restores it into a scratch database on the same
# server, runs sanity checks, prints row counts, then drops the scratch database.
#
#   scripts/backup/restore-check.sh [--env-file FILE] [--file DUMP] [--keep]
#   npm run db:restore-check -- --env-file .env
#
#   --file DUMP   check this dump instead of the newest $BACKUP_DIR/<prefix>_*.dump
#   --keep        leave the scratch database (restore_check_<timestamp>) for inspection
#
# Checks (exit code 1 when one fails):
#   - pg_restore --exit-on-error succeeds (with owners and grants, so app_user / app_admin must exist)
#   - _prisma_migrations exists, has rows, none failed / rolled back / unfinished
#   - the number of applied migrations equals the folders in prisma/migrations (when that folder is here)
#   - core tables exist (Tenant, User, Project, AuditLog) and RLS is enabled + forced on tenant tables
# Settings: see common.sh. The connection must be allowed to CREATE / DROP DATABASE.
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

DUMP=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) load_env_file "${2:?--env-file needs a path}"; shift 2 ;;
    --file) DUMP="${2:?--file needs a path}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

setup_pg_commands
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1 "$BACKUP_DIR"/"${BACKUP_PREFIX}"_*.dump 2>/dev/null | sort | tail -n 1 || true)"
  [ -n "$DUMP" ] || die "no ${BACKUP_PREFIX}_*.dump in $BACKUP_DIR"
fi
[ -s "$DUMP" ] || die "dump not found or empty: $DUMP"

if [ -f "$DUMP.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$DUMP")" && sha256sum --quiet -c "$(basename "$DUMP").sha256") || die "checksum mismatch: $DUMP"
  log "checksum ok"
fi

SCRATCH="restore_check_$(date -u +%Y%m%d%H%M%S)"
MAINT_URL="$(with_db "$BACKUP_DATABASE_URL" postgres)"
SCRATCH_URL="$(with_db "$BACKUP_DATABASE_URL" "$SCRATCH")"
psql_maint() { "${PSQL[@]}" --no-psqlrc -v ON_ERROR_STOP=1 -X -q --dbname="$MAINT_URL" "$@"; }
psql_scratch() { "${PSQL[@]}" --no-psqlrc -v ON_ERROR_STOP=1 -X -q -At --dbname="$SCRATCH_URL" "$@"; }

cleanup() {
  if [ "$KEEP" = 1 ]; then
    log "kept scratch database $SCRATCH (drop it with: DROP DATABASE \"$SCRATCH\";)"
  else
    psql_maint -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 || echo "warning: could not drop $SCRATCH" >&2
  fi
}

log "restoring $(basename "$DUMP") into scratch database $SCRATCH"
psql_maint -c "CREATE DATABASE \"$SCRATCH\""
trap cleanup EXIT
started=$(date +%s)
"${PG_RESTORE[@]}" --exit-on-error --no-password --dbname="$SCRATCH_URL" < "$DUMP"
log "restored in $(( $(date +%s) - started ))s"

FAIL=0
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; else echo "  FAIL $1: expected $2, got $3"; FAIL=1; fi
}
q() { psql_scratch -c "$1" | tr -d '\r'; }

echo "Sanity checks:"
has_table=$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations'")
check "_prisma_migrations table present" 1 "$has_table"
if [ "$has_table" = 1 ]; then
  applied=$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
  broken=$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")
  check "failed / unfinished migrations" 0 "$broken"
  [ "$applied" -gt 0 ] && echo "  ok   applied migrations ($applied, latest: $(q "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1"))" || { echo "  FAIL no applied migrations"; FAIL=1; }
  MIGRATIONS_DIR="${MIGRATIONS_DIR:-$(dirname "$0")/../../prisma/migrations}"
  if [ -d "$MIGRATIONS_DIR" ]; then
    expected=$(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
    check "applied migrations = folders in prisma/migrations" "$expected" "$applied"
  fi
fi
for t in Tenant User Project AuditLog; do
  check "table \"$t\" present" 1 "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = '$t'")"
done
tenant_tables=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenantId'")
rls_tables=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'tenantId' WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity")
tenant_base_tables=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'tenantId' WHERE n.nspname = 'public' AND c.relkind = 'r'")
[ "$tenant_tables" -gt 0 ] || { echo "  FAIL no tenant tables"; FAIL=1; }
check "tenant tables with RLS enabled + forced" "$tenant_base_tables" "$rls_tables"

echo "Row counts (exact):"
psql_scratch -F $'\t' -c "
  SELECT format('SELECT %L AS table_name, count(*) FROM %I.%I', tablename, schemaname, tablename)
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" \
  | tr -d '\r' | sed 's/$/;/' | psql_scratch -F $'\t' \
  | tr -d '\r' | awk -F'\t' '{ printf "  %-32s %10s\n", $1, $2; total += $2 } END { printf "  %-32s %10s\n", "TOTAL", total }'

if [ "$FAIL" = 0 ]; then
  log "RESTORE CHECK PASSED: $(basename "$DUMP")"
else
  log "RESTORE CHECK FAILED: $(basename "$DUMP")"
  exit 1
fi
