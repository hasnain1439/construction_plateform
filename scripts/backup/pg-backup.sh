#!/usr/bin/env bash
# Nightly PostgreSQL backup: pg_dump -Fc → $BACKUP_DIR/<prefix>_<UTC timestamp>.dump (+ .sha256),
# checked with pg_restore --list, optional upload hook, then dumps older than the retention are deleted.
#
#   scripts/backup/pg-backup.sh [--env-file FILE]
#   npm run db:backup -- --env-file .env           (local: dumps DATABASE_MIGRATION_URL into ./backups)
#
# Settings: see common.sh, plus
#   BACKUP_RETENTION_DAYS   delete this script's dumps older than N days (default 14; 0 = keep all)
#   BACKUP_UPLOAD_CMD       optional shell command run after a good dump, the dump path is "$1"
#                           e.g. 'rclone copy --immutable "$1" r2:construction-backups/production/'
#
# Server cron (user deploy, server time zone Asia/Karachi), see docs/DEPLOYMENT.md → Backups:
#   30 2 * * * /opt/construction/backup/pg-backup.sh --env-file /opt/construction/.env >> /var/backups/construction/backup.log 2>&1
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) load_env_file "${2:?--env-file needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

setup_pg_commands
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
[[ "$RETENTION" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be a whole number"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/${BACKUP_PREFIX}_${stamp}.dump"
tmp="$file.partial"
trap 'rm -f "$tmp"' EXIT

# One backup at a time (cron + a manual run).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.pg-backup.lock"
  flock -n 9 || die "another backup is running"
fi

log "dumping database $DB_NAME → $file"
started=$(date +%s)
"${PG_DUMP[@]}" --format=custom --compress=6 --no-password --dbname="$BACKUP_DATABASE_URL" > "$tmp"
[ -s "$tmp" ] || die "pg_dump produced an empty file"

# A dump pg_restore cannot read is not a backup.
entries=$("${PG_RESTORE[@]}" --list < "$tmp" | grep -vc '^;' || true)
[ "$entries" -gt 0 ] || die "pg_restore --list found no entries in the dump"
grep -q '_prisma_migrations' <("${PG_RESTORE[@]}" --list < "$tmp") || die "dump has no _prisma_migrations table"

mv "$tmp" "$file"
trap - EXIT
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256")
fi
size=$(wc -c < "$file" | tr -d ' ')
log "ok: $entries archive entries, $size bytes, $(( $(date +%s) - started ))s"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  log "upload hook"
  sh -c "$BACKUP_UPLOAD_CMD" upload "$file" || die "upload hook failed (the local dump is kept: $file)"
fi

if [ "$RETENTION" -gt 0 ]; then
  deleted=$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "${BACKUP_PREFIX}_*.dump" -o -name "${BACKUP_PREFIX}_*.dump.sha256" \) -mtime "+$RETENTION" -print -delete | wc -l | tr -d ' ')
  log "retention ${RETENTION} days: deleted $deleted old file(s)"
fi
echo "$file"
