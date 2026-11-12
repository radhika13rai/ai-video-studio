#!/usr/bin/env bash
# Checks that the Worker is ready to deploy to Cloudflare. Run before `wrangler deploy`.
# Local development needs none of this: `wrangler dev` simulates D1 and R2 on disk.
set -euo pipefail
cd "$(dirname "$0")/.."
cfg=workers/api/wrangler.jsonc
fail=0

if grep -q '"REPLACE_WITH_DATABASE_ID"' "$cfg"; then
  echo "✗ $cfg still has the placeholder D1 database_id."
  echo "  Create the database:  pnpm --filter @avs/api exec wrangler d1 create ai-video-studio"
  echo "  then paste the returned database_id into $cfg."
  fail=1
else
  echo "✓ D1 database_id is set"
fi

if [ ! -f apps/studio/dist/index.html ]; then
  echo "✗ Frontend not built. Run: pnpm build"
  fail=1
else
  echo "✓ Frontend build found"
fi

if [ "${CI:-}" = "true" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "✗ CLOUDFLARE_API_TOKEN is not set (required for deploys from CI)."
  fail=1
fi

exit $fail
