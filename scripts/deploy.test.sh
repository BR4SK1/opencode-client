#!/usr/bin/env bash
set -Eeuo pipefail

trusted_script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script_source="$trusted_script_dir/deploy.sh"
real_git=$(command -v git)
real_flock=$(command -v flock)
test_tmp_base=${TMPDIR:-/tmp/opencode}
test_root=$(mktemp -d "$test_tmp_base/opencode-client-deploy-test.XXXXXX")
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'deploy test: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local value=$1 expected=$2
  [[ "$value" == *"$expected"* ]] || fail "expected output to contain: $expected"
}

make_fixture() {
  local name=$1
  local root="$test_root/$name"
  mkdir -p "$root/repo/scripts" "$root/repo/app" "$root/repo/public" "$root/home" "$root/bin"
  cat >"$root/repo/.gitignore" <<'EOF'
.deploy/
.env.production.local
EOF
  printf 'old-source\n' >"$root/repo/app/version.txt"
  printf '{"name":"fixture","version":"old"}\n' >"$root/repo/package.json"
  printf 'old-config\n' >"$root/repo/next.config.ts"
  printf 'old-app\n' >"$root/repo/app/page.txt"
  printf 'old-public\n' >"$root/repo/public/theme.txt"
  cat >"$root/repo/scripts/deploy.sh" <<'EOF'
#!/usr/bin/env bash
touch "$HOME/old-runner-invoked"
EOF
  printf 'obsolete selected-revision loader\n' >"$root/repo/scripts/runtime-env.mjs"
  git -C "$root/repo" init -q
  git -C "$root/repo" config user.name 'Deploy Test'
  git -C "$root/repo" config user.email 'deploy-test@example.invalid'
  git -C "$root/repo" add .gitignore app/version.txt package.json next.config.ts app public scripts/deploy.sh scripts/runtime-env.mjs
  git -C "$root/repo" commit -qm 'old application source with obsolete runner'
  git -C "$root/repo" rev-parse HEAD >"$root/old-revision"

  cp "$script_source" "$root/repo/scripts/deploy.sh"
  cp "$trusted_script_dir/runtime-env.mjs" "$root/repo/scripts/runtime-env.mjs"
  cp "$trusted_script_dir/systemd-unit-preflight.mjs" "$root/repo/scripts/systemd-unit-preflight.mjs"
  cp "$trusted_script_dir/runtime-tree-safety.mjs" "$root/repo/scripts/runtime-tree-safety.real.mjs"
  cat >"$root/repo/scripts/runtime-tree-safety.mjs" <<'MOCK_TREE_SAFETY'
#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const [operation, target, ...args] = process.argv.slice(2);
if (operation === 'remove' && process.env.MOCK_FAIL_STAGE_CLEANUP === 'true' && path.basename(target).startsWith('.opencode-client-stage.')) {
  process.stderr.write('deploy: mocked staged-runtime cleanup failure\\n');
  process.exit(1);
}
if (operation === 'remove' && process.env.MOCK_FAIL_PREVIOUS_CLEANUP === 'true' && path.basename(target).startsWith('.opencode-client-previous.')) {
  process.stderr.write('deploy: mocked previous-runtime cleanup failure\\n');
  process.exit(1);
}
const result = spawnSync(process.execPath, [path.join(scriptDirectory, 'runtime-tree-safety.real.mjs'), operation, target, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
MOCK_TREE_SAFETY
  cp "$trusted_script_dir/deploy-transaction.mjs" "$root/repo/scripts/deploy-transaction.mjs"
  cp "$trusted_script_dir/systemd-service-quiescence.mjs" "$root/repo/scripts/systemd-service-quiescence.mjs"
  cat >"$root/repo/scripts/systemd-service-quiescence.mjs" <<'MOCK_QUIESCENCE'
#!/usr/bin/env node
import fs from 'node:fs';
const state = fs.readFileSync(process.env.MOCK_STATE, 'utf8').trim();
if (state === 'active') {
  process.stderr.write('deploy: mock service is active\n');
  process.exit(1);
}
if (process.env.MOCK_PENDING_JOB === 'true') {
  process.stderr.write('deploy: mock pending systemd job\n');
  process.exit(1);
}
if (process.env.MOCK_CGROUP_PROCESSES === 'true' ||
    (process.env.MOCK_CGROUP_PROCESSES_AFTER_START === 'true' && fs.existsSync(process.env.MOCK_STARTED_MARKER))) {
  process.stderr.write('deploy: mock service cgroup process remains\n');
  process.exit(1);
}
process.stdout.write(`quiescent ${state} /opencode-client-test\\n`);
MOCK_QUIESCENCE
  chmod +x "$root/repo/scripts/deploy.sh" "$root/repo/scripts/systemd-service-quiescence.mjs"
  printf 'current-source\n' >"$root/repo/app/version.txt"
  printf '{"name":"fixture","version":"current"}\n' >"$root/repo/package.json"
  printf 'current-config\n' >"$root/repo/next.config.ts"
  printf 'current-app\n' >"$root/repo/app/page.txt"
  printf 'current-public\n' >"$root/repo/public/theme.txt"
  git -C "$root/repo" add app/version.txt package.json next.config.ts app public scripts/deploy.sh scripts/runtime-env.mjs scripts/systemd-unit-preflight.mjs scripts/runtime-tree-safety.mjs scripts/runtime-tree-safety.real.mjs scripts/deploy-transaction.mjs scripts/systemd-service-quiescence.mjs
  git -C "$root/repo" commit -qm 'trusted runner and current application source'

  cat >"$root/repo/.env.production.local" <<'EOF'
AUTH_SECRET=test-secret-value
AUTH_OIDC_ISSUER=https://issuer.example.invalid/tenant?a=b
AUTH_OIDC_ID=client-id
AUTH_OIDC_SECRET=client-secret
AUTH_ALLOWED_EMAILS=build@example.invalid
AUTH_DEMO=false
OPENCODE_BASE_URL=http://localhost:4096
OPENCODE_TOKEN=Basic token$literal
EOF
  printf 'TEST_ENV_FILE=%s\n' "$root/repo/.env.production.local" >>"$root/repo/.env.production.local"
  printf '%s\n' "$root/repo/.env.production.local" >"$root/home/mock-env-file"
  mkdir -p "$root/home/opencode-client-runtime/.next" "$root/home/opencode-client-runtime/node_modules" "$root/home/opencode-client-runtime/public" "$root/home/opencode-client-runtime/app"
  printf 'previous-source\n' >"$root/home/opencode-client-runtime/app/version.txt"
  printf 'previous-build\n' >"$root/home/opencode-client-runtime/.next/BUILD_ID"
  printf 'previous-dependency\n' >"$root/home/opencode-client-runtime/node_modules/original"
  printf 'previous-public\n' >"$root/home/opencode-client-runtime/public/theme.txt"
  printf '{"name":"fixture","version":"previous"}\n' >"$root/home/opencode-client-runtime/package.json"
  printf '%s\n' "$(<"$root/old-revision")" >"$root/home/opencode-client-runtime/.runtime-source-revision"
  mkdir -p "$root/home/opencode-client-runtime/scripts" "$root/home/opencode-client-runtime/node_modules/next/dist/bin"
  printf 'process.exit(0);\n' >"$root/home/opencode-client-runtime/node_modules/next/dist/bin/next"
  cp "$trusted_script_dir/runtime-env.mjs" "$root/home/opencode-client-runtime/scripts/runtime-env.mjs"
  sha256sum "$root/repo/.env.production.local" | cut -d ' ' -f 1 >"$root/home/opencode-client-runtime/.runtime-env.sha256"
  printf 'active\n' >"$root/active"
  : >"$root/commands.log"

  cat >"$root/bin/id" <<'EOF'
#!/usr/bin/env bash
if [[ "${1-}" == -u ]]; then
  printf '1000\n'
else
  exec /usr/bin/id "$@"
fi
EOF
  cat >"$root/bin/git" <<'EOF'
#!/usr/bin/env bash
exec "$MOCK_REAL_GIT" "$@"
EOF
  cat >"$root/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -eu
if [[ -n "${MOCK_LOG:-}" ]]; then printf 'pnpm %s\n' "$*" >>"$MOCK_LOG"; fi
case "$1" in
  install)
    mkdir -p node_modules/next/dist/bin
    printf '%s\n' "$(<package.json)" >node_modules/generated-from-package
    cat >node_modules/next/dist/bin/next <<'MOCK_NEXT'
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'build') process.exit(2);
if (fs.existsSync(path.join(process.env.HOME, 'mock-build-fail'))) {
  process.stderr.write('mock build failure\n');
  process.exit(1);
}
if (fs.existsSync(path.join(process.env.HOME, 'mock-change-env-during-build'))) {
  fs.appendFileSync(process.env.TEST_ENV_FILE, 'ENV_CHANGED=during-build\n');
}
fs.mkdirSync('.next', { recursive: true });
fs.writeFileSync('.next/BUILD_ID', fs.readFileSync('app/version.txt'));
const keys = ['AUTH_SECRET', 'AUTH_OIDC_ISSUER', 'AUTH_OIDC_ID', 'AUTH_OIDC_SECRET', 'AUTH_ALLOWED_EMAILS', 'AUTH_DEMO', 'OPENCODE_BASE_URL', 'OPENCODE_TOKEN', 'TEST_ENV_FILE'];
fs.writeFileSync('.next/application-env.json', JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));
if (fs.existsSync(path.join(process.env.HOME, 'mock-build-dotenv'))) {
  fs.writeFileSync('.env.production.local', 'INJECTED=build-hook\n');
}
MOCK_NEXT
    if [[ -f "$HOME/mock-install-dotenv" ]]; then printf 'INJECTED=install-hook\n' >.env.production; fi
    ;;
  lint)
    ;;
  build)
    printf 'deployment runner must invoke Next directly, not through pnpm lifecycle environment\n' >&2
    exit 2
    ;;
  *)
    printf 'unexpected pnpm command: %s\n' "$1" >&2
    exit 2
    ;;
