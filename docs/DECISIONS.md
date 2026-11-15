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

## 024. FLUX first, SDXL second (2026-11-13)

Both were tested live with the same prompt. FLUX followed it (underwater, light from above); SDXL
didn't (mountains above water). FLUX is square only, so the renderer crops it. **Why:** prompt
fidelity matters more than native aspect ratio, and SDXL remains as an automatic backup.

## 025. Media failures degrade a scene, not the video (2026-11-13)

When no provider can produce a scene's image or narration, the workflow records a fallback and
continues; only text planning failures fail the run. **Why:** a video with some text cards is
better than none, and the blueprint asks for recorded, never silent, fallbacks.

## 026. Constrain length in the schema, not only in words (2026-11-13)

The script schema sent to the model includes the segment count and a minimum length per segment
in characters. The prompt asks for two sentences per segment. **Why:** live runs showed Llama
writes about half the requested words when it is only given a word count.

## 027. WebCodecs for video, FFmpeg.wasm for AAC and the MP4 (2026-11-13)

Chromium's WebCodecs encodes H.264 in hardware but can't encode AAC. FFmpeg.wasm always produces
the final file (AAC audio, MP4 container); it also encodes the video with libx264 when WebCodecs
isn't available. **Why:** fast where possible (5 s vs 29 s for 15 s of 720p), works everywhere, and
keeps the blueprint's H.264/AAC output.

## 028. FFmpeg core served from R2, not a CDN or static assets (2026-11-13)

The 32 MB core is over the 25 MiB static-asset limit. The Worker serves it from R2 at a versioned,
immutable same-origin path. **Why:** no third-party runtime dependency, no CORS or isolation
headers, and it stays inside the free tier.

## 029. Single-threaded FFmpeg core (2026-11-13)

The multi-threaded core needs `SharedArrayBuffer`, which needs COOP/COEP headers on every page and
breaks embedding cross-origin media. **Why:** with WebCodecs doing the heavy video work, FFmpeg
only muxes and encodes AAC, so threads add complexity for little gain.

## 030. Quality checks read the MP4's structure in the Worker (2026-11-13)

A small ISO BMFF reader parses `moov` with ranged R2 reads; there's no decoding and no external
service. **Why:** structure, codecs, size and duration catch the real failure modes (broken upload,
missing audio, wrong length) within Worker limits; perceptual checks would need compute we don't
pay for.

## 031. A quality failure fails the project, warnings don't (2026-11-13)

**Why:** an unplayable or silent-by-mistake video must not look "completed", but a missing image
on one scene still makes a usable video, so it's a warning with a retry suggestion.

## 032. Deploys from CI are opt-in and migrations are a separate job (2026-11-13)

The deploy workflow runs only when the Cloudflare secrets exist, applies migrations in their own
job behind a `production` environment, then deploys and health-checks. **Why:** the blueprint asks
to keep production migrations separate, and a fresh fork shouldn't fail CI for missing secrets.

## 033. Kokoro-82M narration runs in the browser (2026-11-14)

The voice is Kokoro-82M (Apache-2.0), voices Heart (default) and Michael (backup), run by
`kokoro-js` on ONNX Runtime Web during the render. **Why:** it's free and far more natural than
MeloTTS; Workers can't run an 82M-parameter model within their CPU and memory limits; and a GitHub
Actions runner (as with Python `kokoro-onnx`) would add minutes of latency, a stored GitHub token
and a callback for every video. MeloTTS still runs in the workflow as the fallback.

## 034. "2.5D" motion from depth, not generated video (2026-11-14)

No free video-generation API exists and open models need a large GPU. A small depth model (Depth
Anything V2 Small, 27 MB) plus a WebGL parallax shader makes still pictures move like a camera
shot, on any phone; shots, transitions, word captions and generated music do the rest. **Why:**
zero cost, runs on the user's device, and stays replaceable: a real video provider can be added
later as another media capability.

## 035. Renderer models and runtimes are pinned and self-hosted (2026-11-14)

