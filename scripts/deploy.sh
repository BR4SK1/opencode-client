#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

project_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run this script from inside the Git checkout'
cd "$project_root"

service_name=${SERVICE_NAME:-opencode-client.service}
healthcheck_url=${HEALTHCHECK_URL:-http://127.0.0.1:3000/signin}
health_timeout=${HEALTH_TIMEOUT_SECONDS:-60}
env_file=${ENV_FILE:-$project_root/.env.production.local}

[[ "$(id -u)" -ne 0 ]] || fail 'run as the unprivileged systemd service user, not root'
[[ "$health_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'HEALTH_TIMEOUT_SECONDS must be a positive integer'

for command in git pnpm systemctl curl flock; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

[[ -f "$env_file" && -r "$env_file" ]] || fail "production environment file is missing or unreadable: $env_file"
[[ -d "$project_root/.next" && -d "$project_root/node_modules" ]] || fail 'expected an existing .next build and node_modules; complete initial setup first'
systemctl --user is-active --quiet "$service_name" || fail "systemd user service is not active: $service_name"
[[ -z "$(git status --porcelain)" ]] || fail 'Git worktree must be clean before deployment'

commit=$(git rev-parse HEAD)
short_commit=$(git rev-parse --short=12 HEAD)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
rollback_id="$timestamp-$short_commit-$BASHPID"
deploy_root="$project_root/.deploy"
rollback_root="$deploy_root/rollbacks"
temp_root="$deploy_root/tmp"
mkdir -p "$rollback_root" "$temp_root"
chmod 700 "$deploy_root" "$rollback_root" "$temp_root"
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || fail 'another deployment or rollback is already in progress'
temp_dir=$(mktemp -d "$temp_root/deploy.XXXXXX")
worktree="$temp_dir/source"
rollback_dir="$rollback_root/$rollback_id"

cleanup() {
  status=$?
  trap - EXIT
  if [[ -f "$worktree/.git" ]]; then
    git -C "$project_root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temp_dir"
  exit "$status"
}
trap cleanup EXIT

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= health_timeout; attempt++)); do
    local status
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 "$healthcheck_url" 2>/dev/null || true)
    if systemctl --user is-active --quiet "$service_name" && [[ "$status" == 200 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restore_previous() {
  local item
  systemctl --user stop "$service_name" >/dev/null 2>&1 || true
  mkdir -p "$temp_dir/failed"
  for item in node_modules .next; do
    if [[ -e "$project_root/$item" ]]; then
      mv -- "$project_root/$item" "$temp_dir/failed/$item" || return 1
    fi
    if [[ -e "$rollback_dir/$item" ]]; then
      mv -- "$rollback_dir/$item" "$project_root/$item" || return 1
    fi
  done
  if [[ -d "$project_root/node_modules" && -d "$project_root/.next" ]] && \
    systemctl --user start "$service_name" && wait_for_health; then
    rmdir "$rollback_dir" 2>/dev/null || true
    return 0
  fi
  return 1
}

printf 'Building %s in an isolated worktree...\n' "$short_commit"
git worktree add --detach "$worktree" "$commit" >/dev/null
cp -- "$env_file" "$worktree/.env.production.local"
chmod 600 "$worktree/.env.production.local"
(
  cd "$worktree"
  pnpm install --frozen-lockfile
  pnpm lint
  pnpm build
)
[[ -s "$worktree/.next/BUILD_ID" ]] || fail 'production build did not produce a BUILD_ID'
printf 'Build %s passed install, lint, and production build.\n' "$(<"$worktree/.next/BUILD_ID")"

mkdir -m 700 "$rollback_dir"
if ! systemctl --user stop "$service_name"; then
  rmdir "$rollback_dir"
  fail "could not stop service: $service_name"
fi

for item in node_modules .next; do
  if ! mv -- "$project_root/$item" "$rollback_dir/$item"; then
    for restore_item in node_modules .next; do
      if [[ -e "$rollback_dir/$restore_item" ]]; then
        mv -- "$rollback_dir/$restore_item" "$project_root/$restore_item" || true
      fi
    done
    systemctl --user start "$service_name" || true
    rmdir "$rollback_dir" 2>/dev/null || true
    fail "could not preserve the previous $item; previous service was restarted"
  fi
done

if ! mv -- "$worktree/node_modules" "$project_root/node_modules" || \
  ! mv -- "$worktree/.next" "$project_root/.next"; then
  if restore_previous; then
    fail "promotion failed; restored the previous deployment from $rollback_id"
  fi
  fail "promotion and automatic rollback failed; inspect service and rollback directory $rollback_dir"
fi

if ! systemctl --user start "$service_name" || ! wait_for_health; then
  if restore_previous; then
    fail "new deployment failed its health check; restored the previous deployment from $rollback_id"
  fi
  fail "new deployment and automatic rollback failed; inspect service and rollback directory $rollback_dir"
fi

printf 'Deployment succeeded. Previous release retained as rollback ID: %s\n' "$rollback_id"
