#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

recovery_hint() {
  printf '%s\n' \
    'Recovery: keep this trusted deployment checkout and select application source with SOURCE_REVISION=<known-good-revision>.' \
    'Rerun ./scripts/deploy.sh to rebuild that Git revision; no previous runtime snapshot is retained.' >&2
}

project_root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run this script from inside the trusted Git checkout'
project_root=$(realpath -e -- "$project_root") || fail 'could not resolve trusted checkout path'
cd "$project_root"
unset NODE_OPTIONS

service_name=${SERVICE_NAME:-opencode-client.service}
service_port=${SERVICE_PORT:-5115}
healthcheck_url=${HEALTHCHECK_URL:-http://127.0.0.1:$service_port/signin}
health_timeout=${HEALTH_TIMEOUT_SECONDS:-60}
env_file=${ENV_FILE:-$project_root/.env.production.local}
source_revision=${SOURCE_REVISION:-HEAD}
home_dir=$(realpath -e -- "$HOME") || fail 'could not resolve service user home directory'
runtime_request=${RUNTIME_DIR:-$home_dir/opencode-client-runtime}

[[ "$(id -u)" -ne 0 ]] || fail 'run as the unprivileged systemd service user, not root'
[[ "$health_timeout" =~ ^[1-9][0-9]*$ ]] || fail 'HEALTH_TIMEOUT_SECONDS must be a positive integer'
[[ "$service_port" =~ ^[1-9][0-9]{0,4}$ ]] && (( service_port <= 65535 )) || fail 'SERVICE_PORT must be an integer from 1 through 65535 without leading zeroes'
case "$healthcheck_url" in
  "http://127.0.0.1:$service_port/"*) ;;
  *) fail "HEALTHCHECK_URL must target 127.0.0.1 on SERVICE_PORT ($service_port)" ;;
