# Changelog

## 1.13.0 (2026-11-15)

- Regenerate one scene from the editor (E5): a new image (optionally from your own description)
  or another stock clip (never the same one again). Earlier versions are kept and can be picked
  again; choosing one is undoable. Each scene keeps at most 3 versions plus any the timeline
  uses.
- Export a finished video again after editing: a render-only run goes straight to rendering and
  the quality check, which now judges an edited video against the timeline's length and aspect
  ratio.
- The project remembers which run made its media, so re-exports keep every picture and clip.

## 1.12.0 (2026-11-15)

- Live preview in the editor (E4): play, pause and scrub the edited video with its captions,
  overlays, transitions, music and sound effects, rebuilt shortly after each edit; selecting a
  scene jumps to it and the timeline follows the playhead while playing.
- "Voice the preview" voices narration with Kokoro and caches it in the browser; the export
  reuses cached lines instead of running the voice model again.
- The renderer's scene timing and caption timing are shared by the preview and the export.

## 1.11.0 (2026-11-15)

- Timeline editor (E3), at `/projects/:id/edit` ("Edit video" on the project page once the
  media is made): scenes as clips sized by length with voice, text, sound and music lanes;
  drag to reorder (long-press on a phone) or Move left/right; drag the right edge or use the
  slider to change length; duplicate and delete; per-scene transition, length, camera, shot,
  framing, footage trim, narration text, voice, speed and level, caption, label, text overlays
  and sound effects; captions, music and transition sounds for the whole video; aspect ratio.
- Undo and redo (100 steps; typing and dragging merge into one step; Ctrl/⌘+Z, Shift+Ctrl/⌘+Z).
- Autosave: on this device after 0.3 s, to the server 2 s after the last edit; offline edits are
  kept and retried; unsaved edits from an earlier visit can be restored; when another tab or
  device saved first, choose to keep yours or load theirs; earlier versions can be restored.

## 1.10.0 (2026-11-15)

- Renderer editor features (E2): text overlays with presets and entrance animations, caption
  styles (bold, minimal, karaoke) and positions, captions on/off, per-scene voice, speed and
  level, music on/off, level and ducking, placed sound effects (whoosh, hit, riser, pop, boom),
  per-scene transition length, focal point and footage trim. Unedited projects render as
  before.

## 1.9.0 (2026-11-15)

- Editable timelines (editor step E1): every project has a typed timeline (clips in order, each
  with its media, length, framing, camera, transition, voice, caption, text overlays and sound
  effects; plus captions, music and transition sounds). It is saved in D1 with conflict
  protection and up to 20 snapshots for version history.
- The render plan is now compiled from the timeline. An unedited project renders exactly as
  before; a saved edit (order, lengths, captions, narration text, aspect ratio, music) is what
  renders.
- Timeline API: read, save, version history and restore.

## 1.8.0 (2026-11-15)

- Paid image-to-video (fal.ai, Wan 2.5), built and **switched off**: when turned on with a key
  and a daily budget, video-style projects animate each generated image into a short clip as a
  long-running job, within the budget, keeping the image as the fallback.
- Fallback notes for video-style projects count scenes with real motion (stock footage or an
  animated image).

## 1.7.0 (2026-11-15)

- Free stock footage: video-style projects (advertisement, cinematic, presenter) use a real
  Pexels clip per scene when the free `PEXELS_API_KEY` secret is set, and a generated image when
  no clip fits. Each clip is credited on the scene card and in the video.
- The renderer plays footage frame-accurately (clips are decoded only while on screen) and adds
  synthesized whooshes and hits on whip, slide, zoom and flash transitions.
- Provider failure notes now say why ("no stock clip found for …"), not just "failed".

## 1.6.0 (2026-11-15)

- Capability-aware providers: seven separate capabilities (text, image, video, image-to-video,
  voice, music, sound effects); a provider serves only what it declares, so an image model can
  never stand in for video.
- Every provider declares its tier (free or paid), cost model, limits, time limit, key name and
  commercial-use terms. Routing skips providers that can't take the request, lack their key, are
  paused, are at their daily cap, or (paid) would pass the budget; then orders by health,
  priority and estimated cost.
- Each call has a time limit. Three failures in a row pause a provider (5 minutes, doubling up to
  an hour); running out of allowance pauses it until the allowance resets.
- Paid providers stay off unless switched on with a daily budget; each paid call reserves its
  estimated cost atomically. Usage records estimated and actual cost.
- Long-running provider jobs (submit, then poll, with a deadline) and a workflow helper that waits
  between polls and falls over to the next provider.
- Status page: provider tier, price and pause state, and a generation-costs card
  (`GET /providers/costs`).

## 1.5.1 (2026-11-15)

- Removed the SDXL-Lightning image model and the MeloTTS server voice: Cloudflare retires both on
  2026-11-20. FLUX schnell makes every image; narration is voiced only by Kokoro in the browser.
- The production run no longer makes server narration files, and "Retry media" is offered only
  for missing images.
- The renderer reports how many narrated scenes got a voice; the quality check uses that report,
  so videos voiced in the browser no longer show "no narration" warnings, and a scene the voice
  couldn't speak is listed as missing instead of silently dropped.

## 1.5.0 (2026-11-15)

- The renderer follows the blueprint: planned shot size and camera move per scene, planned
  transitions (including hard cuts), on-screen text labels, and music chords, texture and tempo
  from the planned mood. Projects without a blueprint render as before.

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
