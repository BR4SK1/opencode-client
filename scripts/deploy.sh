#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

recovery_hint() {
  printf '%s\n' \
    'Recovery: do not remove any reported .opencode-client-previous.* path; inspect the service state and runtime ownership before manual recovery.' \
    'A source rebuild remains available with SOURCE_REVISION=<known-good-revision> after service/runtime state is safe.' >&2
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

for command in git node pnpm systemctl busctl curl flock tar sha256sum realpath mountpoint stat timeout; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done
node_path=/usr/bin/node
[[ -x "$node_path" ]] || fail 'required Node.js executable not found: /usr/bin/node'
pnpm_path=$(command -v pnpm)
[[ "$pnpm_path" == /* ]] || fail 'pnpm must resolve to an absolute executable path'
runtime_env_script="$project_root/scripts/runtime-env.mjs"
unit_preflight_script="$project_root/scripts/systemd-unit-preflight.mjs"
service_quiescence_script="$project_root/scripts/systemd-service-quiescence.mjs"
runtime_tree_safety_script="$project_root/scripts/runtime-tree-safety.mjs"
transaction_script="$project_root/scripts/deploy-transaction.mjs"
[[ -f "$runtime_env_script" && -f "$unit_preflight_script" && -f "$service_quiescence_script" && \
   -f "$runtime_tree_safety_script" && -f "$transaction_script" ]] || fail 'trusted deployment helper scripts are missing'

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
service_quiescence_script_hash=$(sha256sum "$service_quiescence_script")
service_quiescence_script_hash=${service_quiescence_script_hash%% *}
runtime_tree_safety_script_hash=$(sha256sum "$runtime_tree_safety_script")
runtime_tree_safety_script_hash=${runtime_tree_safety_script_hash%% *}
transaction_script_hash=$(sha256sum "$transaction_script")
transaction_script_hash=${transaction_script_hash%% *}
lock_file="$home_dir/.opencode-client-deploy.lock"
transaction_marker_path="$home_dir/.opencode-client-deploy.transaction.json"
[[ ! -L "$lock_file" ]] || fail 'shared deployment lock must not be a symlink'
exec 9>>"$lock_file"
chmod 600 "$lock_file"
flock -n 9 || fail 'another deployment using this runtime and service account is already in progress'
if [[ -e "$transaction_marker_path" || -L "$transaction_marker_path" ]]; then
  [[ ! -L "$transaction_marker_path" ]] || fail "deployment transaction marker is a symlink; inspect it without retrying: $transaction_marker_path"
  marker_details=$("$node_path" "$transaction_script" inspect "$transaction_marker_path" 2>&1) || \
    fail "an unresolved or invalid deployment transaction marker blocks retry: $transaction_marker_path; $marker_details"
  fail "an unresolved deployment transaction blocks retry: $marker_details; inspect exact recorded paths before manual recovery"
fi
transaction_id=$("$node_path" "$transaction_script" new-id) || fail 'could not create deployment transaction identity'
old_runtime_backup="$home_dir/.opencode-client-previous.$transaction_id"
[[ ! -e "$old_runtime_backup" && ! -L "$old_runtime_backup" ]] || fail 'transaction backup path unexpectedly already exists'
stage_dir=$(mktemp -d "$(dirname "$runtime_dir")/.opencode-client-stage.XXXXXX")
transaction_started=false
transaction_committed=false
marker_created=false
restore_service=false
runtime_promoted=false
old_runtime_present=false
old_tree_digest=''
new_tree_digest=''
initial_service_state='unknown'

cleanup() {
  local status=$?
  local cleanup_failed=0
  local rollback_failed=0
  trap - EXIT HUP INT TERM
  if [[ "$transaction_started" == true && "$transaction_committed" != true ]]; then
    if ! rollback_transaction; then
      rollback_failed=1
    fi
  fi
  if [[ "$transaction_committed" == true && -n "$old_runtime_backup" && -e "$old_runtime_backup" ]]; then
    printf 'deploy: deployment health was verified, but previous runtime cleanup did not complete; preserve and inspect %s\n' "$old_runtime_backup" >&2
    status=1
  fi
  if [[ "$marker_created" == true && -e "$transaction_marker_path" ]]; then
    printf 'deploy: unresolved transaction marker retained at %s (transaction %s); retries are blocked until reviewed recovery\n' "$transaction_marker_path" "$transaction_id" >&2
    status=1
  fi
  if [[ -n "${stage_dir:-}" && -e "$stage_dir" ]]; then
    stage_digest=$("$node_path" "$runtime_tree_safety_script" inspect "$stage_dir" "$(id -u)" 2>/dev/null) || stage_digest=''
    if [[ -z "$stage_digest" ]] || ! "$node_path" "$runtime_tree_safety_script" remove "$stage_dir" "$(id -u)" "$stage_digest" -; then
      printf 'deploy: ERROR: staged runtime was preserved because safe recursive cleanup could not be proven: %s\n' "$stage_dir" >&2
      cleanup_failed=1
    fi
  fi
  if (( rollback_failed != 0 )); then
    printf 'deploy: deployment failed and rollback/recovery was incomplete; preserve every reported runtime path and inspect systemd state before retrying\n' >&2
    status=1
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

assert_service_quiescent() {
  "$node_path" "$service_quiescence_script" "$service_name" >/dev/null
}

update_transaction_marker() {
  local phase=$1
  local old_digest=${2:--}
  local new_digest=${3:--}
  [[ "$marker_created" == true ]] || return 1
  "$node_path" "$transaction_script" update "$transaction_marker_path" "$transaction_id" "$phase" "$old_digest" "$new_digest"
}

remove_transaction_marker() {
  [[ "$marker_created" == true ]] || return 1
  "$node_path" "$transaction_script" remove "$transaction_marker_path" "$transaction_id" || return 1
  marker_created=false
}

stop_service_and_confirm_inactive() {
  local stop_status=0
  local state
  systemctl --user stop "$service_name" >/dev/null 2>&1 || stop_status=$?
  state=$(read_service_state) || state=unknown

  if (( stop_status == 0 )) && assert_service_quiescent; then
    return 0
  fi

  if assert_service_quiescent; then
    printf 'deploy: service processes and pending jobs are quiescent but systemctl stop returned status %s; aborting promotion and restoring prior availability\n' "$stop_status" >&2
  else
    printf 'deploy: could not establish service quiescence (systemctl stop status %s; reported state: %s)\n' "$stop_status" "$state" >&2
  fi
  return 1
}

stop_service_for_failure() {
  local stop_status=0
  local state
  systemctl --user stop "$service_name" >/dev/null 2>&1 || stop_status=$?
  state=$(read_service_state) || state=unknown
  if assert_service_quiescent; then
    if (( stop_status == 0 )); then
      printf 'deploy: confirmed service quiescent after failure\n' >&2
    else
      printf 'deploy: systemctl stop returned status %s, but no pending job or cgroup process remains\n' "$stop_status" >&2
    fi
    return 0
  fi
  printf 'deploy: WARNING: service quiescence is not confirmed (systemctl stop status %s; state: %s); runtime replacement is unsafe\n' "$stop_status" "$state" >&2
  return 1
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

runtime_revision() {
  local runtime=$1
  local revision='unknown (no trusted revision metadata)'
  if [[ -f "$runtime/.runtime-source-revision" && ! -L "$runtime/.runtime-source-revision" ]]; then
    local recorded
    recorded=$(<"$runtime/.runtime-source-revision")
    if [[ "$recorded" =~ ^[a-f0-9]{40,64}$ ]]; then
      revision=$recorded
    fi
  fi
  printf '%s\n' "$revision"
}

validate_previous_runtime() {
  local runtime=$1
  local entry name runtime_launcher_hash next_executable
  [[ -d "$runtime" && ! -L "$runtime" ]] || return 1
  [[ "$(stat -c '%u' -- "$runtime")" == "$(id -u)" ]] || return 1
  [[ -s "$runtime/.next/BUILD_ID" && -d "$runtime/node_modules" && -d "$runtime/public" ]] || return 1
  [[ ! -e "$runtime/.git" ]] || return 1
  for entry in "$runtime"/* "$runtime"/.[!.]* "$runtime"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name=${entry##*/}
    case "$name" in
      .env.example|.gitignore|.husky|.next|.runtime-env.sha256|.runtime-source-revision|.runtime-transaction-id|AGENTS.md|CLAUDE.md|README.md|app|auth.ts|deploy|eslint.config.mjs|lib|next-env.d.ts|next.config.ts|node_modules|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|proxy.ts|public|scripts|tsconfig.json|vitest.config.ts) ;;
      *) printf 'deploy: previous runtime contains unexpected top-level path %s\n' "$entry" >&2; return 1 ;;
    esac
  done
  if mountpoint -q "$runtime"; then
    return 1
  else
    local mount_status=$?
    (( mount_status == 32 )) || return 1
  fi
  [[ -f "$runtime/scripts/runtime-env.mjs" && ! -L "$runtime/scripts/runtime-env.mjs" ]] || return 1
  runtime_launcher_hash=$(sha256sum "$runtime/scripts/runtime-env.mjs") || return 1
  runtime_launcher_hash=${runtime_launcher_hash%% *}
  [[ "$runtime_launcher_hash" == "$runtime_env_script_hash" ]] || return 1
  next_executable="$runtime/node_modules/next/dist/bin/next"
  [[ -f "$next_executable" && -r "$next_executable" && ! -L "$next_executable" ]] || return 1
  "$node_path" --check "$runtime/scripts/runtime-env.mjs" >/dev/null 2>&1 || return 1
  "$node_path" --check "$next_executable" >/dev/null 2>&1 || return 1
  "$node_path" "$runtime_env_script" verify "$env_file" "$runtime/.runtime-env.sha256" >/dev/null 2>&1 || return 1
  timeout --signal=KILL 10s "$node_path" "$runtime/scripts/runtime-env.mjs" tool "$runtime" -- \
    "$node_path" "$next_executable" --help >/dev/null 2>&1 || return 1
}