esac
EOF
  cat >"$root/bin/busctl" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'busctl %s\n' "$*" >>"$MOCK_LOG"
if [[ "${3-}" == call && "${7-}" == LoadUnit ]]; then
  case "${MOCK_LOADUNIT_REPLY:-valid}" in
    valid)
      printf '{"type":"o","data":["/org/freedesktop/systemd1/unit/opencode_2dclient_2eservice"]}\n'
      ;;
    wrong-type)
      printf '{"type":"s","data":["/org/freedesktop/systemd1/unit/opencode_2dclient_2eservice"]}\n'
      ;;
    empty)
      printf '{"type":"o","data":[]}\n'
      ;;
    multiple)
      printf '{"type":"o","data":["/org/freedesktop/systemd1/unit/opencode_2dclient_2eservice","/org/freedesktop/systemd1/unit/other"]}\n'
      ;;
    non-string)
      printf '{"type":"o","data":[42]}\n'
      ;;
    invalid-path)
      printf '{"type":"o","data":["/org/freedesktop/systemd1/manager"]}\n'
      ;;
    malformed)
      printf '{not-json}\n'
      ;;
    *)
      printf 'unsupported mock LoadUnit reply: %s\n' "$MOCK_LOADUNIT_REPLY" >&2
      exit 2
      ;;
  esac
  exit 0
fi
if [[ "${3-}" == call && "${7-}" == ListJobs ]]; then
  if [[ "${MOCK_PENDING_JOB:-false}" == true ]]; then
    printf '{"type":"a(usssoo)","data":[[1,"opencode-client.service","stop","running","/org/freedesktop/systemd1/job/1","/org/freedesktop/systemd1/unit/opencode_2dclient_2eservice"]]}\n'
  else
    printf '{"type":"a(usssoo)","data":[]}\n'
  fi
  exit 0
fi
property=${!#}
runtime=$MOCK_RUNTIME_DIR
[[ "${MOCK_OLD_UNIT:-false}" == true ]] && runtime=$MOCK_PROJECT_ROOT
start_path=/usr/bin/node
[[ "${MOCK_BAD_EXEC_PATH:-false}" == true ]] && start_path=/tmp/evil-node
start_port=${MOCK_UNIT_PORT:-5115}
[[ "${MOCK_BAD_EXEC_ARGS:-false}" == true ]] && start_port=3000
start_ignore=false
[[ "${MOCK_EXEC_IGNORE_ERRORS:-false}" == true ]] && start_ignore=true
pre_path=/usr/bin/node
[[ "${MOCK_PRE_BAD_PATH:-false}" == true ]] && pre_path=/tmp/evil-node
pre_env_file=$MOCK_ENV_FILE
[[ "${MOCK_PRE_BAD_ARGS:-false}" == true ]] && pre_env_file="$MOCK_HOME/wrong.env"
pre_ignore=false
[[ "${MOCK_PRE_IGNORE_ERRORS:-false}" == true ]] && pre_ignore=true
case "$property" in
  WorkingDirectory)
    printf '{"type":"s","data":"%s"}\n' "$runtime"
    ;;
  ExecStart)
    printf '{"type":"a(sasbttttuii)","data":[["%s",["%s","%s/scripts/runtime-env.mjs","start","%s","%s/.runtime-env.sha256","%s","127.0.0.1","%s"],%s,0,0,0,0,0,0,0]]}\n' \
      "$start_path" "$start_path" "$runtime" "$MOCK_ENV_FILE" "$runtime" "$runtime" "$start_port" "$start_ignore"
    ;;
  ExecStartPre)
    printf '{"type":"a(sasbttttuii)","data":[["%s",["%s","%s/scripts/runtime-env.mjs","verify","%s","%s/.runtime-env.sha256"],%s,0,0,0,0,0,0,0]]}\n' \
      "$pre_path" "$pre_path" "$runtime" "$pre_env_file" "$runtime" "$pre_ignore"
    ;;
  Type)
    printf '{"type":"s","data":"%s"}\n' "${MOCK_SERVICE_TYPE:-simple}"
    ;;
  Restart)
    printf '{"type":"s","data":"%s"}\n' "${MOCK_RESTART_POLICY:-on-failure}"
    ;;
  KillMode)
    printf '{"type":"s","data":"%s"}\n' "${MOCK_KILL_MODE:-control-group}"
    ;;
  TimeoutStopUSec)
    printf '{"type":"t","data":%s}\n' "${MOCK_TIMEOUT_STOP_USEC:-30000000}"
    ;;
  SendSIGKILL)
    printf '{"type":"b","data":%s}\n' "${MOCK_SEND_SIGKILL:-true}"
    ;;
  KillSignal)
    printf '{"type":"i","data":%s}\n' "${MOCK_KILL_SIGNAL:-15}"
    ;;
  FinalKillSignal)
    printf '{"type":"i","data":%s}\n' "${MOCK_FINAL_KILL_SIGNAL:-9}"
    ;;
  TimeoutStopFailureMode)
    printf '{"type":"s","data":"%s"}\n' "${MOCK_TIMEOUT_STOP_FAILURE_MODE:-terminate}"
    ;;
  ActiveState)
    printf '{"type":"s","data":"%s"}\n' "$(cat "$MOCK_STATE")"
    ;;
  SubState)
    state=$(cat "$MOCK_STATE")
    case "$state" in active) substate=running ;; failed) substate=failed ;; *) substate=dead ;; esac
    printf '{"type":"s","data":"%s"}\n' "$substate"
    ;;
  Job)
    if [[ "${MOCK_PENDING_JOB:-false}" == true ]]; then
      printf '{"type":"(uo)","data":[1,"/org/freedesktop/systemd1/job/1"]}\n'
    else
      printf '{"type":"(uo)","data":[0,"/"]}\n'
    fi
    ;;
  ControlGroup)
    printf '{"type":"s","data":"/opencode-client-test"}\n'
    ;;
  MainPID)
    if [[ "$(cat "$MOCK_STATE")" == active ]]; then printf '{"type":"u","data":123}\n'; else printf '{"type":"u","data":0}\n'; fi
    ;;
  ExecCondition|ExecStartPost|ExecReload|ExecReloadPost|ExecStop|ExecStopPost)
    if [[ "${MOCK_AUX_COMMAND:-false}" == true && "$property" == ExecStartPost ]]; then
      printf '{"type":"a(sasbttttuii)","data":[["/bin/true",["/bin/true"],false,0,0,0,0,0,0,0]]}\n'
    else
      printf '{"type":"a(sasbttttuii)","data":[]}\n'
    fi
    ;;
  Environment)
    if [[ "${MOCK_NONEMPTY_ENVIRONMENT:-false}" == true ]]; then
      printf '{"type":"as","data":["NODE_ENV=production"]}\n'
    else
      printf '{"type":"as","data":[]}\n'
    fi
    ;;
  EnvironmentFiles)
    if [[ "${MOCK_NONEMPTY_ENVIRONMENT_FILES:-false}" == true ]]; then
      printf '{"type":"a(sb)","data":[["%s",true]]}\n' "$MOCK_ENV_FILE"
    else
      printf '{"type":"a(sb)","data":[]}\n'
    fi
    ;;
  UnsetEnvironment)
    if [[ "${MOCK_UNSET_MISMATCH:-false}" == true ]]; then
      printf '{"type":"as","data":[]}\n'
    else
      printf '{"type":"as","data":["NODE_OPTIONS"]}\n'
    fi
    ;;
  *)
    printf 'unsupported busctl property: %s\n' "$property" >&2
    exit 2
    ;;