esac
[[ "$runtime_request" == /* ]] || fail 'RUNTIME_DIR must be an absolute path'
[[ ! -L "$runtime_request" ]] || fail 'RUNTIME_DIR must not be a symlink'
runtime_dir=$(realpath -m -- "$runtime_request") || fail 'could not resolve RUNTIME_DIR'
[[ "$(dirname "$runtime_dir")" == "$home_dir" && "$runtime_dir" != "$home_dir" ]] || fail 'RUNTIME_DIR must be a direct child of the service user home directory'
[[ "$runtime_dir" != "$project_root" && "$runtime_dir" != "$project_root/"* && "$project_root" != "$runtime_dir/"* ]] || fail 'RUNTIME_DIR must be separate from and outside the trusted checkout'
[[ "$env_file" == /* ]] || fail 'ENV_FILE must be an absolute path so the service and build use the same file'
[[ "$env_file" != "$runtime_dir" && "$env_file" != "$runtime_dir/"* ]] || fail 'ENV_FILE must remain outside RUNTIME_DIR'

for command in git node pnpm systemctl busctl curl flock tar sha256sum realpath mountpoint; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done
node_path=/usr/bin/node
[[ -x "$node_path" ]] || fail 'required Node.js executable not found: /usr/bin/node'
pnpm_path=$(command -v pnpm)
[[ "$pnpm_path" == /* ]] || fail 'pnpm must resolve to an absolute executable path'
runtime_env_script="$project_root/scripts/runtime-env.mjs"
unit_preflight_script="$project_root/scripts/systemd-unit-preflight.mjs"
[[ -f "$runtime_env_script" && -f "$unit_preflight_script" ]] || fail 'trusted deployment helper scripts are missing'

[[ -f "$env_file" && -r "$env_file" ]] || fail "production environment file is missing or unreadable: $env_file"
env_file_real=$(realpath -e -- "$env_file") || fail 'could not resolve ENV_FILE'
[[ "$env_file_real" != "$runtime_dir" && "$env_file_real" != "$runtime_dir/"* ]] || fail 'ENV_FILE target must remain outside RUNTIME_DIR'
"$node_path" "$runtime_env_script" validate "$env_file" || fail 'ENV_FILE does not satisfy the shared runtime environment contract'
[[ -z "$(git status --porcelain)" ]] || fail 'trusted deployment checkout must be clean'
[[ ! -L "$runtime_dir" ]] || fail 'RUNTIME_DIR must not be a symlink'
if [[ -e "$runtime_dir" ]]; then
  [[ -d "$runtime_dir" ]] || fail 'RUNTIME_DIR exists but is not a directory'
  [[ ! -e "$runtime_dir/.git" ]] || fail 'RUNTIME_DIR contains Git metadata; refusing to replace a worktree as a runtime'
  if mountpoint -q "$runtime_dir"; then
    fail 'RUNTIME_DIR must not be a mount point because promotion replaces the whole directory'
  else
    mount_status=$?
    (( mount_status == 32 )) || fail 'could not verify that RUNTIME_DIR is not a mount point'
  fi
fi

commit=$(git rev-parse --verify --end-of-options "${source_revision}^{commit}" 2>/dev/null) || fail "SOURCE_REVISION does not resolve to a Git commit: $source_revision"
short_commit=$(git rev-parse --short=12 "$commit")
runtime_env_script_hash=$(sha256sum "$runtime_env_script")
runtime_env_script_hash=${runtime_env_script_hash%% *}
unit_preflight_script_hash=$(sha256sum "$unit_preflight_script")
unit_preflight_script_hash=${unit_preflight_script_hash%% *}
lock_file="$home_dir/.opencode-client-deploy.lock"
[[ ! -L "$lock_file" ]] || fail 'shared deployment lock must not be a symlink'
exec 9>>"$lock_file"
chmod 600 "$lock_file"
flock -n 9 || fail 'another deployment using this runtime and service account is already in progress'
stage_dir=$(mktemp -d "$(dirname "$runtime_dir")/.opencode-client-stage.XXXXXX")

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM
  if [[ -n "${stage_dir:-}" && -e "$stage_dir" ]]; then
    if ! rm -rf -- "$stage_dir"; then
      printf 'deploy: ERROR: could not remove staged runtime at %s\n' "$stage_dir" >&2
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    if (( status == 0 )); then
      printf 'deploy: deployment completed, but staging cleanup failed; inspect and remove the path reported above before retrying\n' >&2
    else
      printf 'deploy: deployment failed and staging cleanup was incomplete; inspect and remove the path reported above before retrying\n' >&2
    fi
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$stage_dir"

preflight_runtime_unit() {
  "$node_path" "$unit_preflight_script" "$service_name" "$runtime_dir" "$env_file" "$service_port" "$node_path" || \
    fail "loaded systemd unit is not a verified runtime unit: $service_name"
}

assert_no_next_dotenv() {
  local dotenv_file
  for dotenv_file in .env .env.local .env.production .env.production.local; do
    [[ ! -e "$stage_dir/$dotenv_file" ]] || fail "runtime stage contains Next.js dotenv file $dotenv_file; application configuration must come only from ENV_FILE"
  done
}

read_service_state() {
  local state
  state=$(systemctl --user is-active "$service_name" 2>/dev/null) || true
  case "$state" in
    active|inactive|failed|activating|deactivating|reloading|maintenance) printf '%s\n' "$state" ;;
    *) return 1 ;;
  esac
}

stop_service_and_confirm_inactive() {
  local stop_status=0
  local state
  systemctl --user stop "$service_name" >/dev/null 2>&1 || stop_status=$?
  state=$(read_service_state) || state=unknown

  if (( stop_status == 0 )) && [[ "$state" == inactive ]]; then
    return 0
  fi

  if [[ "$state" == inactive ]]; then
    printf 'deploy: systemctl stop returned status %s, but the service currently reports inactive; verify no restart is pending before retrying\n' "$stop_status" >&2
  else
    printf 'deploy: could not confirm service is inactive (systemctl stop status %s; reported state: %s). Restart=always may restart it; no automatic retry was attempted\n' "$stop_status" "$state" >&2
  fi
  return 1
}

stop_service_for_failure() {
  local stop_status=0
  local state
  systemctl --user stop "$service_name" >/dev/null 2>&1 || stop_status=$?
  state=$(read_service_state) || state=unknown
  if (( stop_status == 0 )) && [[ "$state" == inactive ]]; then
    printf 'deploy: confirmed service inactive after failure\n' >&2
    return 0
  fi
  if [[ "$state" == inactive ]]; then
    printf 'deploy: service currently reports inactive after failure, but systemctl stop returned status %s; verify no restart is pending before recovery\n' "$stop_status" >&2
  else
    printf 'deploy: WARNING: service is not confirmed inactive after failure (systemctl stop status %s; state: %s). Restart=always may restart it; verify systemd before recovery\n' "$stop_status" "$state" >&2
  fi
  return 1
}

promotion_failure() {
  local message=$1
  local state
  state=$(read_service_state) || state=unknown
  recovery_hint
  if [[ "$state" == inactive ]]; then
    fail "$message; service is confirmed inactive"
  fi
  fail "$message; service is not confirmed inactive (state: $state). Restart=always may restart it; verify systemd before recovery"
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= health_timeout; attempt++)); do
    local status
    local state
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 3 "$healthcheck_url" 2>/dev/null || true)
    state=$(read_service_state) || state=unknown
    if [[ "$state" == active && "$status" == 200 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Refuse the old checkout-based unit before building or touching either tree.
preflight_runtime_unit

printf 'Building application revision %s into an isolated runtime stage with this trusted runner...\n' "$short_commit"
git archive --format=tar "$commit" | tar -xf - -C "$stage_dir"
[[ -f "$stage_dir/package.json" && -d "$stage_dir/app" && -d "$stage_dir/public" ]] || fail 'selected Git revision is missing required application runtime files'
assert_no_next_dotenv
source_env_hash=$(sha256sum "$env_file")
source_env_hash=${source_env_hash%% *}
(
  "$node_path" "$runtime_env_script" tool "$stage_dir" -- "$pnpm_path" install --frozen-lockfile --prod=false
  assert_no_next_dotenv
  "$node_path" "$runtime_env_script" tool "$stage_dir" -- "$pnpm_path" lint
  assert_no_next_dotenv
  "$node_path" "$runtime_env_script" build "$env_file" "$stage_dir" -- "$node_path" "$stage_dir/node_modules/next/dist/bin/next" build
)
assert_no_next_dotenv
[[ -s "$stage_dir/.next/BUILD_ID" ]] || fail 'production build did not produce a BUILD_ID'
[[ -d "$stage_dir/node_modules" ]] || fail 'dependency install did not produce node_modules'
[[ -d "$stage_dir/public" ]] || fail 'runtime stage is missing public assets'

current_env_hash=$(sha256sum "$env_file")
current_env_hash=${current_env_hash%% *}
[[ "$current_env_hash" == "$source_env_hash" ]] || fail 'ENV_FILE changed during build; active runtime was not changed'
current_runtime_env_script_hash=$(sha256sum "$runtime_env_script")
current_runtime_env_script_hash=${current_runtime_env_script_hash%% *}
current_unit_preflight_script_hash=$(sha256sum "$unit_preflight_script")
current_unit_preflight_script_hash=${current_unit_preflight_script_hash%% *}
[[ "$current_runtime_env_script_hash" == "$runtime_env_script_hash" && "$current_unit_preflight_script_hash" == "$unit_preflight_script_hash" ]] || fail 'trusted deployment helper changed during build; active runtime was not changed'
[[ -z "$(git status --porcelain)" ]] || fail 'trusted deployment checkout changed during build; active runtime was not changed'

# Overlay the trusted parser after selected-revision build hooks have run, then
# retain only its configuration digest (never application values).
mkdir -p "$stage_dir/scripts"
cp -- "$runtime_env_script" "$stage_dir/scripts/runtime-env.mjs"
chmod 644 "$stage_dir/scripts/runtime-env.mjs"
printf '%s\n' "$source_env_hash" >"$stage_dir/.runtime-env.sha256"
"$node_path" "$stage_dir/scripts/runtime-env.mjs" verify "$env_file" "$stage_dir/.runtime-env.sha256" || \
  fail 'ENV_FILE changed during build; active runtime was not changed'

# Recheck loaded properties immediately before promotion in case systemd was
# reloaded or the unit changed while the isolated build was running.
preflight_runtime_unit
state=$(read_service_state) || fail 'could not determine systemd service state; active runtime was not changed'
case "$state" in
  active|failed)
    if ! stop_service_and_confirm_inactive; then
      fail 'could not confirm service inactive before promotion; active runtime was not changed'
    fi
    ;;
  inactive)
    ;;
  *)
    fail "service is in transitional or unrecognized state '$state'; active runtime was not changed"
    ;;
esac

# There is one active runtime path and no previous-release copy. Promotion
# removes that path only after a complete build and confirmed service stop.
if [[ -e "$runtime_dir" ]]; then
  if ! rm -rf -- "$runtime_dir"; then
    promotion_failure 'could not remove the old active runtime; no snapshot was made'
  fi
fi
if ! mv -- "$stage_dir" "$runtime_dir"; then
  promotion_failure 'could not promote staged runtime; deployment may be incomplete'
fi
stage_dir=''

if ! systemctl --user start "$service_name"; then
  recovery_hint
  if stop_service_for_failure; then
    fail 'could not start the new runtime; service is confirmed inactive'
  fi
  fail 'could not start the new runtime; inspect the reported service state before recovery'
fi
if ! wait_for_health; then
  recovery_hint
  if stop_service_for_failure; then
    fail 'new runtime failed its health check; service is confirmed inactive'
  fi
  fail 'new runtime failed its health check; inspect the reported service state before recovery'
fi

printf 'Deployment succeeded for Git revision %s at runtime %s. No previous runtime snapshot was retained.\n' "$commit" "$runtime_dir"