`VENDOR_FILES` lists every third-party renderer file with its source; downloads carry a pinned
Hugging Face revision and sha256. The Worker serves only listed paths from R2; `/health` reports
missing ones and the deploy uploads them. **Why:** reproducible renders, no CDN at runtime, and a
failed or tampered download stops the deploy instead of reaching users.

## 036. Up to three render attempts per run; length judged against the render's own plan (2026-11-14)

A failed quality check returns the project to "Ready to render" instead of ending the run, up to
three attempts; the last failure fails the run. The length check compares the MP4 with the length
the renderer reports it planned, when plausible, and treats extra length versus the brief as a
warning. **Why:** scenes are deliberately stretched to fit the narration, so the brief is no
longer the right yardstick, and a failed render shouldn't force regenerating the script, images
and voice (time and free AI quota). Attempt 1 keeps its step names so in-flight runs resume.

## 037. Render attempt tokens with a lease; streamed, validate-then-replace uploads (2026-11-14)

`POST /render` claims the project with a random attempt token in one conditional D1 update
(30-minute lease, explicit takeover). Upload, complete and abort require that token. Uploads
stream into R2 with `FixedLengthStream`, get a fresh object name, are validated with ranged reads,
and replace the old video only after the new asset row exists. `mergeProductionConfig` now uses
`json_set` per key, so concurrent writers to different keys can't overwrite each other.
**Why:** two tabs or devices could break each other's renders, a stale tab could cancel a live
one, a 95 MB body could exhaust Worker memory, and a failed upload could lose the previous video.
No migration: the token lives in the existing `production_config` JSON.

## 038. Creative Director: rule-based templates plus one validated model proposal (2026-11-15)

The blueprint is composed deterministically from per-type templates; a single model call adds
the request's specifics (subject, characters, style), and every model value is validated,
sanitised and replaceable by the template's. Character consistency is a fixed appearance
description repeated in each scene's prompt; names never reach the image model. New steps are
gated by a run parameter. **Why:** structure and pacing are craft rules that templates encode
reliably and for free; the model is good at specifics but unreliable at structure; one extra
call keeps the free quota impact small; gating keeps Workflows replay safe for waiting runs.

## 039. Retire SDXL-Lightning and MeloTTS; narration only in the browser (2026-11-15)

Cloudflare's model catalogue lists `@cf/bytedance/stable-diffusion-xl-lightning` and
`@cf/myshell-ai/melotts` with a planned deprecation date of 2026-11-20. Both adapters are
removed. FLUX schnell is the only image provider (square, cropped by the renderer). Narration is
voiced only by Kokoro in the browser; the workflow skips server narration when no voice provider
is registered, and the renderer reports voiced/total narrated scenes with the upload
(`x-video-narration`, `x-video-narrated-scenes`), which the quality check uses instead of voice
assets. **Why:** the only Workers AI replacement voice (Deepgram Aura) is metered per character,
Kokoro already voices the final video and sounds better, and the owner chose the free option.
Existing registry rows for the removed providers stay in D1 and are ignored.

## 040. Capability-aware provider routing with budgets, breaker and long jobs (2026-11-15)

Media capabilities are separate types (`image`, `video`, `image_to_video`, `voice`, `music`,
`sfx`) with one typed request each; a provider declares one capability plus its facts (tier,
cost model, limits, time limit, secret name, commercial use, sync or async). `planRoute` is a
pure function that filters (enabled, supports the request, key set, not paused, under its daily
cap, paid allowed and within budget) and orders (health, priority, estimated cost). Calls run
under `withTimeout`. Circuit breaker in `providers`: three consecutive failures mark a provider
down and pause it (5 min × 2ⁿ, max 1 h); quota errors pause until `retryAt` (Workers AI: next
00:00 UTC) without counting as failures; a refused key pauses for an hour; any success resets.
Paid calls reserve their estimate with one conditional INSERT (atomic against both budgets),
settled with the actual cost or released on failure. Async providers use `provider_jobs`
(idempotent per job key, terminal states are final, deadline → timed out) driven by
`runMediaJob`, which uses `step.sleep` between polls and caps polls per attempt.
**Why:** the old registry knew two capabilities, had no time limits, kept a failing provider
"degraded" forever, recorded every cost as $0 and had no way to keep paid providers in check or
to wait for multi-minute video jobs. Keeping routing pure and the facts in code makes each
provider replaceable and testable without a vendor.