runtime_tree_digest() {
  "$node_path" "$runtime_tree_safety_script" inspect "$1" "$(id -u)" "${2:--}"
}

recover_unchanged_previous_without_journal() {
  local state current_digest
  if [[ "$restore_service" != true ]]; then
    printf 'deploy: no-journal recovery will not activate a service that was not previously requested to be restored\n' >&2
    return 1
  fi
  if [[ "$old_runtime_present" != true || "$runtime_promoted" == true || -e "$old_runtime_backup" || -L "$old_runtime_backup" ]]; then
    printf 'deploy: no-journal recovery is unsafe because the previous runtime is not still at its original path\n' >&2
    return 1
  fi
  if [[ -z "$old_tree_digest" || ! -d "$runtime_dir" || -L "$runtime_dir" ]]; then
    printf 'deploy: no-journal recovery cannot identify an unchanged previous runtime\n' >&2
    return 1
  fi
  current_digest=$(runtime_tree_digest "$runtime_dir") || return 1
  [[ "$current_digest" == "$old_tree_digest" ]] || {
    printf 'deploy: no-journal recovery refused because the prior runtime differs from its verified inventory\n' >&2
    return 1
  }
  validate_previous_runtime "$runtime_dir" || {
    printf 'deploy: no-journal recovery refused because the prior runtime is not restartable with current configuration\n' >&2
    return 1
  }
  state=$(read_service_state) || state=unknown
  case "$state" in
    active)
      wait_for_health || {
        printf 'deploy: unchanged previous runtime is active but not healthy; it was left untouched\n' >&2
        return 1
      }
      printf 'deploy: unchanged previous runtime remains active and healthy; unresolved marker retained\n' >&2
      return 0
      ;;
    inactive|failed)
      assert_service_quiescent || {
        printf 'deploy: no-journal recovery refused because service quiescence is not proven\n' >&2
        return 1
      }
      current_digest=$(runtime_tree_digest "$runtime_dir") || return 1
      [[ "$current_digest" == "$old_tree_digest" ]] && validate_previous_runtime "$runtime_dir" || {
        printf 'deploy: no-journal recovery refused because the prior runtime changed before restart\n' >&2
        return 1
      }
      systemctl --user start "$service_name" || {
        printf 'deploy: unchanged previous runtime restart failed; unresolved marker retained\n' >&2
        return 1
      }
      wait_for_health || {
        printf 'deploy: unchanged previous runtime restart was requested but health failed; unresolved marker retained\n' >&2
        return 1
      }
      printf 'deploy: restarted unchanged previous runtime without a journal update; unresolved marker retained\n' >&2
      return 0
      ;;
    *)
      printf 'deploy: no-journal recovery refused for uncertain systemd state %s\n' "$state" >&2
      return 1
      ;;
  esac
}

