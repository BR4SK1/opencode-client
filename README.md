# opencode-client

A mobile-first web client for chatting with an [OpenCode](https://opencode.ai) server. It supports session browsing, session-specific agent switching, live message streaming, permission prompts, and interactive agent forms.

Built with Next.js App Router, React, TypeScript, Material UI, NextAuth v5 with generic OIDC, and the server-side `@opencode/client` package.

## Requirements

- Node.js 20.9 or newer
- pnpm 10.18.1 (the version pinned in `package.json`)
- An OpenCode server reachable from the application server
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

The included scripts target a Linux host with a **systemd user service** already configured to run this checkout. The service should use the same project directory, read `.env.production.local`, listen on loopback, and have a reverse proxy provide HTTPS. Keep proxy response buffering disabled for the `/api/events` Server-Sent Events route.

### Initial setup

1. Clone the repository to the account that will run the service and install dependencies:

   ```sh
   git clone https://github.com/BR4SK1/opencode-client.git "$HOME/opencode-client"
   cd "$HOME/opencode-client"
   pnpm install --frozen-lockfile
   ```

2. Create the production environment file, fill in the required OIDC and OpenCode values, and restrict its permissions:

   ```sh
   cp .env.example .env.production.local
   chmod 600 .env.production.local
   $EDITOR .env.production.local
   ```

3. Create `~/.config/systemd/user/opencode-client.service` (replace the example checkout path if needed):

   ```ini
   [Unit]
   Description=opencode-client
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   WorkingDirectory=%h/opencode-client
   Environment=NODE_ENV=production
   EnvironmentFile=%h/opencode-client/.env.production.local
   ExecStart=/usr/bin/node %h/opencode-client/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000
   Restart=on-failure
   RestartSec=5
   NoNewPrivileges=true
   ProtectSystem=strict
   PrivateTmp=true
   ReadWritePaths=%h/opencode-client/.next

   [Install]
   WantedBy=default.target
   ```

4. Build and start the initial deployment:

   ```sh
   pnpm build
   systemctl --user daemon-reload
   systemctl --user enable --now opencode-client.service
   ```

   Configure the reverse proxy to forward HTTPS traffic to `http://127.0.0.1:3000`.

### Subsequent deployments

Deployments are manual only. After committing and pushing the changes you want
to deploy, explicitly run the common deploy entrypoint from a clean checkout.
It builds and checks the commit in an isolated Git worktree while the current
service remains online, promotes the new dependencies and build, restarts the
service, and verifies the sign-in page. If the new service fails its health
check, the script restores the previous build automatically.

```sh
cd "$HOME/opencode-client"
SERVICE_NAME=opencode-client.service \
HEALTHCHECK_URL=http://127.0.0.1:3000/signin \
./scripts/deploy.sh
```

`ENV_FILE` defaults to `.env.production.local`; `SERVICE_NAME`, `HEALTHCHECK_URL`, and `HEALTH_TIMEOUT_SECONDS` can be overridden for the host. Successful deployments retain the previous `node_modules` and `.next` under `.deploy/rollbacks/`. To restore a retained deployment:

```sh
SERVICE_NAME=opencode-client.service \
HEALTHCHECK_URL=http://127.0.0.1:3000/signin \
./scripts/rollback.sh <rollback-id>
```

The rollback ID is printed after each successful deployment. Both deployment scripts require a clean Git worktree and must run as the systemd service user, not as root.
