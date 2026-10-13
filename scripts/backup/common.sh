# Shared set-up for pg-backup.sh and restore-check.sh (sourced, not run).
#
# Settings (environment, or KEY=value lines in the file given with --env-file):
#   BACKUP_DIR              where dumps live (default ./backups)
#   BACKUP_PREFIX           file name prefix (default: the database name)
#   BACKUP_DATABASE_URL     postgres URL of the database to dump / the server to restore on
#                           (superuser or owner). Default: DATABASE_MIGRATION_URL.
#   BACKUP_COMPOSE_DIR      if set, pg_dump / pg_restore / psql run inside the `postgres` service of
#                           $BACKUP_COMPOSE_DIR/docker-compose.prod.yml (server set-up), and the URL
#                           defaults to the container's local socket as POSTGRES_USER / POSTGRES_DB.
#   PG_BIN_DIR              folder with pg_dump / pg_restore / psql (when they are not on PATH)

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

load_env_file() {
  local file="$1"
  [ -f "$file" ] || die "env file not found: $file"
  # KEY=value lines only; values are taken literally (no shell expansion), quotes stripped.
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    local key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    # Settings already in the environment win over the file.
    [ -z "${!key+x}" ] && export "$key=$value"
  done < "$file"
}

setup_pg_commands() {
  if [ -n "${BACKUP_COMPOSE_DIR:-}" ]; then
    local compose=(docker compose -f "$BACKUP_COMPOSE_DIR/docker-compose.prod.yml" exec -T postgres)
    PG_DUMP=("${compose[@]}" pg_dump)
    PG_RESTORE=("${compose[@]}" pg_restore)
    PSQL=("${compose[@]}" psql)
    : "${BACKUP_DATABASE_URL:=postgresql://${POSTGRES_USER:-postgres}@/${POSTGRES_DB:-construction}}"
  else
    local bin="${PG_BIN_DIR:+$PG_BIN_DIR/}"
    PG_DUMP=("${bin}pg_dump")
    PG_RESTORE=("${bin}pg_restore")
    PSQL=("${bin}psql")
    : "${BACKUP_DATABASE_URL:=${DATABASE_MIGRATION_URL:-}}"
    command -v "${PG_DUMP[0]}" >/dev/null 2>&1 || die "pg_dump not found (install postgresql-client or set PG_BIN_DIR)"
  fi
  [ -n "$BACKUP_DATABASE_URL" ] || die "BACKUP_DATABASE_URL (or DATABASE_MIGRATION_URL) is not set"
  BACKUP_DIR="${BACKUP_DIR:-./backups}"
  DB_NAME="$(db_of "$BACKUP_DATABASE_URL")"
  [ -n "$DB_NAME" ] || die "BACKUP_DATABASE_URL has no database name"
  BACKUP_PREFIX="${BACKUP_PREFIX:-$DB_NAME}"
  [[ "$BACKUP_PREFIX" =~ ^[A-Za-z0-9_.-]+$ ]] || die "BACKUP_PREFIX may only contain letters, digits, _ . -"
}

# postgresql://user:pw@host:5432/db?x=y → db
db_of() { local u="${1%%\?*}"; echo "${u##*/}"; }
# Same URL pointing at another database (query string kept).
with_db() {
  local url="$1" db="$2" query=""
  [[ "$url" == *\?* ]] && query="?${url#*\?}"
  local base="${url%%\?*}"
  echo "${base%/*}/${db}${query}"
}
