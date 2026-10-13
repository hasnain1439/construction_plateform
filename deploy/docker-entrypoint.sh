#!/bin/sh
# Entrypoint of the API image.
#   start (default)  run the API: node --import ./dist/instrument.js dist/server.js
#   migrate          prisma migrate deploy with DATABASE_MIGRATION_URL, then exit
#   migrate-status   prisma migrate status
#   anything else    executed as given (e.g. `sh`)
set -e

case "${1:-start}" in
  start)
    exec node --import ./dist/instrument.js dist/server.js
    ;;
  migrate)
    if [ -z "${DATABASE_MIGRATION_URL:-}" ]; then
      echo "DATABASE_MIGRATION_URL is not set (schema owner / superuser connection)" >&2
      exit 1
    fi
    shift
    exec node node_modules/prisma/build/index.js migrate deploy "$@"
    ;;
  migrate-status)
    shift
    exec node node_modules/prisma/build/index.js migrate status "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
