#!/usr/bin/env bash
# Deploy (or roll back) the stack on THIS server. Lives in /opt/construction next to
# docker-compose.prod.yml, .env and api.env. Called by the GitHub Actions deploy jobs over SSH,
# and by hand for rollbacks:
#
#   ./deploy.sh --api sha-1a2b3c4                 # new API image: pull, migrate, restart api
#   ./deploy.sh --web staging-1a2b3c4             # new web image: pull, restart web
#   ./deploy.sh --api sha-0ld0ld0 --no-migrate    # roll the API back (migrations are forward-only)
#   ./deploy.sh                                   # re-pull current tags, migrate, up -d
#
# Every run appends the tags it deployed to .deploy-history (newest last) so a rollback target
# is always at hand. Exit code ≠ 0 when the containers do not become healthy.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.prod.yml)
API_TAG_NEW=""
WEB_TAG_NEW=""
MIGRATE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --api) API_TAG_NEW="${2:?--api needs a tag}"; shift 2 ;;
    --web) WEB_TAG_NEW="${2:?--web needs a tag}"; shift 2 ;;
    --no-migrate) MIGRATE=0; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo ".env missing (copy env/<staging|production>.env.example)" >&2; exit 1; }
[ -f api.env ] || { echo "api.env missing (copy env/<staging|production>.api.env.example)" >&2; exit 1; }

valid_tag() { [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; }
set_env() {
  local key="$1" value="$2"
  valid_tag "$value" || { echo "invalid image tag: $value" >&2; exit 2; }
  if grep -q "^${key}=" .env; then sed -i "s|^${key}=.*|${key}=${value}|" .env; else echo "${key}=${value}" >> .env; fi
}

[ -n "$API_TAG_NEW" ] && set_env API_TAG "$API_TAG_NEW"
[ -n "$WEB_TAG_NEW" ] && set_env WEB_TAG "$WEB_TAG_NEW"

echo "==> pulling images"
"${COMPOSE[@]}" pull --quiet api web caddy postgres

if [ "$MIGRATE" = 1 ]; then
  echo "==> applying database migrations"
  "${COMPOSE[@]}" up -d --wait postgres
  "${COMPOSE[@]}" --profile tools run --rm migrate
fi

echo "==> starting containers"
"${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 180 postgres api web caddy

echo "==> readiness (database, storage, scheduler)"
"${COMPOSE[@]}" exec -T api node -e "
  fetch('http://127.0.0.1:4000/health/ready')
    .then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error(e.message); process.exit(1); });"

# shellcheck disable=SC1091
. <(grep -E '^(API_TAG|WEB_TAG)=' .env)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) api=${API_TAG} web=${WEB_TAG}" >> .deploy-history
docker image prune -f --filter "until=168h" >/dev/null || true
echo "==> deployed api=${API_TAG} web=${WEB_TAG}"
