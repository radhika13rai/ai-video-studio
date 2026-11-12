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

## 007. Worker tests run in Node (2026-11-12)

Tests call the Worker's `fetch` handler directly under Vitest. **Why:** fast and dependency-free
while there are no bindings. Move to the Workers Vitest pool when D1 and R2 arrive in Task 2–3.
