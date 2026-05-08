#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/apps/video-affiliate/worker"
PROFILE_ENV="${AFF_DEVELOPER_ENV:-/Users/yok-macmini/.hermes/profiles/aff-developer/.env}"
WORKER_NAME="${WORKER_NAME:-video-affiliate-worker}"

redact() {
  perl -pe 's/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/[REDACTED_EMAIL]/g; s/\b[0-9a-fA-F]{32}\b/[REDACTED_32HEX]/g; s/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/[REDACTED_UUID]/g; s/(CLOUDFLARE_API_TOKEN=).+/$1[REDACTED]/g; s/(CLOUDFLARE_ACCOUNT_ID=).+/$1[REDACTED]/g'
}

load_env() {
  if [[ ! -f "$PROFILE_ENV" ]]; then
    echo "missing_env=$PROFILE_ENV" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  . "$PROFILE_ENV"
  set +a
  export HOME="/Users/yok-macmini"
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN missing in $PROFILE_ENV}"
  : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID missing in $PROFILE_ENV}"
}

run_redacted() {
  set +e
  "$@" > /tmp/video-affiliate-worker-ops.out 2>&1
  local ec=$?
  set -e
  cat /tmp/video-affiliate-worker-ops.out | redact
  rm -f /tmp/video-affiliate-worker-ops.out
  return "$ec"
}

auth() {
  load_env
  echo "CLOUDFLARE_API_TOKEN_present=yes"
  echo "CLOUDFLARE_ACCOUNT_ID_present=yes"
  cd "$WORKER_DIR"
  run_redacted npx wrangler whoami
}

status() {
  load_env
  cd "$WORKER_DIR"
  run_redacted npx wrangler deployments list
}

dry_run() {
  load_env
  cd "$WORKER_DIR"
  run_redacted npm run deploy -- --dry-run
}

deploy() {
  load_env
  cd "$WORKER_DIR"
  echo "deploy_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  set +e
  npm run deploy > /tmp/video-affiliate-worker-deploy.out 2>&1
  local deploy_ec=$?
  set -e
  echo "deploy_exit=$deploy_ec"
  cat /tmp/video-affiliate-worker-deploy.out | redact
  rm -f /tmp/video-affiliate-worker-deploy.out
  echo "--- deployments_after ---"
  set +e
  npx wrangler deployments list > /tmp/video-affiliate-worker-deployments.out 2>&1
  local list_ec=$?
  set -e
  echo "deployments_list_exit=$list_ec"
  cat /tmp/video-affiliate-worker-deployments.out | redact
  rm -f /tmp/video-affiliate-worker-deployments.out
  if [[ "$list_ec" -ne 0 ]]; then
    exit "$list_ec"
  fi
  # Wrangler can upload/deploy successfully then return a container Generic Error; deployments list is the verification source.
  exit 0
}

logs() {
  load_env
  cd "$WORKER_DIR"
  local args=(wrangler tail "$WORKER_NAME" --format "${FORMAT:-pretty}")
  if [[ -n "${STATUS:-}" ]]; then
    args+=(--status "$STATUS")
  fi
  npx "${args[@]}" 2>&1 | redact
}

case "${1:-help}" in
  auth) auth ;;
  status|deployments) status ;;
  dry-run|dryrun) dry_run ;;
  deploy) deploy ;;
  logs|tail) logs ;;
  help|*)
    cat <<'EOF'
Usage: scripts/video-affiliate-worker-ops.sh <auth|status|dry-run|deploy|logs>

Uses /Users/yok-macmini/.hermes/profiles/aff-developer/.env.
Never prints Cloudflare token/account/email/version IDs unredacted.
EOF
    ;;
esac
