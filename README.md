# opencode-client

A mobile-first web client for chatting with an [OpenCode](https://opencode.ai) server. It supports session browsing, session-specific agent switching, live message streaming, permission prompts, and interactive agent forms.

Built with Next.js App Router, React, TypeScript, Material UI, NextAuth v5 with generic OIDC, and the server-side `@opencode/client` package.

## Requirements

- Node.js 20.9 or newer
- pnpm 10.18.1 (the version pinned in `package.json`)
- An OpenCode server reachable from the application server, with the
  `fleet-web-prompt-context` skill installed before deploying this client version
- An OIDC provider for sign-in

## Local development

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Set the variables in `.env.local`, then start the development server:

```sh
pnpm dev
```

| Variable | Description |
| --- | --- |
| `AUTH_SECRET` | NextAuth signing secret. Generate one with `openssl rand -base64 32`. |
| `AUTH_OIDC_ISSUER` | OIDC issuer URL. |
| `AUTH_OIDC_ID` | OIDC client ID. |
| `AUTH_OIDC_SECRET` | OIDC client secret. |
| `AUTH_ALLOWED_EMAILS` | Comma-separated allowlist of exact email addresses allowed to sign in. Required for OIDC access; matching is case-insensitive. |
| `OPENCODE_BASE_URL` | OpenCode server URL; defaults to `http://localhost:4096`. |
| `OPENCODE_TOKEN` | Optional authorization header value sent to OpenCode, such as `Bearer TOKEN` or a `Basic ...` value. |
| `AUTH_DEMO` | Set to `true` for the local demo sign-in only when OIDC is not configured. It is disabled in production. |

The OpenCode client and token are used by server-side code only. Keep real secrets in environment files or a secret manager; never commit them.

## Access control

The application accepts only identities whose verified OIDC email is in `AUTH_ALLOWED_EMAILS`. The allowlist is checked at sign-in and whenever an existing JWT session is read, so removing an address revokes subsequent access. Configure Keycloak MFA and limit OIDC client access as additional controls. Every allowed identity can use the same configured OpenCode server and credentials, including sending prompts and replying to permission requests. Do not expose the app publicly without appropriate identity-provider restrictions.

## Progressive Web App (PWA)

The app is installable. On iOS/iPadOS use Safari's Share → "Add to Home Screen"; on Android and desktop Chromium browsers use the browser's "Install app" entry. Installation and service worker registration require a secure context, so the app must be served over HTTPS (`localhost` also works for development); the self-hosted deployment below already places the app behind an HTTPS reverse proxy. An installed app gets its own icon and a standalone window without browser chrome. An installed app also keeps its own storage, separate from the browser: iOS Home Screen web apps do not share cookies or site data with Safari, so you will usually need to sign in again inside the installed app.

- Icons are generated from a single design with `node scripts/generate-icons.mjs` (Node builtins only, no image tooling). It writes `app/icon.png` (favicon), `app/apple-icon.png` (iOS home-screen icon), and the manifest icons under `public/icons/`.
- Offline behavior is intentionally minimal: the service worker (`public/sw.js`) serves a static, user-agnostic "You're offline" page (`public/offline.html`) only when a non-API top-level navigation cannot reach the server, and its storage never contains anything except that page. It does not cache conversations, API responses, session data, or user-specific pages; the browser's ordinary HTTP cache and other site storage are separate mechanisms outside the worker. Chatting requires a live connection to the OpenCode server either way.
- The service worker registers in production builds only, so `pnpm dev` is unaffected.
- PWA static assets (manifest, icons, service worker, offline page) are excluded from the auth proxy matcher in `proxy.ts` because they carry no user data and must stay reachable while signed out.

## Checks

```sh
pnpm check   # Full lint, typecheck, and production build used before commits
pnpm test    # Full Vitest suite used before pushes
```

Git hooks are installed automatically by `pnpm install` through Husky. The
pre-commit hook runs the complete `pnpm check` command regardless of changed
paths; the pre-push hook runs the complete `pnpm test` suite. These hooks check
and test only—deployments are never triggered by a hook. To install or repair
the hooks in an existing checkout, run `pnpm install`. The check command uses
only dummy, non-secret authentication values for the production build and never contacts
the configured OpenCode or OIDC services. GitHub Actions are not used.

## Self-hosted production deployment

The included deployment runner targets a Linux host with a **systemd user service** configured from `deploy/opencode-client.service`. The trusted Git checkout and its `.env.production.local` remain separate from the active runtime directory. A shared runtime-environment loader parses the external configuration for both build and service processes, ignoring inherited systemd-manager environment values; the service listens on loopback behind an HTTPS reverse proxy. Keep proxy response buffering disabled for the `/api/events` Server-Sent Events route.

### Initial setup

1. Clone the repository to the account that will run the service. Ensure the pinned pnpm version is available; deployment installs dependencies in its temporary runtime stage, not in this trusted checkout:

   ```sh
   git clone https://github.com/BR4SK1/opencode-client.git "$HOME/opencode-client"
   cd "$HOME/opencode-client"
   ```

2. Create the production environment file, fill in the required OIDC and OpenCode values, and restrict its permissions:

   ```sh
   cp .env.example .env.production.local
   chmod 600 .env.production.local
   $EDITOR .env.production.local
   ```

3. Install `deploy/opencode-client.service` as `~/.config/systemd/user/opencode-client.service`. The default absolute configuration path is `$HOME/opencode-client/.env.production.local`; if it differs, change both environment-file path arguments in the unit's `ExecStartPre` and `ExecStart` to the same absolute path, and pass that path as `ENV_FILE`. The unit passes it to the shared runtime loader and does not use systemd `EnvironmentFile` parsing.

   ```sh
   mkdir -p "$HOME/.config/systemd/user"
   cp deploy/opencode-client.service "$HOME/.config/systemd/user/opencode-client.service"
   systemctl --user daemon-reload
   ```

4. Enable the service without starting it, then let the trusted deployment runner build and install the first runtime:

   ```sh
   systemctl --user enable opencode-client.service
   SERVICE_PORT=5115 \
   HEALTHCHECK_URL=http://127.0.0.1:5115/signin \
   ./scripts/deploy.sh
   ```

   Configure the reverse proxy to forward HTTPS traffic to `http://127.0.0.1:5115`.

### Migrating an existing checkout-based service

The deployment runner refuses to build or promote until systemd has loaded the runtime-based unit: it queries typed D-Bus properties for the loaded unit and verifies the exact executable/argument vectors, `ignore_errors=no`, `Type=simple`, `Restart=on-failure`, `KillMode=control-group`, empty auxiliary lifecycle commands, working directory, absence of systemd `Environment`/`EnvironmentFiles` overrides, and `UnsetEnvironment=NODE_OPTIONS`. For a future maintenance migration, install the template above with the intended absolute `ENV_FILE` path and run `systemctl --user daemon-reload`. This does not move or restart the currently running checkout-based process. Then run the current trusted deployment runner with `SOURCE_REVISION` set to the chosen application commit; it will build staging first, stop the old process, install the single runtime directory, and start the service under the new unit. Do not check out the old application commit to obtain its deployment script. This repository change does not install the unit, reload systemd, or migrate the live service.

The runner does not remove the former checkout's `.next` or `node_modules`. After a separately authorized migration and only after verifying that the loaded unit and running processes no longer reference the checkout, inspect those paths and their ownership (for example with `systemctl --user show`, `ps`, `stat`, and `git status`) before deciding what to do. `.next` may be obsolete service output, but remove it only after confirming it is owned by the service account and not in use. Do not automatically or blanket-delete `node_modules`: it may be a developer dependency installation. Preserve it unless a separately authorized, ownership-checked cleanup establishes that it is deployment-only and unused.

### Subsequent deployments

Deployments are manual only. Keep this trusted deployment checkout on the current deployment branch, with a clean Git worktree, and select application source independently with `SOURCE_REVISION` (defaults to this checkout's `HEAD`). The trusted runner archives that Git revision into a temporary staging directory, installs dependencies and builds there, then promotes the complete runtime tree—including source/configuration, `public`, `.next`, and `node_modules`—to the single active path `$HOME/opencode-client-runtime`. It does not create a Git worktree or execute the selected revision's `scripts/deploy.sh`; recovery can therefore rebuild older application source without running an obsolete runner.

The production environment file stays outside the active runtime and is never copied into staging. The trusted runner and runtime share `scripts/runtime-env.mjs`: it parses the file under a documented, line-based contract, then supplies those exact values to the Next.js build and service child process. The Next.js build and service child receive a clean environment containing only the parsed application values plus controlled `HOME`, `PATH`, and `NODE_ENV=production`; inherited shell or systemd-manager variables cannot override the application configuration. Dependency installation and lint tools use the same controlled base without application secrets. The unit also removes inherited `NODE_OPTIONS` before Node.js itself starts. The runtime retains only the SHA-256 digest, and `ExecStartPre` plus the start wrapper verify the external file against it before running. A changed environment file therefore requires a rebuild/redeploy before service startup; values themselves are never printed or stored in the runtime.

The environment contract accepts UTF-8 assignments of the form `KEY=value`, blank lines, and whole-line comments beginning with `#` or `;`. Keys are unique and use shell-style identifier characters. Values may be unquoted (trimmed at the ends) or surrounded by one matching pair of single or double quotes. Spaces within values, `#`, `$`, and `=` are literal; quoting does not enable escaping. There is no variable expansion, multiline quoting, escaped-quote, or inline-comment syntax. `HOME`, `PATH`, `NODE_ENV`, and `NODE_OPTIONS` are deployment-controlled and may not appear in the file. To keep build-time application values under one source, selected Git revisions containing Next.js dotenv inputs (`.env`, `.env.local`, `.env.production`, or `.env.production.local`) are rejected; `.env.example` is not loaded by Next.js.

Before any build or runtime change, the runner reads structured systemd D-Bus properties and requires the exact command vectors and failure policy from the template, with empty systemd `Environment` and `EnvironmentFiles`. This avoids relying on human-rendered `systemctl show` substrings and prevents an `ignore_errors=yes` pre-start check from passing. A single lock at `$HOME/.opencode-client-deploy.lock` serializes all trusted checkouts targeting this account's runtime and user service. Preflight requires `busctl --json=short` support and fails closed if typed D-Bus properties cannot be read. The current checkout-based unit is rejected; install and `daemon-reload` the provided unit template as an explicit operational migration before deploying. The runner never edits the unit or invokes `daemon-reload`. If the service is active, it stops it and verifies systemd reports it inactive before replacing the runtime. If it is already inactive, recovery can proceed even if the active runtime is absent or incomplete. Promotion removes the old active directory and moves in the completed stage; no prior runtime, snapshot, or release directory is retained. Stop failure aborts before changing runtime files. Promotion/start/health failures do not restore copied files; the runner reports the observed service state and warns if inactivity cannot be confirmed.

This host serves the application on loopback port **5115**. The deployment runner defaults to `SERVICE_PORT=5115` and `HEALTHCHECK_URL=http://127.0.0.1:5115/signin`; it requires the health URL to target `127.0.0.1` at the configured service port, preventing a healthy unrelated listener on another host or port from passing the check. If the service port changes, configure both values consistently.

```sh
cd "$HOME/opencode-client"
SERVICE_NAME=opencode-client.service \
SERVICE_PORT=5115 \
HEALTHCHECK_URL=http://127.0.0.1:5115/signin \
./scripts/deploy.sh
```

`ENV_FILE` defaults to the trusted checkout's absolute `.env.production.local` path and must follow the shared parsing contract above; the systemd unit does not read it as an `EnvironmentFile`. `RUNTIME_DIR` defaults to `$HOME/opencode-client-runtime` and must remain a direct child of the service user's home, separate from the checkout. `SERVICE_NAME`, `SERVICE_PORT`, `HEALTHCHECK_URL`, and `HEALTH_TIMEOUT_SECONDS` can also be overridden, with the loaded unit required to match. Successful deployments print the full deployed Git revision but do not keep an earlier runtime or record deployment history. Record the last known-good revision before replacing a healthy deployment.

To recover after a failed or unwanted deployment, keep the current trusted deployment runner checked out and clean, update it from the deployment branch, then select the known-good **application source** revision with `SOURCE_REVISION`. Do not switch the checkout to the old application revision to run its deploy script:

```sh
cd "$HOME/opencode-client"
git status --short                 # resolve changes before updating the trusted runner
git switch main
git pull --ff-only
SERVICE_NAME=opencode-client.service \
SERVICE_PORT=5115 \
HEALTHCHECK_URL=http://127.0.0.1:5115/signin \
SOURCE_REVISION=<known-good-revision> \
./scripts/deploy.sh
```

The script builds the selected revision and health-checks port 5115; no saved build snapshot or old revision's deploy runner is used. If you do not know which revision was last healthy, consult deployment records or identify one from Git history before proceeding; the script cannot infer it from retained artifacts. `scripts/deploy.sh` requires a clean Git worktree and must run as the systemd service user, not as root.
