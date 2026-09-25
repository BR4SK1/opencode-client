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
| `OPENCODE_BASE_URL` | OpenCode server URL; defaults to `http://localhost:4096`. |
| `OPENCODE_TOKEN` | Optional authorization header value sent to OpenCode, such as `Bearer TOKEN` or a `Basic ...` value. |
| `AUTH_DEMO` | Set to `true` for the local demo sign-in only when OIDC is not configured. It is disabled in production. |

The OpenCode client and token are used by server-side code only. Keep real secrets in environment files or a secret manager; never commit them.

## Access control

Every identity accepted by the configured OIDC provider can use the same configured OpenCode server and credentials, including sending prompts and replying to permission requests. Restrict access to the OIDC client to trusted users or groups. Do not expose the app publicly without appropriate identity-provider restrictions.

## Checks

```sh
pnpm lint
pnpm build
```

The GitHub Actions workflow runs dependency installation, lint, and a production build on pushes and pull requests.

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

Commit and push the changes you want to deploy, then run the script from a clean checkout. It builds and checks the commit in an isolated Git worktree while the current service remains online, promotes the new dependencies and build, restarts the service, and verifies the sign-in page. If the new service fails its health check, the script restores the previous build automatically.

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
