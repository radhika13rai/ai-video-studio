#!/usr/bin/env bash
# First-time setup: install dependencies, build the frontend once, run every check.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v pnpm >/dev/null || { echo "pnpm is required: https://pnpm.io/installation" >&2; exit 1; }
pnpm install
pnpm check
echo "Ready. Run: pnpm dev"
