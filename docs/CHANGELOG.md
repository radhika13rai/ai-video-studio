# Changelog

## 0.9.0 (2026-11-13)

- Task 9: browser renderer (`@avs/renderer`): Canvas frames with Ken Burns motion, balanced burned-in
  captions, text cards and fades; Web Audio narration mix; WebCodecs H.264 with an FFmpeg.wasm
  fallback; FFmpeg.wasm AAC and MP4 assembly; render, upload, complete and abort endpoints with
  identity checks; FFmpeg core served from R2; render panel with progress, stop and one render per
  browser; final video player and download. Verified in a real browser with real AI media.
  21 new tests.

## 0.8.0 (2026-11-13)

- Task 8: media provider layer: FLUX and SDXL image and MeloTTS voice adapters on Workers AI with
  byte sniffing; registry with priority, health, daily caps, usage and fallback; per-scene image
  and narration steps in the workflow (tracked jobs, R2 storage, recorded fallbacks); asset content
  endpoint; `GET /providers`; scene images and narration players in the dashboard; providers table
  on the status page. Script length fixed (minimum 70%, length-constrained schema, two sentences per
  segment), verified live. 16 new tests.

## 0.7.1 (2026-11-13)

- Cloudflare resources created: D1 database `ai-video-studio` (real `database_id` in
  `wrangler.jsonc`, migrations 0001–0002 applied remotely) and R2 bucket `ai-video-studio-media`.
  Agents verified against live Workers AI.

## 0.7.0 (2026-11-13)

- Task 7: durable production workflow (director, scriptwriter and storyboard as tracked jobs with
  matching retry policies; media fallback recorded; render request with a 7-day wait; failure and
  cancel handling; token usage tracking); `POST /generate`, `POST /cancel`, `GET /run`; project
  page with live pipeline steps, error messages, fallback notes and the storyboard;
  `AI_TEXT_PROVIDER` switch. 11 new tests.

## 0.6.0 (2026-11-13)

- Task 6: director (deterministic classifier and pipeline planner), scriptwriter and storyboard
  agents with JSON-schema output, validation, word and scene budgets, one corrective retry and
  storyboard normalization; `TextModel` interface with a Workers AI adapter; `AI` binding;
  `pnpm dev` runs local-only. 23 new tests.

## 0.5.0 (2026-11-13)

- Task 5: project dashboard: list with status badges, filters, paging and polling; New video form
  with validation and duplicate protection; project page with rename and delete; status page;
  responsive layout. Validated API client. 22 new frontend tests and a browser end-to-end run.

## 0.4.0 (2026-11-12)

- Task 4: project API (`/me`, create, list, get, patch, delete, scenes, jobs, assets, quality),
  Cloudflare Access JWT verification with a local developer identity, fail-closed production
  default, shared error envelope with new codes, 64 KB JSON limit, Idempotency-Key support
  (migration 0002), small router. 24 new tests.

## 0.3.0 (2026-11-12)

- Task 3: migration `0001_initial_schema.sql` (nine tables, indexes, CHECK constraints) and typed
  repository functions for every table, with ownership enforced in SQL, Zod-validated JSON, job
  retry policy and transactional storyboard replacement. 28 new tests.

## 0.2.0 (2026-11-12)

- Task 2: D1, R2 and Workflows bindings; health endpoint reports binding status; stub
  `ProductionWorkflow`; Worker tests in workerd; `scripts/validate-env.sh` deploy guard; app shell
  shows each binding.

## 0.1.0 (2026-11-12)

- Task 1: monorepo foundation, health endpoint, app shell, shared contracts, tests.