esac
EOF
  cat >"$root/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
case "${2-}" in
  is-active)
    state=$(cat "$MOCK_STATE" 2>/dev/null || printf 'inactive')
    printf '%s\n' "$state"
    [[ "$state" == active ]]
    ;;
  stop)
    [[ -f "$MOCK_TRANSACTION_MARKER" ]] || { printf 'transaction marker absent before stop\n' >&2; exit 1; }
    if [[ "${MOCK_STOP_TIMEOUT_FAILED:-false}" == true ]] || \
      [[ "${MOCK_STOP_TIMEOUT_FAILED_AFTER_START:-false}" == true && -f "$MOCK_STARTED_MARKER" ]]; then
      printf 'failed\n' >"$MOCK_STATE"
      exit 1
    fi
    if [[ "${MOCK_STOP_FAIL:-false}" == true ]] || \
      [[ "${MOCK_STOP_FAIL_AFTER_START:-false}" == true && -f "$MOCK_STARTED_MARKER" ]]; then
      exit 1
    fi
    if [[ "${MOCK_STOP_FAIL_INACTIVE_AFTER_START:-false}" == true && -f "$MOCK_STARTED_MARKER" ]]; then
      printf 'inactive\n' >"$MOCK_STATE"
      exit 1
    fi
    printf 'inactive\n' >"$MOCK_STATE"
    ;;
  start)
    : >"$MOCK_STARTED_MARKER"
    if [[ "${MOCK_CHANGE_ENV_BEFORE_START:-false}" == true ]]; then
      printf 'ENV_CHANGED=before-start\n' >>"$MOCK_ENV_FILE"
    fi
    if ! /usr/bin/node "$MOCK_RUNTIME_DIR/scripts/runtime-env.mjs" verify "$MOCK_ENV_FILE" "$MOCK_RUNTIME_DIR/.runtime-env.sha256"; then
      printf 'failed\n' >"$MOCK_STATE"
      exit 1
    fi
    runtime_version=$(<"$MOCK_RUNTIME_DIR/app/version.txt")
    if [[ "${MOCK_CORRUPT_BACKUP_AFTER_PROMOTION:-false}" == true && "$runtime_version" == current-source ]]; then
      backup=$(find "$MOCK_HOME" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)
      [[ -n "$backup" ]] || { printf 'expected backup path missing in test mock\n' >&2; exit 1; }
      printf 'invalidated-env-digest\n' >"$backup/.runtime-env.sha256"
    fi
    if [[ "${MOCK_START_FAIL:-false}" == true && "$runtime_version" == current-source ]] || \
      [[ "${MOCK_START_FAIL_OLD:-false}" == true && "$runtime_version" == previous-source ]]; then
      printf 'failed\n' >"$MOCK_STATE"
      exit 1
    fi
    printf 'active\n' >"$MOCK_STATE"
    ;;
  *)
    printf 'unexpected systemctl command: %s\n' "$*" >&2
    exit 2
    ;;
esac
EOF
  cat >"$root/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -eu
