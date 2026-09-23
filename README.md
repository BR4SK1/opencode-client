# opencode-client

Mobile-first chat client for [OpenCode](https://opencode.ai). Chat with your
OpenCode sessions from a phone and approve (or deny) permission prompts from
anywhere.

Stack: Next.js (App Router) · React 19 · TypeScript (strict) · Material UI ·
NextAuth v5 (generic OIDC) · `@opencode/client` (server-side only).

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable             | Description |
| -------------------- | ----------- |
| `AUTH_SECRET`        | NextAuth secret. Generate with `openssl rand -base64 32`. |
| `AUTH_OIDC_ISSUER`   | OIDC issuer URL for the NextAuth generic provider. |
| `AUTH_OIDC_ID`       | OIDC client ID. |
| `AUTH_OIDC_SECRET`   | OIDC client secret. |
| `OPENCODE_BASE_URL`  | URL of the OpenCode server (default `http://localhost:4096`). |
| `OPENCODE_TOKEN`     | Optional. Sent **verbatim** as the `Authorization` header value, e.g. `Basic $(printf 'opencode:PASSWORD' \| base64)` or `Bearer TOKEN`. |

## Commands

```
pnpm install
pnpm dev
pnpm build
pnpm lint
```

## Notes

- Requires a reachable OpenCode server (`OPENCODE_BASE_URL`).
- Sign-in requires an OIDC issuer configured via `AUTH_OIDC_*`; without it the
  sign-in page reports that sign-in is not configured.
- `@opencode/client` and the `OPENCODE_TOKEN` are used server-side only
  (`lib/opencode.ts`); the browser talks to Next.js API routes.