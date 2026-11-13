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

## 008. Placeholder D1 ID, guarded at deploy (2026-11-12; resolved 2026-11-13)

`wrangler.jsonc` ships with `database_id: "REPLACE_WITH_DATABASE_ID"`. **Why:** resource IDs must not
be invented, and local development doesn't need one. `scripts/validate-env.sh` blocks deploys until
it is replaced. Resolved: the real database was created and its ID committed (it isn't a secret).

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

## 013. A small in-house router instead of a framework (2026-11-12)

Resolves ADR 005. `src/lib/router.ts` (about 50 lines) handles `:param` patterns, 404 and 405 with
`Allow`. **Why:** a dozen routes don't need a dependency, and validation, auth and errors are
already explicit functions. Revisit if routes or middleware grow a lot.

## 014. Fail-closed authentication (2026-11-12)

Cloudflare Access JWTs are verified in the Worker with WebCrypto (no JWT library). `APP_ENV`
defaults to `production`, where missing Access settings reject every API call; the developer
identity exists only in `development` and `test`. **Why:** a misconfigured deploy must not become
an open API.

## 015. Idempotency keys stored in D1 (2026-11-12)

`POST /projects` honours `Idempotency-Key` using a reservation row (migration 0002). **Why:** mobile
retries shouldn't create duplicate projects; D1 is already there, so no new service is needed.

## 016. Frontend routing without a library (2026-11-13)

`src/lib/router.tsx` uses the History API: `navigate()`, `usePath()`, `<Link>` and `matchRoute()`
for five routes. **Why:** five static routes don't justify react-router; the Worker already serves
`index.html` for unknown paths. Revisit when routes need nesting or loaders.

## 017. Polling for status updates (2026-11-13)

The list and project pages refetch every 5 seconds only while a project is in an active status
(planning, generating, rendering, quality check). **Why:** the blueprint picks polling for the MVP;
it costs nothing when nothing is running and needs no WebSocket service.

## 018. Deterministic director (2026-11-13)

Video-type classification and pipeline planning use keyword rules and a lookup table, not a model.
**Why:** CLAUDE.md rule 15. Routing is cheap to get right with rules, costs no quota and is fully
testable. Revisit if real briefs show frequent misclassification.

## 019. One corrective retry for model output (2026-11-13)

Invalid JSON or a broken budget gets one retry that quotes the problem, then the agent fails with a
retryable `invalid_output`. **Why:** most bad replies are fixed by one precise correction; more
retries burn the free Neuron allowance. The workflow (Task 7) decides whether to try again later.

## 020. Workers AI is remote-only, so local dev runs without it (2026-11-13)

`pnpm dev` uses `wrangler dev --local` and tests set `remoteBindings: false`. **Why:** development
and CI must work with no Cloudflare account; real AI is opt-in with `dev:ai`.

## 021. No new project status; the pipeline uses the existing ones (2026-11-13)

A "storyboard ready" status was considered. Adding it means rebuilding `projects` to change its
CHECK constraint, and D1 can't switch off foreign keys: dropping the old table would cascade-delete
every project's scenes, jobs and assets. Instead, the workflow follows the blueprint: planning →
generating (with a recorded fallback until Task 8) → awaiting_render. **Why:** no risky migration,
and the statuses mean what they say.

## 022. Jobs keyed by run and agent (2026-11-13)

Job IDs are derived from `runId:agent` (a hashed UUID), and so is the render request ID. **Why:**
Workflows retry steps; stable IDs make each step idempotent without extra lookup tables.

## 023. Cancellation is database-first (2026-11-13)

Cancel marks the run `cancelled`, then terminates the instance; every step checks the run before
working. **Why:** terminate can lag or fail; the database is the source of truth the UI reads.