url=${!#}
printf 'curl %s\n' "$url" >>"$MOCK_LOG"
runtime_version=$(<"$MOCK_RUNTIME_DIR/app/version.txt")
if [[ "${MOCK_HEALTH_FAIL:-false}" == true ]] || \
  [[ "${MOCK_HEALTH_FAIL_NEW:-false}" == true && "$runtime_version" == current-source ]] || \
  [[ "${MOCK_HEALTH_FAIL_OLD:-false}" == true && "$runtime_version" == previous-source ]]; then
  printf '503'
else
  printf '200'
fi
EOF
  cat >"$root/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -eu
args=("$@")
source=${args[1]}
destination=${args[${#args[@]}-1]}
if [[ "${MOCK_FAIL_RUNTIME_PROMOTION:-false}" == true && "$destination" == "$MOCK_RUNTIME_DIR" && "$source" == "$MOCK_HOME"/.opencode-client-stage.* ]]; then
  printf 'mocked runtime promotion failure\n' >&2
  exit 1
fi
exec /bin/mv "$@"
EOF
  cat >"$root/bin/rm" <<'EOF'
#!/usr/bin/env bash
set -eu
args=("$@")
target=${args[${#args[@]}-1]}
if [[ "${MOCK_FAIL_PREVIOUS_CLEANUP:-false}" == true && "$target" == "$MOCK_HOME"/.opencode-client-previous.* ]]; then
  printf 'mocked previous-runtime cleanup failure\n' >&2
  exit 1
fi
if [[ "${MOCK_FAIL_STAGE_CLEANUP:-false}" == true && "$target" == "$MOCK_HOME"/.opencode-client-stage.* ]]; then
  printf 'mocked stage cleanup failure\n' >&2
  exit 1
fi
exec /bin/rm "$@"
EOF
  chmod +x "$root/bin/id" "$root/bin/git" "$root/bin/pnpm" "$root/bin/busctl" "$root/bin/systemctl" "$root/bin/curl" "$root/bin/mv" "$root/bin/rm"
}

run_deploy() {
  local root=$1
  shift
  mkdir -p "$root/home"
  (
    cd "$root/repo"
    env \
      HOME="$root/home" \
      PATH="$root/bin:$PATH" \
      MOCK_REAL_GIT="$real_git" \
      MOCK_HOME="$root/home" \
      MOCK_STATE="$root/active" \
      MOCK_LOG="$root/commands.log" \
      MOCK_STARTED_MARKER="$root/started" \
      MOCK_TRANSACTION_MARKER="$root/home/.opencode-client-deploy.transaction.json" \
      MOCK_OLD_RUNNER_SENTINEL="$root/old-runner-invoked" \
      MOCK_PROJECT_ROOT="$root/repo" \
      MOCK_RUNTIME_DIR="$root/home/opencode-client-runtime" \
      MOCK_ENV_FILE="$root/repo/.env.production.local" \
      ENV_FILE="$root/repo/.env.production.local" \
      HEALTH_TIMEOUT_SECONDS=1 \
      "$@" \
      ./scripts/deploy.sh
  )
}

assert_lock_released() {
  local root=$1
  (exec 9>"$root/home/.opencode-client-deploy.lock"; "$real_flock" -n 9) || fail 'shared deployment lock was not released'
}

assert_stage_cleaned() {
  local root=$1
  [[ -z "$(find "$root/home" -maxdepth 1 -type d -name '.opencode-client-stage.*' -print -quit)" ]] || fail 'temporary runtime stage remains'
}

assert_no_git_worktree() {
  local root=$1
  local listing
  listing=$("$real_git" -C "$root/repo" worktree list --porcelain)
  [[ "$(grep -c '^worktree ' <<<"$listing")" -eq 1 ]] || fail 'deployment created or retained a registered Git worktree'
}

assert_no_previous_release_copy() {
  local root=$1
  [[ -z "$(find "$root/home" -mindepth 1 -maxdepth 1 -type d ! -name opencode-client-runtime -print -quit)" ]] || fail 'a staging or previous-release directory remains'
}

assert_runtime_env_valid() {
  local runtime=$1
  local env_file=$2
  /usr/bin/node "$runtime/scripts/runtime-env.mjs" verify "$env_file" "$runtime/.runtime-env.sha256" || fail 'runtime environment does not match the external ENV_FILE'
  [[ ! -e "$runtime/.env.production.local" ]] || fail 'secret environment file was retained in active runtime'
  [[ "$(<"$runtime/.runtime-env.sha256")" =~ ^[a-f0-9]{64}$ ]] || fail 'runtime checksum metadata contains more than the non-secret digest'
}

assert_built_application_env() {
  local runtime=$1
  local env_file=$2
  /usr/bin/node - "$runtime/.next/application-env.json" "$env_file" <<'NODE' || fail 'build child did not receive the parsed application environment values'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const actual = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.deepEqual(actual, {
  AUTH_SECRET: 'test-secret-value',
  AUTH_OIDC_ISSUER: 'https://issuer.example.invalid/tenant?a=b',
  AUTH_OIDC_ID: 'client-id',
  AUTH_OIDC_SECRET: 'client-secret',
  AUTH_ALLOWED_EMAILS: 'build@example.invalid',
  AUTH_DEMO: 'false',
  OPENCODE_BASE_URL: 'http://localhost:4096',
  OPENCODE_TOKEN: 'Basic token$literal',
  TEST_ENV_FILE: process.argv[3],
});
NODE
}

assert_previous_runtime_intact() {
  local runtime=$1
  [[ "$(<"$runtime/app/version.txt")" == previous-source ]] || fail 'pre-promotion failure changed the previous runtime source'
  [[ "$(<"$runtime/.next/BUILD_ID")" == previous-build ]] || fail 'pre-promotion failure changed the previous runtime build'
  [[ "$(<"$runtime/node_modules/original")" == previous-dependency ]] || fail 'pre-promotion failure changed the previous runtime dependencies'
  [[ "$(<"$runtime/public/theme.txt")" == previous-public ]] || fail 'pre-promotion failure changed the previous runtime public assets'
  [[ "$(<"$runtime/.runtime-source-revision")" == "$(<"${runtime%/home/opencode-client-runtime}/old-revision")" ]] || fail 'pre-promotion failure changed old runtime revision provenance'
}

# Current source is promoted as a coherent runtime: source files, config,
# public assets, dependencies, and build output all come from one revision.
make_fixture success
success_output=$(run_deploy "$test_root/success" 2>&1) || fail "healthy runtime deploy failed: $success_output"
assert_contains "$success_output" 'Deployment succeeded for Git revision'
[[ "$(<"$test_root/success/home/opencode-client-runtime/app/version.txt")" == current-source ]] || fail 'runtime source does not match selected current revision'
[[ "$(<"$test_root/success/home/opencode-client-runtime/public/theme.txt")" == current-public ]] || fail 'runtime public assets came from the wrong revision'
[[ "$(<"$test_root/success/home/opencode-client-runtime/next.config.ts")" == current-config ]] || fail 'runtime configuration came from the wrong revision'
[[ "$(<"$test_root/success/home/opencode-client-runtime/app/page.txt")" == current-app ]] || fail 'runtime app files came from the wrong revision'
[[ "$(<"$test_root/success/home/opencode-client-runtime/.next/BUILD_ID")" == current-source ]] || fail 'runtime build does not match runtime source revision'
[[ "$(<"$test_root/success/home/opencode-client-runtime/.runtime-source-revision")" == "$(git -C "$test_root/success/repo" rev-parse HEAD)" ]] || fail 'active runtime does not record selected source revision'
[[ "$(<"$test_root/success/home/opencode-client-runtime/.runtime-transaction-id")" =~ ^[a-f0-9]{32}$ ]] || fail 'active runtime does not retain its deployment transaction provenance'
grep -Fq '"version":"current"' "$test_root/success/home/opencode-client-runtime/node_modules/generated-from-package" || fail 'dependencies were not installed from runtime package source'
[[ ! -e "$test_root/success/home/opencode-client-runtime/.git" ]] || fail 'runtime contains Git metadata'
grep -q 'const CONTROLLED_KEYS' "$test_root/success/home/opencode-client-runtime/scripts/runtime-env.mjs" || fail 'runtime did not receive the trusted shared environment loader'
assert_runtime_env_valid "$test_root/success/home/opencode-client-runtime" "$test_root/success/repo/.env.production.local"
assert_built_application_env "$test_root/success/home/opencode-client-runtime" "$test_root/success/repo/.env.production.local"
[[ "$(<"$test_root/success/active")" == active ]] || fail 'service is not active after healthy deployment'
grep -Fq 'curl http://127.0.0.1:5115/signin' "$test_root/success/commands.log" || fail 'health check did not target configured host port 5115'
assert_stage_cleaned "$test_root/success"
assert_no_git_worktree "$test_root/success"
assert_no_previous_release_copy "$test_root/success"
assert_lock_released "$test_root/success"

# Backup deletion happens only after the new runtime passes health. If that
# cleanup fails, report failure and preserve the transaction path for inspection.
make_fixture previous-cleanup-failure
if previous_cleanup_output=$(run_deploy "$test_root/previous-cleanup-failure" MOCK_FAIL_PREVIOUS_CLEANUP=true 2>&1); then
  fail 'deployment unexpectedly hid previous-runtime cleanup failure'
fi
assert_contains "$previous_cleanup_output" 'deployment is serving the new runtime, but transactional backup cleanup failed'
assert_contains "$previous_cleanup_output" 'could not safely remove previous runtime revision'
[[ "$previous_cleanup_output" != *'Deployment succeeded for Git revision'* ]] || fail 'deployment reported success despite failed previous-runtime cleanup'
[[ "$(<"$test_root/previous-cleanup-failure/active")" == active ]] || fail 'cleanup failure stopped the healthy new runtime'
[[ "$(<"$test_root/previous-cleanup-failure/home/opencode-client-runtime/app/version.txt")" == current-source ]] || fail 'cleanup failure changed the healthy promoted runtime'
backup_path=$(find "$test_root/previous-cleanup-failure/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)
[[ -n "$backup_path" && "$(<"$backup_path/app/version.txt")" == previous-source ]] || fail 'cleanup failure did not preserve the previous runtime path'
assert_stage_cleaned "$test_root/previous-cleanup-failure"
assert_lock_released "$test_root/previous-cleanup-failure"

# Recovery deploys selected old source through the trusted current runner while
# the service is stopped and the active runtime directory/assets are missing.
make_fixture source-recovery
rm -rf "$test_root/source-recovery/home/opencode-client-runtime"
printf 'inactive\n' >"$test_root/source-recovery/active"
old_revision=$(<"$test_root/source-recovery/old-revision")
recovery_output=$(run_deploy "$test_root/source-recovery" "SOURCE_REVISION=$old_revision" 2>&1) || fail "source-revision recovery failed: $recovery_output"
[[ "$(<"$test_root/source-recovery/home/opencode-client-runtime/app/version.txt")" == old-source ]] || fail 'recovery did not install selected old source'
[[ "$(<"$test_root/source-recovery/home/opencode-client-runtime/public/theme.txt")" == old-public ]] || fail 'recovery public assets do not match selected old source'
[[ "$(<"$test_root/source-recovery/home/opencode-client-runtime/next.config.ts")" == old-config ]] || fail 'recovery configuration does not match selected old source'
[[ "$(<"$test_root/source-recovery/home/opencode-client-runtime/.next/BUILD_ID")" == old-source ]] || fail 'recovery build does not match selected source'
[[ ! -e "$test_root/source-recovery/home/old-runner-invoked" ]] || fail 'selected source revision executed its obsolete deployment runner'
grep -q 'const CONTROLLED_KEYS' "$test_root/source-recovery/home/opencode-client-runtime/scripts/runtime-env.mjs" || fail 'recovery retained the selected revision obsolete loader instead of the trusted loader'
assert_runtime_env_valid "$test_root/source-recovery/home/opencode-client-runtime" "$test_root/source-recovery/repo/.env.production.local"
assert_stage_cleaned "$test_root/source-recovery"
assert_no_git_worktree "$test_root/source-recovery"
assert_no_previous_release_copy "$test_root/source-recovery"
assert_lock_released "$test_root/source-recovery"

# busctl encodes a method return as an array of return arguments, unlike the
# scalar data field from get-property. The authentic one-path framing succeeds
# above; malformed or ambiguous method replies must fail before build/stop.
for reply_case in wrong-type empty multiple non-string invalid-path malformed; do
  make_fixture "loadunit-$reply_case"
  case "$reply_case" in
    wrong-type) expected='unexpected signature for LoadUnit method return' ;;
    empty|multiple) expected='unexpected argument count for LoadUnit method return' ;;
    non-string|invalid-path) expected='invalid unit object path for LoadUnit method return' ;;
    malformed) expected='malformed structured data for LoadUnit method return' ;;
  esac
  if loadunit_output=$(run_deploy "$test_root/loadunit-$reply_case" "MOCK_LOADUNIT_REPLY=$reply_case" 2>&1); then
    fail "$reply_case LoadUnit reply passed preflight"
  fi
  assert_contains "$loadunit_output" "$expected"
  assert_previous_runtime_intact "$test_root/loadunit-$reply_case/home/opencode-client-runtime"
  [[ "$(<"$test_root/loadunit-$reply_case/active")" == active ]] || fail "$reply_case LoadUnit reply changed service state"
  ! grep -q '^pnpm ' "$test_root/loadunit-$reply_case/commands.log" || fail "$reply_case LoadUnit reply started a build"
  assert_stage_cleaned "$test_root/loadunit-$reply_case"
  assert_lock_released "$test_root/loadunit-$reply_case"
done

# Loaded systemd properties are read as typed D-Bus JSON, not substring-matched
# human renderings. These realistic serialized command tuples must fail closed.
make_fixture old-unit
if old_unit_output=$(run_deploy "$test_root/old-unit" MOCK_OLD_UNIT=true 2>&1); then
  fail 'old checkout-based service unit passed runtime preflight'
fi
assert_contains "$old_unit_output" 'WorkingDirectory does not match RUNTIME_DIR'
assert_previous_runtime_intact "$test_root/old-unit/home/opencode-client-runtime"
[[ "$(<"$test_root/old-unit/active")" == active ]] || fail 'old-unit preflight changed service state'
! grep -q '^pnpm ' "$test_root/old-unit/commands.log" || fail 'old-unit preflight started a build'
! grep -q 'systemctl --user stop\|systemctl --user start' "$test_root/old-unit/commands.log" || fail 'old-unit preflight changed service state'
assert_stage_cleaned "$test_root/old-unit"
assert_no_git_worktree "$test_root/old-unit"
assert_lock_released "$test_root/old-unit"

for case_name in wrong-unit-port wrong-executable wrong-exec-args ignored-exec ignored-pre wrong-pre-executable wrong-pre-args wrong-type wrong-kill-mode unbounded-stop-timeout no-send-sigkill wrong-stop-signal wrong-stop-failure-mode extra-lifecycle-command restart-always extra-unit-environment environment-file inherited-node-options; do
  make_fixture "$case_name"
  case "$case_name" in
    wrong-unit-port) mock=(MOCK_UNIT_PORT=3000); expected='executable or argument vector' ;;
    wrong-executable) mock=(MOCK_BAD_EXEC_PATH=true); expected='ExecStart executable or argument vector' ;;
    wrong-exec-args) mock=(MOCK_BAD_EXEC_ARGS=true); expected='ExecStart executable or argument vector' ;;
    ignored-exec) mock=(MOCK_EXEC_IGNORE_ERRORS=true); expected='ExecStart must have ignore_errors=no' ;;
    ignored-pre) mock=(MOCK_PRE_IGNORE_ERRORS=true); expected='ExecStartPre must have ignore_errors=no' ;;
    wrong-pre-executable) mock=(MOCK_PRE_BAD_PATH=true); expected='ExecStartPre executable or argument vector' ;;
    wrong-pre-args) mock=(MOCK_PRE_BAD_ARGS=true); expected='ExecStartPre executable or argument vector' ;;
    wrong-type) mock=(MOCK_SERVICE_TYPE=oneshot); expected='Type must be simple' ;;
    wrong-kill-mode) mock=(MOCK_KILL_MODE=process); expected='KillMode must be control-group' ;;
    unbounded-stop-timeout) mock=(MOCK_TIMEOUT_STOP_USEC=90000000); expected='TimeoutStopSec must be exactly 30 seconds' ;;
    no-send-sigkill) mock=(MOCK_SEND_SIGKILL=false); expected='shutdown must use SIGTERM' ;;
    wrong-stop-signal) mock=(MOCK_KILL_SIGNAL=2); expected='shutdown must use SIGTERM' ;;
    wrong-stop-failure-mode) mock=(MOCK_TIMEOUT_STOP_FAILURE_MODE=abort); expected='shutdown must use SIGTERM' ;;
    extra-lifecycle-command) mock=(MOCK_AUX_COMMAND=true); expected='ExecStartPost must be empty' ;;
    restart-always) mock=(MOCK_RESTART_POLICY=always); expected='Restart policy must be on-failure' ;;
    extra-unit-environment) mock=(MOCK_NONEMPTY_ENVIRONMENT=true); expected='Environment must be empty' ;;
    environment-file) mock=(MOCK_NONEMPTY_ENVIRONMENT_FILES=true); expected='EnvironmentFiles must be empty' ;;
    inherited-node-options) mock=(MOCK_UNSET_MISMATCH=true); expected='UnsetEnvironment must remove inherited NODE_OPTIONS' ;;
  esac
  if unit_output=$(run_deploy "$test_root/$case_name" "${mock[@]}" 2>&1); then
    fail "$case_name systemd properties passed runtime preflight"
  fi
  assert_contains "$unit_output" "$expected"
  assert_previous_runtime_intact "$test_root/$case_name/home/opencode-client-runtime"
  [[ "$(<"$test_root/$case_name/active")" == active ]] || fail "$case_name preflight changed service state"
  ! grep -q '^pnpm ' "$test_root/$case_name/commands.log" || fail "$case_name preflight started a build"
  assert_stage_cleaned "$test_root/$case_name"
  assert_lock_released "$test_root/$case_name"
