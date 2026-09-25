#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'rollback: %s\n' "$*" >&2
  exit 1
}

project_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run this script from inside the Git checkout'
cd "$project_root"

[[ $# -eq 1 ]] || fail 'usage: scripts/rollback.sh <rollback-id>'
rollback_id=$1
[[ "$rollback_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'invalid rollback ID'
[[ "$(id -u)" -ne 0 ]] || fail 'run as the unprivileged systemd service user, not root'

service_name=${SERVICE_NAME:-opencode-client.service}
healthcheck_url=${HEALTHCHECK_URL:-http://127.0.0.1:3000/signin}
health_timeout=${HEALTH_TIMEOUT_SECONDS:-60}
rollback_dir="$project_root/.deploy/rollbacks/$rollback_id"
rollback_root="$project_root/.deploy/rollbacks"

[[ "$health_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'HEALTH_TIMEOUT_SECONDS must be a positive integer'
for command in git systemctl curl flock; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done
[[ -d "$rollback_dir/node_modules" && -d "$rollback_dir/.next" ]] || fail "rollback ID not found or incomplete: $rollback_id"
[[ -d "$project_root/node_modules" && -d "$project_root/.next" ]] || fail 'current deployment is incomplete'
[[ -z "$(git status --porcelain)" ]] || fail 'Git worktree must be clean before rollback'
systemctl --user is-active --quiet "$service_name" || fail "systemd user service is not active: $service_name"

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

stamp=$(date -u +%Y%m%dT%H%M%SZ)
recovery_id="rollback-recovery-$stamp-$BASHPID"
recovery_dir="$rollback_root/$recovery_id"
mkdir -p "$rollback_root"
chmod 700 "$rollback_root"
exec 9>"$project_root/.deploy/deploy.lock"
flock -n 9 || fail 'another deployment or rollback is already in progress'
mkdir -m 700 "$recovery_dir"

systemctl --user stop "$service_name" || {
  rmdir "$recovery_dir"
  fail "could not stop service: $service_name"
}

moved_current=()
for item in node_modules .next; do
  if ! mv -- "$project_root/$item" "$recovery_dir/$item"; then
    for restore_item in "${moved_current[@]}"; do
      mv -- "$recovery_dir/$restore_item" "$project_root/$restore_item" || true
    done
    systemctl --user start "$service_name" || true
    rmdir "$recovery_dir" 2>/dev/null || true
    fail "could not preserve the current $item; service restart was attempted"
  fi
  moved_current+=("$item")
done

moved_rollback=()
for item in node_modules .next; do
  if ! mv -- "$rollback_dir/$item" "$project_root/$item"; then
    for restore_item in "${moved_rollback[@]}"; do
      mv -- "$project_root/$restore_item" "$rollback_dir/$restore_item" || true
    done
    for restore_item in node_modules .next; do
      if [[ -e "$recovery_dir/$restore_item" ]]; then
        mv -- "$recovery_dir/$restore_item" "$project_root/$restore_item" || true
      fi
    done
    systemctl --user start "$service_name" || true
    fail "could not activate rollback; restored the current deployment where possible"
  fi
  moved_rollback+=("$item")
done

if systemctl --user start "$service_name" && wait_for_health; then
  rmdir "$rollback_dir" 2>/dev/null || true
  printf 'Rollback succeeded. Replaced deployment retained as rollback ID: %s\n' "$recovery_id"
  exit 0
fi

systemctl --user stop "$service_name" >/dev/null 2>&1 || true
for item in node_modules .next; do
  if [[ -e "$project_root/$item" ]]; then
    mv -- "$project_root/$item" "$rollback_dir/$item" || fail "health check failed and could not restore rollback files for $item"
  fi
done
for item in node_modules .next; do
  mv -- "$recovery_dir/$item" "$project_root/$item" || fail "health check failed and could not restore the prior deployment for $item"
done
systemctl --user start "$service_name" || fail 'health check failed; prior build restored but its service did not start'
wait_for_health || fail 'health check failed for both deployments; the prior build is active but requires investigation'
rmdir "$recovery_dir" 2>/dev/null || true
fail 'rollback failed its health check; restored the previous deployment'
