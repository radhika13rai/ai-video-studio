# Architecture

**Principle:** a cloud-hosted control plane, browser-based rendering, and quota-aware AI generation.

```
Browser (apps/studio)  ──/api/v1──▶  Worker (workers/api)  ──▶  D1 (project data)
   │  renders video with FFmpeg.wasm        │                    R2 (media files)
   └──────── uploads the finished MP4 ──────┘                    Workflows (orchestration)
```

- `workers/api` owns every backend operation. It serves the built frontend through the `ASSETS`
  binding, and `/api/*` always reaches the Worker first.
- `apps/studio` owns the user experience. It never calls an AI provider or holds a secret.
- `renderer` will own media rendering. It runs in the browser, never in the Worker.
- `packages/contracts`, `packages/schemas` and `packages/types` define how the parts communicate.
  Both sides import the same TypeScript source.

## What exists today (Tasks 1–3)

- `GET /api/v1/health`, plus JSON 404 and 405 responses in the shared error envelope.
- An app shell that calls the health endpoint and validates the response with Zod.
- Shared contracts: API paths, the envelope, error codes, and the create-project request schema.

- Cloudflare bindings in `workers/api/wrangler.jsonc`: `DB` (D1), `MEDIA` (R2) and
  `PRODUCTION_WORKFLOW` (Workflows, class `ProductionWorkflow`). Health probes each one.
- `ProductionWorkflow` is a stub that validates input; its steps arrive in Task 7.
- Worker tests run in workerd with local bindings (`@cloudflare/vitest-plugin`).

- D1 schema (nine tables) and the repository layer in `workers/api/src/db/`. See `DATABASE.md`.

HTTP endpoints for projects (Task 4), agents, providers and the renderer are not implemented yet.