done

# If the journal becomes unwritable after stop, restart only the unchanged,
# independently verified old runtime. Leave the marker unresolved and never
# move or delete either runtime without a durable phase update.
make_fixture rollback-journal-write-failure
cp "$test_root/rollback-journal-write-failure/repo/scripts/deploy-transaction.mjs" \
  "$test_root/rollback-journal-write-failure/repo/scripts/deploy-transaction.real.mjs"
cat >"$test_root/rollback-journal-write-failure/repo/scripts/deploy-transaction.mjs" <<'MOCK_TRANSACTION'
#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (process.env.MOCK_FAIL_ROLLBACK_JOURNAL === 'true' && args[0] === 'update' &&
    ['quiescent', 'rolling-back'].includes(args[3])) {
  process.stderr.write(`mock transaction phase write failure: ${args[3]}\\n`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [path.join(directory, 'deploy-transaction.real.mjs'), ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
MOCK_TRANSACTION
chmod +x "$test_root/rollback-journal-write-failure/repo/scripts/deploy-transaction.mjs"
git -C "$test_root/rollback-journal-write-failure/repo" add scripts/deploy-transaction.mjs scripts/deploy-transaction.real.mjs
git -C "$test_root/rollback-journal-write-failure/repo" commit -qm 'mock failure of durable rollback phase updates'
if journal_failure_output=$(run_deploy "$test_root/rollback-journal-write-failure" MOCK_FAIL_ROLLBACK_JOURNAL=true 2>&1); then
  fail 'deployment hid rollback phase journal failure'
fi
assert_contains "$journal_failure_output" 'rollback journal update failed'
assert_contains "$journal_failure_output" 'restarted unchanged previous runtime without a journal update'
assert_contains "$journal_failure_output" 'unresolved transaction marker retained'
assert_previous_runtime_intact "$test_root/rollback-journal-write-failure/home/opencode-client-runtime"
[[ "$(<"$test_root/rollback-journal-write-failure/active")" == active ]] || fail 'journal failure did not restart the unchanged old runtime'
[[ -f "$test_root/rollback-journal-write-failure/home/.opencode-client-deploy.transaction.json" ]] || fail 'journal failure did not retain unresolved marker'
[[ "$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).phase)' "$test_root/rollback-journal-write-failure/home/.opencode-client-deploy.transaction.json")" == stop-requested ]] || fail 'journal failure advanced marker without a durable write'
[[ -z "$(find "$test_root/rollback-journal-write-failure/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)" ]] || fail 'journal failure moved the old runtime without recording phase'
assert_stage_cleaned "$test_root/rollback-journal-write-failure"

# An old runtime is only eligible for restart/rollback if the exact trusted
# launcher, current ENV_FILE digest, and executable Next CLI all validate.
for old_runtime_case in missing-launcher missing-next-cli env-digest-mismatch unexpected-top-level; do
  make_fixture "$old_runtime_case"
  runtime="$test_root/$old_runtime_case/home/opencode-client-runtime"
  case "$old_runtime_case" in
    missing-launcher) rm "$runtime/scripts/runtime-env.mjs" ;;
    missing-next-cli) rm "$runtime/node_modules/next/dist/bin/next" ;;
    env-digest-mismatch) printf '%064d\n' 0 >"$runtime/.runtime-env.sha256" ;;
    unexpected-top-level) printf 'do not delete unrelated user data\n' >"$runtime/operator-notes.txt" ;;
  esac
  if old_runtime_output=$(run_deploy "$test_root/$old_runtime_case" 2>&1); then
    fail "$old_runtime_case previous runtime unexpectedly passed restartability preflight"
  fi
  assert_contains "$old_runtime_output" 'previous runtime is not safely owned, structurally restartable, or compatible with the current ENV_FILE; service was not stopped'
  [[ "$(<"$test_root/$old_runtime_case/active")" == active ]] || fail "$old_runtime_case preflight changed service state"
  ! grep -q '^systemctl --user stop\|^systemctl --user start' "$test_root/$old_runtime_case/commands.log" || fail "$old_runtime_case preflight invoked systemctl lifecycle operation"
  [[ ! -e "$test_root/$old_runtime_case/home/.opencode-client-deploy.transaction.json" ]] || fail "$old_runtime_case created a transaction marker before old runtime validation"
  assert_stage_cleaned "$test_root/$old_runtime_case"
  assert_lock_released "$test_root/$old_runtime_case"