## 041. Free stock footage from Pexels; frame-accurate clips and synthesized sound effects (2026-11-15)

Video-style projects get real motion from Pexels stock footage, a free API (key required,
200 requests/hour, 20,000/month, commercial use allowed). It is registered as a `video` provider
with `credential: "PEXELS_API_KEY"`, so routing skips it until the secret exists. The workflow
tries footage first only for video-style projects and only for runs started with `media: 2`
(replay safety); the decision is taken in a step. The renderer decodes clips lazily and seeks
per frame. Transition effects are synthesized in the mix. **Why:** no free generative video API
is reliable enough (ADR 040's research), and real footage is the free way to get true motion;
Freesound was rejected because its API is non-commercial only, and synthesized effects need no
licence at all.

## 042. Paid image-to-video through fal.ai, built switched off (2026-11-15)

`FalWanImageToVideo` is an async, paid `image_to_video` provider using fal's queue API (one key
for many models, per-second billing, no SDK). The workflow animates generated images in
video-style projects only when `hasCodeProvider(env, "image_to_video")` (decided in a step),
which requires the key, `PAID_PROVIDERS=on` and a budget above 0; otherwise nothing changes.
Wan 2.5 at 720p was chosen as the cheapest well-documented option on fal ($0.10/s; Veo 3.1 Fast
is $0.10–0.12/s but needs a Google Cloud setup, Kling/Seedance prices vary by version). The owner
approved building it switched off; turning it on is a separate decision. **Why:** the job
system, budgets and breaker from ADR 040 make a paid, slow provider safe to add, and keeping it
behind three switches means no money is spent by accident.

## 043. A typed, persisted timeline compiled into the render manifest (2026-11-15)

`TimelineV1` (packages/schemas/timeline.ts) is the editable source of truth for a video: clips in
order play back to back on one magnetic track; voice, caption, overlays and sound effects belong
to their clip with clip-relative times; music is one bed. It is stored as validated JSON in D1
(`timelines`, one row per project, with `revision` for optimistic concurrency; snapshots every
5 minutes or on restore in `timeline_revisions`, at most 20). Media is referenced by asset id and
checked to belong to the project on save; references to replaced media are repaired to the
scene's newest file. `timelineFromProduction` builds the default timeline and `compileTimeline`
turns any timeline into manifest scenes; both are pure and shared by the server and the editor.
A new production run deletes the old timeline. **Why:** editing needs one durable, typed
document; magnetic clips match phone editors and keep reordering trivial; compiling (rather
than teaching the renderer about timelines) keeps the renderer, upload and quality pipeline
unchanged, and a test proves unedited projects render byte-for-byte the same plan.

## 044. Editor features as optional manifest fields (2026-11-15)

The timeline compiles editor settings into optional manifest fields, emitted only when they
differ from the defaults; the renderer treats an absent field as the previous behaviour. Text
overlays are drawn by the same canvas painter (presets, not free styling, so they stay legible
on phones), sound effects are synthesized in the offline mix like the transition effects, and
per-scene voice settings feed the existing Kokoro worker. **Why:** one renderer and one manifest
for old and new projects, no new files or licences, and the golden test of ADR 043 keeps proving
that unedited projects don't change. The split of the renderer into reusable media, paint and
mix stages is done with the live preview (E4), where a second caller first needs it.

## 045. The editor: typed commands, snapshot history, two-level autosave (2026-11-15)

