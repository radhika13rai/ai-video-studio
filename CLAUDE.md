# AI Video Studio — Development Constitution

## Product Goal

Build a universal, autonomous AI video production platform.

## Architecture

- React + Vite + TypeScript frontend.
- Cloudflare Workers backend.
- Cloudflare D1 database.
- Cloudflare R2 media storage.
- Cloudflare Workflows orchestration.
- Browser-based rendering for the zero-budget MVP.
- Provider adapters for all external AI services.

## Non-negotiable Rules

1. Never introduce paid infrastructure without approval.
2. Never assume a provider has a free API.
3. Never hardcode provider credentials.
4. Never expose secrets to the frontend.
5. Never put media binaries in D1.
6. Never execute long-running rendering inside Workers.
7. Every agent must have typed input and output.
8. Every job must have a defined status and retry policy.
9. Every project query must enforce ownership.
10. All AI provider integrations must be replaceable.
11. All external API responses must be validated.
12. All database changes must use migrations.
13. Every feature must include tests.
14. Do not claim a feature works until it has been tested.
15. Prefer deterministic services over unnecessary AI agents.

## Development Process

Before implementing any feature:

1. Inspect existing architecture.
2. Read relevant documentation.
3. Identify dependencies.
4. Define interfaces.
5. Implement the smallest working version.
6. Run tests and type checks.
7. Report files changed and remaining limitations.

## Zero-Budget Requirements

- Cloudflare Free tier first.
- Browser-based video rendering.
- Workers AI within available free quotas.
- No paid GPU services by default.
- Paid integrations disabled unless explicitly enabled.
- Graceful fallback when free quotas are exhausted.

## Quality Standard

Production code must be:

- Typed
- Modular
- Testable
- Secure
- Observable
- Documented

## Working in this repository

- Package manager: pnpm workspaces. Packages are `@avs/studio`, `@avs/api`, `@avs/contracts`,
  `@avs/schemas` and `@avs/types`.
- Run `pnpm check` before every commit. It runs typecheck, lint, format check, tests and the build.
- Shared packages are consumed as TypeScript source; there is no build step for them.
- TypeScript is pinned to 5.x because typescript-eslint does not support TypeScript 7 yet.
- Work through the tasks in `README.md` in order. Do not start a task until the previous one is verified.