rollback_transaction() {
  local state previous_revision current_digest backup_verified
  previous_revision='unknown (no trusted revision metadata)'
  if ! update_transaction_marker rolling-back; then
    printf 'deploy: rollback journal update failed; attempting only a non-destructive restart of an independently verified unchanged previous runtime\n' >&2
    recover_unchanged_previous_without_journal || true
    printf 'deploy: unresolved transaction marker retained because rollback phase could not be recorded\n' >&2
    recovery_hint
    return 1
  fi
  state=$(read_service_state) || state=unknown

  if [[ "$runtime_promoted" == true || -e "$old_runtime_backup" ]]; then
    case "$state" in
      active|activating|deactivating|reloading)
        if ! stop_service_for_failure; then
          printf 'deploy: rollback stopped: service cgroup is not proven empty; previous runtime is preserved at %s\n' "${old_runtime_backup:-not available}" >&2
          recovery_hint
          return 1
        fi
        ;;
      inactive|failed)
        if ! assert_service_quiescent; then
          printf 'deploy: rollback stopped: failed/inactive service still has a pending job or cgroup process; previous runtime is preserved at %s\n' "${old_runtime_backup:-not available}" >&2
          recovery_hint
          return 1
        fi
        ;;
      *)
        printf 'deploy: rollback stopped: systemd state is unknown or transitional (%s); previous runtime is preserved at %s\n' "$state" "${old_runtime_backup:-not available}" >&2
        recovery_hint
        return 1
        ;;
    esac

    backup_verified=false
    if [[ "$old_runtime_backup" != "$home_dir/.opencode-client-previous.$transaction_id" ]]; then
      printf 'deploy: rollback stopped: backup path does not match this transaction identity; preserving all runtimes\n' >&2
      recovery_hint
      return 1
    fi
    if [[ "$old_runtime_present" == true ]]; then
      if [[ -z "$old_tree_digest" ]]; then
        printf 'deploy: rollback stopped: previous runtime inventory was not durably recorded; preserving all runtimes\n' >&2
        recovery_hint
        return 1
      fi
      if [[ -d "$old_runtime_backup" && ! -L "$old_runtime_backup" ]]; then
        current_digest=$(runtime_tree_digest "$old_runtime_backup") || {
          printf 'deploy: rollback stopped: previous runtime ownership or nested mounts are uncertain; preserving promoted runtime at %s and backup at %s\n' "$runtime_dir" "$old_runtime_backup" >&2
          recovery_hint
          return 1
        }
        if [[ "$current_digest" != "$old_tree_digest" ]] || ! validate_previous_runtime "$old_runtime_backup"; then
          printf 'deploy: rollback stopped: exact backup differs from its inventory or is not restartable; preserving both runtimes at %s and %s\n' "$runtime_dir" "$old_runtime_backup" >&2
          recovery_hint
          return 1
        fi
        backup_verified=true
      elif [[ "$runtime_promoted" != true && -d "$runtime_dir" && ! -L "$runtime_dir" ]]; then
        current_digest=$(runtime_tree_digest "$runtime_dir") || return 1
        if [[ "$current_digest" != "$old_tree_digest" ]] || ! validate_previous_runtime "$runtime_dir"; then
          printf 'deploy: rollback stopped: unchanged-path previous runtime is not independently verified; preserving it\n' >&2
          recovery_hint
          return 1
        fi
      else
        printf 'deploy: rollback stopped: exact previous backup path is unavailable; preserving promoted runtime at %s and inspecting marker %s\n' "$runtime_dir" "$transaction_marker_path" >&2
        recovery_hint
        return 1
      fi
    elif [[ -e "$old_runtime_backup" || -L "$old_runtime_backup" ]]; then
      printf 'deploy: rollback stopped: transaction says no previous runtime existed but its exact backup path is occupied: %s\n' "$old_runtime_backup" >&2
      recovery_hint
      return 1
    fi

    # Do not remove the promoted runtime until the exact previous backup (if
    # any) has passed identity, ownership, mount, ENV_FILE, launcher, and Next
    # CLI checks. A failed precheck preserves both runtime trees.
    if [[ "$runtime_promoted" == true ]]; then
      if [[ -e "$runtime_dir" || -L "$runtime_dir" ]]; then
        if [[ ! -d "$runtime_dir" || -L "$runtime_dir" ]]; then
          printf 'deploy: rollback stopped: promoted runtime path is not a transaction-owned directory\n' >&2
          recovery_hint
          return 1
        fi
        current_digest=$(runtime_tree_digest "$runtime_dir" "$transaction_id") || {
          printf 'deploy: rollback stopped: promoted runtime ownership, nested mounts, or contents are uncertain\n' >&2
          recovery_hint
          return 1
        }
        if ! update_transaction_marker rolling-back "$old_tree_digest" "$current_digest"; then
          printf 'deploy: rollback stopped because promoted-runtime identity could not be recorded\n' >&2
          recovery_hint
          return 1
        fi
        if ! "$node_path" "$runtime_tree_safety_script" remove "$runtime_dir" "$(id -u)" "$current_digest" "$transaction_id"; then
          printf 'deploy: rollback stopped: failed promoted runtime was preserved because safe deletion could not be verified\n' >&2
          recovery_hint
          return 1
        fi
      fi
      runtime_promoted=false
    fi

    if [[ "$old_runtime_present" == true ]]; then
      if [[ "$backup_verified" == true ]]; then
        current_digest=$(runtime_tree_digest "$old_runtime_backup") || {
          printf 'deploy: rollback stopped: previous backup changed before restoration; preserved at %s\n' "$old_runtime_backup" >&2
          recovery_hint
          return 1
        }
        if [[ "$current_digest" != "$old_tree_digest" ]] || ! validate_previous_runtime "$old_runtime_backup"; then
          printf 'deploy: rollback stopped: previous backup changed or is no longer restartable; preserved at %s\n' "$old_runtime_backup" >&2
          recovery_hint
          return 1
        fi
        previous_revision=$(runtime_revision "$old_runtime_backup")
        [[ ! -e "$runtime_dir" && ! -L "$runtime_dir" ]] || {
          printf 'deploy: rollback stopped: active runtime path unexpectedly exists; previous runtime preserved at %s\n' "$old_runtime_backup" >&2
          recovery_hint
          return 1
        }
        if ! mv -- "$old_runtime_backup" "$runtime_dir"; then
          printf 'deploy: rollback could not restore previous runtime; preserved at %s\n' "$old_runtime_backup" >&2
          recovery_hint
          return 1
        fi
        old_runtime_backup=''
        printf 'deploy: restored previous runtime revision %s\n' "$previous_revision" >&2
      elif [[ -d "$runtime_dir" && ! -L "$runtime_dir" ]]; then
        printf 'deploy: previous runtime remained in place (revision %s)\n' "$(runtime_revision "$runtime_dir")" >&2
      else
        printf 'deploy: rollback stopped: exact previous runtime path is unavailable; inspect marker %s\n' "$transaction_marker_path" >&2
        recovery_hint
        return 1
      fi
    fi
  fi

  if [[ "$restore_service" == true ]]; then
    state=$(read_service_state) || state=unknown
    case "$state" in
      active)
        if ! validate_previous_runtime "$runtime_dir" || ! wait_for_health; then
          printf 'deploy: previous service remains active but is not verified restartable and healthy\n' >&2
          recovery_hint
          return 1
        fi
        printf 'deploy: previous service remains active and healthy after rollback\n' >&2
        ;;
      inactive|failed)
        if ! assert_service_quiescent; then
          printf 'deploy: previous runtime is present but systemd quiescence cannot be proven; not starting it\n' >&2
          recovery_hint
          return 1
        fi
        if ! validate_previous_runtime "$runtime_dir"; then
          printf 'deploy: previous runtime is unavailable or unverifiable with the current environment; service was not started\n' >&2
          recovery_hint
          return 1
        fi
        if ! systemctl --user start "$service_name"; then
          printf 'deploy: previous runtime restored, but systemd could not start it (state: %s)\n' "$(read_service_state || printf unknown)" >&2
          recovery_hint
          return 1
        fi
        if ! wait_for_health; then
          printf 'deploy: previous runtime restored and start requested, but health check failed\n' >&2
          recovery_hint
          return 1
        fi
        printf 'deploy: previous runtime is healthy; service availability restored\n' >&2
        ;;
      *)
        printf 'deploy: rollback did not start service because its state is uncertain (%s); marker retained at %s\n' "$state" "$transaction_marker_path" >&2
        recovery_hint
        return 1
        ;;
    esac
  fi

  update_transaction_marker rolled-back "$old_tree_digest" "$new_tree_digest" || return 1
  remove_transaction_marker || {
    printf 'deploy: safe rollback completed but transaction marker could not be removed: %s\n' "$transaction_marker_path" >&2
    return 1
  }
  transaction_started=false
  return 0
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
printf '%s\n' "$commit" >"$stage_dir/.runtime-source-revision"
"$node_path" "$stage_dir/scripts/runtime-env.mjs" verify "$env_file" "$stage_dir/.runtime-env.sha256" || \
  fail 'ENV_FILE changed during build; active runtime was not changed'

