#!/usr/bin/env sh
set -eu

# Use non-secret, deterministic build-only credentials instead of loading host
# production credentials. These values are not used to contact any service.
export AUTH_SECRET=local-quality-check-secret-not-for-authentication
export AUTH_OIDC_ISSUER=https://issuer.example.invalid
export AUTH_OIDC_ID=local-quality-check
export AUTH_OIDC_SECRET=local-quality-check-not-a-secret
export AUTH_ALLOWED_EMAILS=check@example.invalid
export AUTH_DEMO=false
export OPENCODE_BASE_URL=http://127.0.0.1:4096
export OPENCODE_TOKEN=local-quality-check-not-a-secret

pnpm lint
pnpm typecheck
pnpm build
