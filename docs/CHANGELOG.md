# Changelog

## 1.4.0 (2026-11-15)

- Creative Director: every new production gets a validated blueprint (story beats, style bible,
  recurring characters, shot/camera/transition per scene, music and pacing, asset requirements).
  One extra model call with schema validation and a template fallback; ambiguous or malformed
  requests become visible assumptions instead of guesses. Scene image prompts now share one
  style and repeat each recurring character's description.

## 1.3.0 (2026-11-14)

- One render per project: attempt tokens with a 30-minute lease; a second tab or device gets
  "already rendering" with **Start anyway**; upload, complete and abort require the token, so a
  stale tab can't cancel or overwrite a live render.
- Uploads stream into R2 instead of being held in Worker memory, need a `Content-Length`, are
  validated in storage, and replace the previous video only after the new one is saved; a damaged
  upload never deletes the old video.
- `production_config` updates are atomic per key.

## 1.2.0 (2026-11-14)

- Quality check: the length is judged against what the renderer planned (scenes fitted to the
  narration), with a separate "Render length" check that still catches truncated videos; extra
  length versus the brief is a warning.
- Render retries: a failed quality check allows another render (up to 3 per run) without
  regenerating the script, images or narration; the render panel shows "Attempt 2 of 3" and why.

## 1.1.1 (2026-11-14)

- Voice and depth models run in background workers with time limits and a live seconds counter;
  a phone that's too slow falls back to server narration or flat moves instead of freezing on
  "Voicing scene 1". Each scene is voiced once (speed picked up front).

## 1.1.0 (2026-11-14)

- Free motion: depth-based 3D camera moves (Depth Anything V2 Small + WebGL), shots with punch-ins
  and handheld drift, five scene transitions, word-by-word captions synced to the narration,
  kinetic text scenes, title intro, progress bar, vignette and film grain, generated background
  music ducked under the voice.
- Kokoro-82M narration in the browser (Heart default, Michael backup, picker in the render panel);
  MeloTTS stays as the fallback. Scenes stretch to fit their narration.
- Pinned, self-hosted renderer files (`VENDOR_FILES`): models and runtimes served from R2,
  `/health` lists missing files, deploys upload them with sha256 checks.
- Live: custom domain `studio.rawwgrid.com`, Google sign-in via Cloudflare Access; the deploy
  workflow fails on wrangler errors and finds the custom-domain URL.

## 1.0.0 (2026-11-13)

- Task 10: quality controller (MP4 structure via ranged R2 reads, duration, codecs, audio,
  resolution, fast start, bitrate, scene coverage; report with score and recommendations;
  failures fail the project); damaged uploads rejected; per-scene "Retry media"; quality card and
  retry buttons in the dashboard; progress loads per part; CI workflow (lint, format, types, tests,
  build, Worker dry-run); deploy workflow (migrations job, deploy, FFmpeg core, health check,
  summary); FFmpeg core uploaded to production R2; acceptance tests mapped in `TESTING.md`.

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