# Recheck loaded properties immediately before promotion in case systemd was
# reloaded or the unit changed while the isolated build was running.
preflight_runtime_unit
state=$(read_service_state) || fail 'could not determine systemd service state; active runtime was not changed'
case "$state" in
  active|failed)
    restore_service=true
    old_runtime_present=true
    ;;
  inactive)
    if [[ -e "$runtime_dir" || -L "$runtime_dir" ]]; then
      old_runtime_present=true
    fi
    ;;
  *)
    fail "service is in transitional or unrecognized state '$state'; active runtime was not changed"
    ;;
esac
initial_service_state=$state
if [[ "$old_runtime_present" == true ]]; then
  if ! validate_previous_runtime "$runtime_dir"; then
    fail 'previous runtime is not safely owned, structurally restartable, or compatible with the current ENV_FILE; service was not stopped'
  fi
  initial_old_tree_digest=$(runtime_tree_digest "$runtime_dir") || \
    fail 'previous runtime contains foreign ownership, special files, or nested mounts; service was not stopped'
else
  [[ "$restore_service" != true ]] || fail 'active or failed service has no verifiable previous runtime; refusing to stop it'
  initial_old_tree_digest=''
fi

[[ ! -e "$stage_dir/.runtime-transaction-id" && ! -L "$stage_dir/.runtime-transaction-id" ]] || \
  fail 'selected application source contains reserved deployment transaction metadata'