Every edit is an `EditorCommand` applied by a pure reducer and validated against the timeline
schema before it is accepted (refused edits show the schema's reason). History keeps whole
timeline snapshots (a timeline is small; structural sharing keeps unchanged clips shared), up
to 100, merging commands with the same coalesce key within one second. Autosave writes a draft
to localStorage after 0.3 s (enough for ≤ 256 KB, synchronous and available everywhere; the
voice cache in E4 uses IndexedDB because it stores audio) and saves to the server 2 s after the
last edit with the base revision; 409 → keep mine / load theirs, network failure → retry every
10 s with the draft kept, 4xx → the reason is shown. On load, a draft that differs from the
server is offered for restore (flagged when it started from an older revision). Drag and drop
uses pointer events (mouse and pen drag after 8 px; touch needs a 300 ms long press so the
timeline still scrolls) with pure geometry helpers, and every drag has a button or keyboard
equivalent. No editor or drag-and-drop library was added.

## 046. Live preview reuses the export pipeline; voice lines cached in IndexedDB (2026-11-15)

The preview is a second caller of the renderer, not a separate player: shared stages
(`fitDurations`, `withDurations`, `sceneWords`, `speechPlan`) and the same `paintFrame` and
`mixNarration`, driven by the audio clock instead of an encoder. To stay real-time on phones it
skips the depth model, plays footage as video with drift correction, and renders at 640 px tall.
Kokoro narration is not generated automatically (it takes tens of seconds on a phone); the user
asks for it, and lines are cached by content hash so the export and later previews reuse them.
**Why:** one implementation guarantees the preview matches the exported video, and the cache
turns the slowest step of rendering into a one-time cost.

## 047. Scene versions, render-only export runs and the media run (2026-11-15)

Regenerating a scene creates a new asset version instead of replacing the old one, so undo and
the version picker can return to it; versions beyond 3 per scene and kind are deleted, oldest
first, except those the saved timeline uses (and the one just made). "Another stock clip" passes
the scene's existing clip ids as `avoid` to the provider. Re-exporting a finished video starts
the production workflow with `renderOnly: 1`: it loads the stored plan and goes straight to the
render attempts and quality check (judged against the timeline's length and aspect ratio), so
upload, completion, retries and QC are reused unchanged. `production_config.media_run_id` records
the run that made the media (set when a run reaches the media stage, or on the first export for
older projects), so later runs never hide the project's files. **Why:** reusing the workflow
keeps one render path with its guarantees, and keeping versions makes regeneration safe to try.

## 048. Graphics scenes: deterministic layouts, AI fills the slots (2026-11-15)

Motion-graphics explainers are a new scene type, `graphics`, drawn by the existing Canvas painter
so the export and the live preview share one code path (ADR 046); no Remotion or other
React-to-video renderer, no server rendering. **Layouts are code:** eleven presets with
size-capped text slots (`graphicsLayoutSchema`, a discriminated union on `preset`). Llama on
Workers AI can't reliably lay out a frame, so the model only picks a preset and fills slots,
through structured output validated with zod (rule 15); if it is off, out of quota, unreachable
or returns invalid output, a deterministic fallback maps the beat (hook → `hook_headline`, CTA →
`cta_card`, objection → `chat_objection`, proof → `checklist`, steps → `card_list`, …) and uses
the scene's own text, so the step never fails a run. **Persistent objects:** the project's
`graphics_theme` holds the palette, an anchor object and the mascot; each preset defines their
pose and they glide between poses on a spring across scenes. **One timing source:** a pure
`cues(layout, durationFrames)` gives each element's entrance frame and sound; the painter and the
audio mixer both read it. Briefs asking for motion graphics (keywords) get the `motion_graphics`
visual style: the storyboard makes only graphics scenes and the media stage generates no image or
footage for them. The headline font (Lilita One, OFL) is a pinned vendor file loaded with
FontFace, falling back to bold Inter. **Why:** deterministic layouts are free, instant, testable
and always fit the safe area; the model adds wording, not geometry. **Limits:** one 9:16
composition (letterboxed in other aspect ratios); one anchor object (a folder); the theme is set
to the default for new projects and isn't editable in the UI yet.
