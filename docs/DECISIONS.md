# Architecture decisions

## 001. Cloudflare-native orchestration (2026-11-12)

Use Cloudflare Workers, D1, R2 and Workflows. No permanently running server, n8n, Redis or
PostgreSQL in the first version. **Why:** it removes the paid backend and fits the free tier.

## 002. Browser-based rendering for the MVP (2026-11-12)

The browser assembles the video with FFmpeg.wasm; the Worker only orchestrates. **Why:** cloud
rendering needs paid compute, and Workers have a small CPU budget per request.

## 003. One Worker serves the API and the frontend (2026-11-12)

Static assets are bound to the API Worker, with `run_worker_first` for `/api/*`. **Why:** one
deployment, one origin, no CORS.

## 004. Shared packages consumed as TypeScript source (2026-11-12)

`@avs/*` packages export `src/index.ts` directly; Vite and Wrangler bundle them. **Why:** no build
step or stale output during early development. Revisit if a package is ever published.

## 005. No router framework yet (2026-11-12)

The Worker routes with plain `fetch` handling. **Why:** one endpoint doesn't justify a dependency.
Revisit in Task 4 when project CRUD arrives.

## 006. TypeScript pinned to 5.x (2026-11-12)

**Why:** typescript-eslint 8 refuses to run on TypeScript 7. Unpin when it supports it.

## 007. Worker tests run in workerd (revised 2026-11-12)

Originally the Worker was tested in Node. Since Task 2 its tests run under
`@cloudflare/vitest-plugin` inside workerd, with real local D1, R2 and Workflows from
`wrangler.jsonc`. **Why:** the Worker imports `cloudflare:workers`, which Node can't load, and
binding behaviour should be tested against the real runtime. (`vitest-pool-workers` is deprecated and
requires Vitest 4.)

## 008. Placeholder D1 ID, guarded at deploy (2026-11-12)

`wrangler.jsonc` ships with `database_id: "REPLACE_WITH_DATABASE_ID"`. **Why:** resource IDs must not
be invented, and local development doesn't need one. `scripts/validate-env.sh` blocks deploys until
it is replaced.

## 009. Health reports bindings, always 200 (2026-11-12)

`/api/v1/health` probes D1 (`SELECT 1`), R2 (`head`) and checks the Workflow binding, reporting each
as `ok`, `missing` or `error`, and an overall `ok` or `degraded`. **Why:** a 200 with a degraded body
keeps the app shell usable while making misconfiguration visible.

## 010. Production workflow is a stub until Task 7 (2026-11-12)

`ProductionWorkflow` validates its input and returns `status: "not_implemented"`. **Why:** the
binding and class must exist to be configured and tested now; the real steps arrive in Task 7, and
the stub says so instead of pretending to produce video.

## 011. Schema follows the blueprint, with stricter constraints (2026-11-12)

The nine tables match the blueprint. Additions: CHECK constraints on every status, enum and JSON
column; a `max_retries` column on `jobs` (CLAUDE.md rule 8: every job has a retry policy); ISO-8601
millisecond timestamps instead of `CURRENT_TIMESTAMP` (consistent with application-written times);
`ON DELETE CASCADE` from users to projects; two extra indexes (usage by provider, quality by project).
**Why:** the database should reject states the application never intends to write.

## 012. Ownership enforced in SQL, not in a separate check (2026-11-12)

Project-scoped repository functions filter by `userId` in the same statement that reads or writes.
**Why:** no time-of-check/time-of-use gap, and forgetting a check fails closed (returns nothing)
instead of leaking another user's data. A test that disables the filter makes six tests fail.