printf '%s\n' "$transaction_id" >"$stage_dir/.runtime-transaction-id"
new_tree_digest=$(runtime_tree_digest "$stage_dir" "$transaction_id") || \
  fail 'staged runtime contains unsafe ownership, special files, or nested mounts'

current_runtime_env_script_hash=$(sha256sum "$runtime_env_script")
current_runtime_env_script_hash=${current_runtime_env_script_hash%% *}
current_unit_preflight_script_hash=$(sha256sum "$unit_preflight_script")
current_unit_preflight_script_hash=${current_unit_preflight_script_hash%% *}
current_quiescence_script_hash=$(sha256sum "$service_quiescence_script")
current_quiescence_script_hash=${current_quiescence_script_hash%% *}
current_tree_safety_script_hash=$(sha256sum "$runtime_tree_safety_script")
current_tree_safety_script_hash=${current_tree_safety_script_hash%% *}
current_transaction_script_hash=$(sha256sum "$transaction_script")
current_transaction_script_hash=${current_transaction_script_hash%% *}
[[ "$current_runtime_env_script_hash" == "$runtime_env_script_hash" && \
   "$current_unit_preflight_script_hash" == "$unit_preflight_script_hash" && \
   "$current_quiescence_script_hash" == "$service_quiescence_script_hash" && \
   "$current_tree_safety_script_hash" == "$runtime_tree_safety_script_hash" && \
   "$current_transaction_script_hash" == "$transaction_script_hash" ]] || \
  fail 'trusted deployment helper changed during build; active runtime was not changed'
