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

## What exists today (Tasks 1–9)

- `GET /api/v1/health`, plus JSON 404 and 405 responses in the shared error envelope.
- An app shell that calls the health endpoint and validates the response with Zod.
- Shared contracts: API paths, the envelope, error codes, and the create-project request schema.

- Cloudflare bindings in `workers/api/wrangler.jsonc`: `DB` (D1), `MEDIA` (R2) and
  `PRODUCTION_WORKFLOW` (Workflows, class `ProductionWorkflow`). Health probes each one.
- `ProductionWorkflow` is a stub that validates input; its steps arrive in Task 7.
- Worker tests run in workerd with local bindings (`@cloudflare/vitest-plugin`).

- D1 schema (nine tables) and the repository layer in `workers/api/src/db/`. See `DATABASE.md`.

- Project API (`/me`, project CRUD, read-only scenes, jobs, assets and quality) behind
  authentication: Cloudflare Access in production, a developer identity locally. See `API.md` and
  `SECURITY.md`.

- Dashboard in `apps/studio`: project list (status filter, paging, badges, polling while in
  production), New video form (client-side Zod validation, Idempotency-Key per form), project page
  (brief, rename, delete), system status page. Pages live in `src/pages`, the API client in
  `src/services/api.ts` (every response validated), routing in `src/lib/router.tsx`.

- Agents in `workers/api/src/agents`: a deterministic director and model-backed scriptwriter and
  storyboard with validated JSON output, behind the `TextModel` interface (Workers AI adapter in
  `src/ai`). See `AGENTS.md` and `PROVIDERS.md`. - `ProductionWorkflow` (Cloudflare Workflows) runs director → scriptwriter → storyboard as tracked
  jobs, records the media fallback, requests a render and waits up to 7 days for it, then
  completes. `POST /projects/:id/generate` and `/cancel` drive it; the project page shows live
  steps, errors and the storyboard. See `AGENTS.md`.

- Media providers (`src/providers`): FLUX and SDXL images and MeloTTS narration on Workers AI, behind
  a registry with priorities, daily caps, health and fallback. Each scene's media is stored in R2
  and served to its owner. See `PROVIDERS.md`.

- Browser renderer (`renderer/`): Canvas frames, Web Audio narration, WebCodecs/FFmpeg.wasm encoding
  to H.264/AAC MP4, upload to R2 and a workflow event to finish. See `RENDERER.md`.

Automated quality checks and deployment (Task 10) are not implemented yet.