done

make_fixture env-file-node-env
printf 'NODE_ENV=development\n' >>"$test_root/env-file-node-env/repo/.env.production.local"
if env_node_output=$(run_deploy "$test_root/env-file-node-env" 2>&1); then
  fail 'ENV_FILE NODE_ENV override was accepted'
fi
assert_contains "$env_node_output" 'deployment-controlled variable NODE_ENV'
[[ "$(<"$test_root/env-file-node-env/home/opencode-client-runtime/app/version.txt")" == previous-source ]] || fail 'ENV_FILE NODE_ENV check changed active runtime'
[[ "$(<"$test_root/env-file-node-env/active")" == active ]] || fail 'ENV_FILE NODE_ENV check changed service state'

make_fixture tracked-dotenv
printf 'INJECTED_FROM_DOTENV=unexpected\n' >"$test_root/tracked-dotenv/repo/.env.production"
# Add a selected-revision dotenv file to Git so archive staging must reject it.
git -C "$test_root/tracked-dotenv/repo" add .env.production
git -C "$test_root/tracked-dotenv/repo" commit -qm 'forbidden app dotenv'
if dotenv_output=$(run_deploy "$test_root/tracked-dotenv" 2>&1); then
  fail 'selected source with a Next dotenv file passed staging validation'
fi
assert_contains "$dotenv_output" 'runtime stage contains Next.js dotenv file .env.production'
assert_previous_runtime_intact "$test_root/tracked-dotenv/home/opencode-client-runtime"
[[ "$(<"$test_root/tracked-dotenv/active")" == active ]] || fail 'dotenv source rejection stopped service'
assert_stage_cleaned "$test_root/tracked-dotenv"

make_fixture install-generated-dotenv
touch "$test_root/install-generated-dotenv/home/mock-install-dotenv"
if install_dotenv_output=$(run_deploy "$test_root/install-generated-dotenv" 2>&1); then
  fail 'install hook generated a Next dotenv file without rejection'
fi
assert_contains "$install_dotenv_output" 'runtime stage contains Next.js dotenv file .env.production'
assert_previous_runtime_intact "$test_root/install-generated-dotenv/home/opencode-client-runtime"
[[ "$(<"$test_root/install-generated-dotenv/active")" == active ]] || fail 'install-generated dotenv rejection stopped service'
assert_stage_cleaned "$test_root/install-generated-dotenv"

make_fixture build-generated-dotenv
touch "$test_root/build-generated-dotenv/home/mock-build-dotenv"
if build_dotenv_output=$(run_deploy "$test_root/build-generated-dotenv" 2>&1); then
  fail 'build hook generated a Next dotenv file without rejection'
fi
assert_contains "$build_dotenv_output" 'runtime stage contains Next.js dotenv file .env.production.local'
assert_previous_runtime_intact "$test_root/build-generated-dotenv/home/opencode-client-runtime"
[[ "$(<"$test_root/build-generated-dotenv/active")" == active ]] || fail 'build-generated dotenv rejection stopped service'
assert_stage_cleaned "$test_root/build-generated-dotenv"

# Build failure and environment changes during build both preserve the existing
# active runtime and service; all staged secret material is cleaned afterward.
make_fixture build-failure
touch "$test_root/build-failure/home/mock-build-fail"
if build_output=$(run_deploy "$test_root/build-failure" 2>&1); then
  fail 'deployment unexpectedly passed a failed build'
fi
assert_contains "$build_output" 'mock build failure'
assert_previous_runtime_intact "$test_root/build-failure/home/opencode-client-runtime"
[[ "$(<"$test_root/build-failure/active")" == active ]] || fail 'build failure stopped the service'
assert_stage_cleaned "$test_root/build-failure"
assert_no_git_worktree "$test_root/build-failure"
assert_lock_released "$test_root/build-failure"

make_fixture env-change-build
touch "$test_root/env-change-build/home/mock-change-env-during-build"
if env_build_output=$(run_deploy "$test_root/env-change-build" 2>&1); then
  fail 'environment file change during build was accepted'
fi
assert_contains "$env_build_output" 'ENV_FILE changed during build'
assert_previous_runtime_intact "$test_root/env-change-build/home/opencode-client-runtime"
[[ "$(<"$test_root/env-change-build/active")" == active ]] || fail 'environment mismatch stopped service'
assert_stage_cleaned "$test_root/env-change-build"
assert_no_git_worktree "$test_root/env-change-build"
assert_lock_released "$test_root/env-change-build"

# A stop failure is not ignored: with an active service, including Restart=always
# risk, promotion aborts before touching the active runtime.
make_fixture stop-failure
if stop_output=$(run_deploy "$test_root/stop-failure" MOCK_STOP_FAIL=true 2>&1); then
  fail 'deployment unexpectedly passed a failed service stop'
fi
assert_contains "$stop_output" 'could not establish service quiescence'
assert_contains "$stop_output" 'attempting previous-runtime recovery'
assert_previous_runtime_intact "$test_root/stop-failure/home/opencode-client-runtime"
[[ "$(<"$test_root/stop-failure/active")" == active ]] || fail 'stop-failure service state was misreported'
assert_stage_cleaned "$test_root/stop-failure"
assert_no_git_worktree "$test_root/stop-failure"
assert_lock_released "$test_root/stop-failure"

# A bounded systemd stop can time out and leave the unit failed after SIGKILL.
# Before promotion, the runtime is still untouched; restart and health-check it.
make_fixture stop-timeout-failed
if timeout_output=$(run_deploy "$test_root/stop-timeout-failed" MOCK_STOP_TIMEOUT_FAILED=true 2>&1); then
  fail 'deployment unexpectedly passed a timed-out service stop'