[[ -z "$(git status --porcelain)" ]] || fail 'trusted deployment checkout changed during build; active runtime was not changed'

"$node_path" "$transaction_script" create "$transaction_marker_path" "$transaction_id" "$runtime_dir" "$stage_dir" \
  "$old_runtime_backup" "$commit" "$old_runtime_present" "$restore_service" || \
  fail 'could not durably record deployment transaction before service disruption'
marker_created=true
transaction_started=true
old_tree_digest=$initial_old_tree_digest
update_transaction_marker prepared "$initial_old_tree_digest" "$new_tree_digest" || \
  fail 'could not durably record staged and previous runtime identity'

if [[ "$initial_service_state" == active || "$initial_service_state" == failed ]]; then
  update_transaction_marker stop-requested "$initial_old_tree_digest" "$new_tree_digest" || \
    fail 'could not durably record stop request phase'
  if ! stop_service_and_confirm_inactive; then
    fail 'could not confirm empty service cgroup and no pending systemd job before promotion; attempting previous-runtime recovery'
  fi
else
  if ! assert_service_quiescent; then
    fail 'inactive service has pending activation or remaining cgroup processes; runtime was not changed'
  fi
fi

# Snapshot the exact quiescent old tree into the durable transaction marker,
# then move it to one transaction-id-specific path (never select backups by glob).
if [[ "$old_runtime_present" == true ]]; then
  old_tree_digest=$(runtime_tree_digest "$runtime_dir") || \
    fail 'previous runtime became unsafe while stopping; leaving runtime untouched'
fi
update_transaction_marker quiescent "$old_tree_digest" "$new_tree_digest" || \
  fail 'could not durably record quiescent runtime identity'
if [[ "$old_runtime_present" == true ]]; then
  [[ ! -e "$old_runtime_backup" && ! -L "$old_runtime_backup" ]] || fail 'recorded transaction backup path unexpectedly exists'
  if ! mv -- "$runtime_dir" "$old_runtime_backup"; then
    fail 'could not retain previous runtime for transactional rollback; service was not promoted'
  fi
  update_transaction_marker previous-moved "$old_tree_digest" "$new_tree_digest" || \
    fail 'previous runtime moved but transaction phase could not be recorded; recovery marker retained'
fi

runtime_promoted=true
if ! mv -- "$stage_dir" "$runtime_dir"; then
  fail 'could not promote staged runtime; transactional rollback will restore the previous runtime'
fi
stage_dir=''
update_transaction_marker new-promoted "$old_tree_digest" "$new_tree_digest" || \
  fail 'new runtime promoted but transaction phase could not be recorded; rollback will be attempted'

if ! systemctl --user start "$service_name"; then
  fail 'could not start the new runtime; transactional rollback will restore the previous runtime'
fi
update_transaction_marker new-started "$old_tree_digest" "$new_tree_digest" || \
  fail 'new service started but transaction phase could not be recorded; rollback will be attempted'
if ! wait_for_health; then
  fail 'new runtime failed its health check; transactional rollback will restore the previous runtime'
fi
update_transaction_marker verified "$old_tree_digest" "$new_tree_digest" || \
  fail 'new runtime is healthy but transaction verification phase could not be recorded'

transaction_committed=true
if [[ "$old_runtime_present" == true ]]; then
  previous_revision=$(runtime_revision "$old_runtime_backup")
  current_old_tree_digest=$(runtime_tree_digest "$old_runtime_backup") || {
    printf 'deploy: deployment is healthy, but previous runtime ownership or nested mounts are uncertain at %s; preserved\n' "$old_runtime_backup" >&2
    fail 'deployment is serving the new runtime, but previous-runtime validation failed'
  }
  [[ "$current_old_tree_digest" == "$old_tree_digest" ]] || {
    printf 'deploy: deployment is healthy, but previous runtime changed after its recorded inventory; preserved at %s\n' "$old_runtime_backup" >&2
    fail 'deployment is serving the new runtime, but previous-runtime inventory changed'
  }
  if ! "$node_path" "$runtime_tree_safety_script" remove "$old_runtime_backup" "$(id -u)" "$old_tree_digest" -; then
    printf 'deploy: deployment is healthy, but could not safely remove previous runtime revision %s at %s; preserved\n' "$previous_revision" "$old_runtime_backup" >&2
    fail 'deployment is serving the new runtime, but transactional backup cleanup failed'
  fi
  old_runtime_backup=''
fi
remove_transaction_marker || fail 'deployment is healthy but its durable transaction marker could not be removed'
transaction_started=false

printf 'Deployment succeeded for Git revision %s at runtime %s; previous runtime removed after verified health.\n' "$commit" "$runtime_dir"