fi
assert_contains "$timeout_output" 'service processes and pending jobs are quiescent but systemctl stop returned status 1'
assert_contains "$timeout_output" 'previous runtime is healthy; service availability restored'
assert_previous_runtime_intact "$test_root/stop-timeout-failed/home/opencode-client-runtime"
[[ "$(<"$test_root/stop-timeout-failed/active")" == active ]] || fail 'stop-timeout recovery did not restore service availability'
assert_stage_cleaned "$test_root/stop-timeout-failed"
assert_no_git_worktree "$test_root/stop-timeout-failed"
[[ -z "$(find "$test_root/stop-timeout-failed/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)" ]] || fail 'pre-promotion timeout left a transaction backup'
assert_lock_released "$test_root/stop-timeout-failed"

# A post-promotion timeout is safe to roll back only after failed-state cgroup
# and pending-job checks prove the service is quiescent.
make_fixture post-timeout-quiescent
if post_timeout_output=$(run_deploy "$test_root/post-timeout-quiescent" MOCK_HEALTH_FAIL_NEW=true MOCK_STOP_TIMEOUT_FAILED_AFTER_START=true 2>&1); then
  fail 'post-promotion timeout unexpectedly passed a failed health check'
fi
assert_contains "$post_timeout_output" 'systemctl stop returned status 1, but no pending job or cgroup process remains'
assert_contains "$post_timeout_output" 'previous runtime is healthy; service availability restored'
assert_previous_runtime_intact "$test_root/post-timeout-quiescent/home/opencode-client-runtime"
[[ "$(<"$test_root/post-timeout-quiescent/active")" == active ]] || fail 'quiescent post-promotion timeout did not restore the old service'
[[ ! -e "$test_root/post-timeout-quiescent/home/.opencode-client-deploy.transaction.json" ]] || fail 'completed quiescent rollback retained its marker'
assert_no_previous_release_copy "$test_root/post-timeout-quiescent"

# A failed unit is not enough: if its cgroup still has processes, preserve both
# runtimes and the exact transaction marker; a retry must refuse to guess.
make_fixture post-timeout-process-remains
if post_timeout_process_output=$(run_deploy "$test_root/post-timeout-process-remains" MOCK_HEALTH_FAIL_NEW=true MOCK_STOP_TIMEOUT_FAILED_AFTER_START=true MOCK_CGROUP_PROCESSES_AFTER_START=true 2>&1); then
  fail 'post-promotion timeout with a live cgroup process unexpectedly succeeded'
fi
assert_contains "$post_timeout_process_output" 'cgroup process remains'
assert_contains "$post_timeout_process_output" 'unresolved transaction marker retained'
backup_path=$(find "$test_root/post-timeout-process-remains/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)
[[ -n "$backup_path" && "$(<"$backup_path/app/version.txt")" == previous-source ]] || fail 'live-process rollback deleted or lost the old runtime'
[[ "$(<"$test_root/post-timeout-process-remains/home/opencode-client-runtime/app/version.txt")" == current-source ]] || fail 'live-process rollback removed the runtime that may still be serving'
marker_before=$(cat "$test_root/post-timeout-process-remains/home/.opencode-client-deploy.transaction.json")
pnpm_count_before=$(grep -c '^pnpm ' "$test_root/post-timeout-process-remains/commands.log" || true)
if stale_output=$(run_deploy "$test_root/post-timeout-process-remains" 2>&1); then
  fail 'retry unexpectedly proceeded with an unresolved transaction marker'
fi
assert_contains "$stale_output" 'unresolved deployment transaction blocks retry'
[[ "$(cat "$test_root/post-timeout-process-remains/home/.opencode-client-deploy.transaction.json")" == "$marker_before" ]] || fail 'retry altered the unresolved transaction identity'
pnpm_count_after=$(grep -c '^pnpm ' "$test_root/post-timeout-process-remains/commands.log" || true)
[[ "$pnpm_count_after" == "$pnpm_count_before" ]] || fail 'stale-marker retry started a new build'

# Promotion failure restores the exact prior runtime, including its recorded
# revision, then restarts and health-checks it before releasing the transaction.
make_fixture promotion-failure
if promotion_output=$(run_deploy "$test_root/promotion-failure" MOCK_FAIL_RUNTIME_PROMOTION=true 2>&1); then
  fail 'deployment unexpectedly passed a failed runtime promotion'
fi
assert_contains "$promotion_output" 'could not promote staged runtime'
assert_contains "$promotion_output" 'restored previous runtime revision'
[[ "$(<"$test_root/promotion-failure/active")" == active ]] || fail 'failed promotion did not restore service availability'
assert_previous_runtime_intact "$test_root/promotion-failure/home/opencode-client-runtime"
assert_stage_cleaned "$test_root/promotion-failure"
assert_no_git_worktree "$test_root/promotion-failure"
assert_no_previous_release_copy "$test_root/promotion-failure"
assert_lock_released "$test_root/promotion-failure"

# Start and health failures roll back to the prior runtime and verify the old
# service before reporting deployment failure.
make_fixture start-failure
if start_output=$(run_deploy "$test_root/start-failure" MOCK_START_FAIL=true 2>&1); then
  fail 'deployment unexpectedly passed a failed service start'
fi
assert_contains "$start_output" 'could not start the new runtime; transactional rollback'
assert_contains "$start_output" 'previous runtime is healthy; service availability restored'
[[ "$(<"$test_root/start-failure/active")" == active ]] || fail 'start failure did not restore service availability'
assert_previous_runtime_intact "$test_root/start-failure/home/opencode-client-runtime"
assert_stage_cleaned "$test_root/start-failure"
assert_no_git_worktree "$test_root/start-failure"
assert_no_previous_release_copy "$test_root/start-failure"
assert_lock_released "$test_root/start-failure"

make_fixture rollback-start-failure
if rollback_start_output=$(run_deploy "$test_root/rollback-start-failure" MOCK_START_FAIL=true MOCK_START_FAIL_OLD=true 2>&1); then
  fail 'rollback start failure was hidden as a successful deployment'
fi
assert_contains "$rollback_start_output" 'previous runtime restored, but systemd could not start it'
assert_previous_runtime_intact "$test_root/rollback-start-failure/home/opencode-client-runtime"
[[ "$(<"$test_root/rollback-start-failure/active")" == failed ]] || fail 'rollback start failure misreported systemd state'
[[ -f "$test_root/rollback-start-failure/home/.opencode-client-deploy.transaction.json" ]] || fail 'failed rollback start lost its durable marker'
[[ -z "$(find "$test_root/rollback-start-failure/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)" ]] || fail 'rollback start failure left a second copy instead of restoring the exact runtime path'

make_fixture backup-invalid-before-delete
if invalid_backup_output=$(run_deploy "$test_root/backup-invalid-before-delete" MOCK_HEALTH_FAIL_NEW=true MOCK_CORRUPT_BACKUP_AFTER_PROMOTION=true 2>&1); then
  fail 'rollback deleted promoted runtime despite an invalid prior-runtime backup'
fi
assert_contains "$invalid_backup_output" 'exact backup differs from its inventory or is not restartable; preserving both runtimes'
[[ "$(<"$test_root/backup-invalid-before-delete/home/opencode-client-runtime/app/version.txt")" == current-source ]] || fail 'rollback deleted the new runtime before verifying exact backup restoration prerequisites'
backup_path=$(find "$test_root/backup-invalid-before-delete/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)
[[ -n "$backup_path" && -f "$backup_path/.runtime-env.sha256" ]] || fail 'invalid old backup was not preserved for inspection'
[[ -f "$test_root/backup-invalid-before-delete/home/.opencode-client-deploy.transaction.json" ]] || fail 'invalid backup recovery lost transaction marker'

make_fixture rollback-health-failure
if rollback_health_output=$(run_deploy "$test_root/rollback-health-failure" MOCK_HEALTH_FAIL_NEW=true MOCK_HEALTH_FAIL_OLD=true 2>&1); then
  fail 'rollback health failure was hidden as a successful deployment'
fi
assert_contains "$rollback_health_output" 'previous runtime restored and start requested, but health check failed'
assert_previous_runtime_intact "$test_root/rollback-health-failure/home/opencode-client-runtime"
[[ "$(<"$test_root/rollback-health-failure/active")" == active ]] || fail 'rollback health failure misreported active service state'
[[ -f "$test_root/rollback-health-failure/home/.opencode-client-deploy.transaction.json" ]] || fail 'failed rollback health check lost its durable marker'

make_fixture health-failure
if health_output=$(run_deploy "$test_root/health-failure" MOCK_HEALTH_FAIL_NEW=true 2>&1); then
  fail 'deployment unexpectedly passed a failed health check'
fi
assert_contains "$health_output" 'new runtime failed its health check; transactional rollback'
assert_contains "$health_output" 'previous runtime is healthy; service availability restored'
[[ "$(<"$test_root/health-failure/active")" == active ]] || fail 'health failure did not restore service availability'
assert_previous_runtime_intact "$test_root/health-failure/home/opencode-client-runtime"
assert_stage_cleaned "$test_root/health-failure"
assert_no_git_worktree "$test_root/health-failure"
assert_no_previous_release_copy "$test_root/health-failure"
assert_lock_released "$test_root/health-failure"

make_fixture health-stop-failure
if health_stop_output=$(run_deploy "$test_root/health-stop-failure" MOCK_HEALTH_FAIL=true MOCK_STOP_FAIL_AFTER_START=true 2>&1); then
  fail 'health failure with an unsuccessful stop unexpectedly succeeded'
fi
assert_contains "$health_stop_output" 'service quiescence is not confirmed'
assert_contains "$health_stop_output" 'state: active'
[[ "$health_stop_output" != *'confirmed service quiescent'* ]] || fail 'health-stop failure falsely claimed the service was quiescent'
[[ "$(<"$test_root/health-stop-failure/active")" == active ]] || fail 'failed health-stop state was misreported'
backup_path=$(find "$test_root/health-stop-failure/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)
[[ -n "$backup_path" && "$(<"$backup_path/app/version.txt")" == previous-source ]] || fail 'unsafe rollback deleted or lost the previous runtime'
[[ "$(<"$backup_path/.runtime-source-revision")" == "$(<"$test_root/health-stop-failure/old-revision")" ]] || fail 'preserved previous runtime has the wrong provenance'
[[ "$(<"$test_root/health-stop-failure/home/opencode-client-runtime/app/version.txt")" == current-source ]] || fail 'new runtime was unexpectedly replaced while its process may still be serving'
assert_stage_cleaned "$test_root/health-stop-failure"
assert_no_git_worktree "$test_root/health-stop-failure"
assert_lock_released "$test_root/health-stop-failure"

make_fixture health-stop-error-inactive
if stop_error_output=$(run_deploy "$test_root/health-stop-error-inactive" MOCK_HEALTH_FAIL_NEW=true MOCK_STOP_FAIL_INACTIVE_AFTER_START=true 2>&1); then
  fail 'health failure with unsuccessful stop request unexpectedly succeeded'
fi
assert_contains "$stop_error_output" 'systemctl stop returned status 1, but no pending job or cgroup process remains'
assert_contains "$stop_error_output" 'previous runtime is healthy; service availability restored'
[[ "$(<"$test_root/health-stop-error-inactive/active")" == active ]] || fail 'verified quiescent rollback did not restore service availability'
assert_previous_runtime_intact "$test_root/health-stop-error-inactive/home/opencode-client-runtime"
[[ ! -e "$test_root/health-stop-error-inactive/home/.opencode-client-deploy.transaction.json" ]] || fail 'completed safe rollback retained its transaction marker'
assert_stage_cleaned "$test_root/health-stop-error-inactive"
assert_no_git_worktree "$test_root/health-stop-error-inactive"
assert_lock_released "$test_root/health-stop-error-inactive"

make_fixture env-change-before-start
if env_start_output=$(run_deploy "$test_root/env-change-before-start" MOCK_CHANGE_ENV_BEFORE_START=true 2>&1); then
  fail 'environment change after build was silently accepted at service start'
fi
assert_contains "$env_start_output" 'could not start the new runtime'
assert_contains "$env_start_output" 'exact backup differs from its inventory or is not restartable; preserving both runtimes'
[[ "$(<"$test_root/env-change-before-start/active")" == failed ]] || fail 'environment hash failure did not report failed new runtime state'
[[ "$(<"$test_root/env-change-before-start/home/opencode-client-runtime/app/version.txt")" == current-source ]] || fail 'rollback deleted new runtime before verifying old backup against current environment'
backup_path=$(find "$test_root/env-change-before-start/home" -maxdepth 1 -type d -name '.opencode-client-previous.*' -print -quit)
[[ -n "$backup_path" && "$(<"$backup_path/app/version.txt")" == previous-source ]] || fail 'environment mismatch did not preserve prior backup'
[[ -f "$test_root/env-change-before-start/home/.opencode-client-deploy.transaction.json" ]] || fail 'environment mismatch did not retain unresolved marker'
assert_stage_cleaned "$test_root/env-change-before-start"
assert_no_git_worktree "$test_root/env-change-before-start"
assert_lock_released "$test_root/env-change-before-start"

# Wrong health-check port is rejected; an unrelated listener cannot pass.
make_fixture wrong-health-port
if port_output=$(run_deploy "$test_root/wrong-health-port" HEALTHCHECK_URL=http://127.0.0.1:3000/signin 2>&1); then
  fail 'wrong health-check port was accepted'
fi
assert_contains "$port_output" 'HEALTHCHECK_URL must target 127.0.0.1 on SERVICE_PORT (5115)'
[[ "$(<"$test_root/wrong-health-port/home/opencode-client-runtime/app/version.txt")" == previous-source ]] || fail 'invalid health URL changed active runtime'
[[ "$(<"$test_root/wrong-health-port/active")" == active ]] || fail 'invalid health URL changed service state'

make_fixture leading-zero-port
if leading_zero_output=$(run_deploy "$test_root/leading-zero-port" SERVICE_PORT=05115 2>&1); then
  fail 'non-canonical service port was accepted'
fi
assert_contains "$leading_zero_output" 'without leading zeroes'
[[ "$(<"$test_root/leading-zero-port/home/opencode-client-runtime/app/version.txt")" == previous-source ]] || fail 'invalid service port changed active runtime'
[[ "$(<"$test_root/leading-zero-port/active")" == active ]] || fail 'invalid service port changed service state'

# A shared per-account lock serializes two different trusted checkouts that
# target the same account-wide runtime and user service.
make_fixture lock-contention
second_checkout="$test_root/lock-contention/second-checkout"
"$real_git" clone -q "$test_root/lock-contention/repo" "$second_checkout"
cp "$test_root/lock-contention/repo/.env.production.local" "$second_checkout/.env.production.local"
lock_file="$test_root/lock-contention/home/.opencode-client-deploy.lock"
if lock_output=$(
  exec 8>"$lock_file"
  "$real_flock" -n 8
  cd "$second_checkout"
  env \
    HOME="$test_root/lock-contention/home" \
    PATH="$test_root/lock-contention/bin:$PATH" \
    MOCK_REAL_GIT="$real_git" \
    MOCK_HOME="$test_root/lock-contention/home" \
    MOCK_STATE="$test_root/lock-contention/active" \
    MOCK_LOG="$test_root/lock-contention/commands.log" \
    MOCK_STARTED_MARKER="$test_root/lock-contention/started" \
    MOCK_OLD_RUNNER_SENTINEL="$test_root/lock-contention/old-runner-invoked" \
    MOCK_PROJECT_ROOT="$second_checkout" \
    MOCK_RUNTIME_DIR="$test_root/lock-contention/home/opencode-client-runtime" \
    MOCK_ENV_FILE="$second_checkout/.env.production.local" \
    ENV_FILE="$second_checkout/.env.production.local" \
    HEALTH_TIMEOUT_SECONDS=1 \
    ./scripts/deploy.sh 2>&1
); then
  fail 'second checkout unexpectedly passed account-wide lock contention'
fi
assert_contains "$lock_output" 'another deployment using this runtime and service account is already in progress'
[[ "$(<"$test_root/lock-contention/active")" == active ]] || fail 'cross-checkout lock contention changed service state'
assert_stage_cleaned "$test_root/lock-contention"
assert_no_git_worktree "$test_root/lock-contention"
assert_lock_released "$test_root/lock-contention"

# If temporary staging cleanup itself fails, report and preserve the path so an
# operator can remove it; never report successful cleanup falsely.
make_fixture stage-cleanup-failure
touch "$test_root/stage-cleanup-failure/home/mock-build-fail"
if cleanup_output=$(run_deploy "$test_root/stage-cleanup-failure" MOCK_FAIL_STAGE_CLEANUP=true 2>&1); then
  fail 'deployment unexpectedly hid staged-runtime cleanup failure'
fi
stage_to_fail=$(find "$test_root/stage-cleanup-failure/home" -maxdepth 1 -type d -name '.opencode-client-stage.*' -print -quit)
assert_contains "$cleanup_output" 'mock build failure'
assert_contains "$cleanup_output" 'staged runtime was preserved because safe recursive cleanup could not be proven'
assert_contains "$cleanup_output" 'deployment failed and staging cleanup was incomplete'
[[ -d "$stage_to_fail" && -f "$stage_to_fail/package.json" && ! -e "$stage_to_fail/.env.production.local" ]] || fail 'failed staging retained the wrong environment artifacts'
[[ "$(<"$test_root/stage-cleanup-failure/home/opencode-client-runtime/app/version.txt")" == previous-source ]] || fail 'staging cleanup failure changed active runtime'
[[ "$(<"$test_root/stage-cleanup-failure/active")" == active ]] || fail 'staging cleanup failure changed service state'
/bin/rm -rf -- "$stage_to_fail"
assert_no_git_worktree "$test_root/stage-cleanup-failure"
assert_lock_released "$test_root/stage-cleanup-failure"

printf 'deploy tests passed (coherent runtime, source recovery, unit/env preflight, failures, port, locking, and staging cleanup)\n'
