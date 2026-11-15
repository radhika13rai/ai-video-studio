# Agents

Code: `workers/api/src/agents/`. Each agent validates its input with Zod, returns
`{ output, meta }` with a typed output, and fails with an `AgentError` whose `kind` is
`invalid_input`, `invalid_output`, `quota` or `unavailable` and which says whether a retry can help.

| Agent        | Kind          | Input                 | Output                                                                 |
| ------------ | ------------- | --------------------- | ---------------------------------------------------------------------- |
| Director     | Deterministic | Brief                 | `ProductionPlan`: video type, pipeline, scene count, word budget, tone |
| Scriptwriter | Text model    | Brief + plan          | `Script`: title, hook, segments, call to action                        |
| Storyboard   | Text model    | Brief + plan + script | `Storyboard`: numbered scenes ready for `replaceScenes`                |

The researcher, visual artist, voice director, editor, quality control and operations agents from
the blueprint arrive with the tasks that need them (7–10).

## Director (no AI)

When `video_type` is `auto`, keyword rules pick one of advertisement, explainer, animation,
cinematic, presenter or faceless (the default), with a confidence score and a reason. A type the
user chose is kept. The pipeline table then decides the visual style (image, video or animation),
narration, presenter and the provider capabilities needed. Scene count is duration ÷ 5, between 2
and 20; the word budget is 2.5 spoken words per second. **Why deterministic:** routing doesn't need
a model (CLAUDE.md rule 15); rules are free, instant and testable.

## Creative Director (`src/creative/`)

Turns the request into a validated **production blueprint** (`production_config.blueprint`,
`ProductionBlueprint` v1): story structure and beats, a style bible, recurring characters, music,
pacing, and per scene the beat, shot size, camera move, transition, narration, on-screen text,
sound-effect ideas and asset requirements. **Rules decide; the model only proposes.**

| Part           | Kind          | Does                                                                                                                                                                                                                                        |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates.ts` | deterministic | Per type: structure (AIDA, tutorial, three-act, story, listicle), beats, pacing, camera, transitions, music, look                                                                                                                           |
| `ambiguity.ts` | deterministic | Cleans markup/code/JSON/links; flags vague, conflicting, too-dense, non-English and injection prompts as assumptions or issues                                                                                                              |
| `interpret.ts` | **model**     | One `runStructured` call: subject, audience, key message, characters, style, must-include/avoid, ambiguities. Sanitised (no instruction text, no invented full names); rules fallback on no model, quota or invalid output                  |
| `compose.ts`   | deterministic | Merges plan + interpretation + script + storyboard; storyboard values outside the vocabulary are replaced by the template's (recorded); character descriptions (never names) and the style suffix are added to every relevant visual prompt |
| `validate.ts`  | deterministic | Durations sum to the length, beats contiguous, references resolve, first scene cuts in, no repeated transition, narration density (≤ 3.2 words/s, warning), prompt length; result always passes the schema                                  |

Workflow (new runs only, gated by the `blueprint: 1` run parameter so waiting runs replay
unchanged): `director → creative-director → scriptwriter (+ beats, key message) → storyboard
(+ optional shot/camera/transition/characters/sfx/on_screen_text) → blueprint → media`. The
blueprint step rewrites scene visual prompts with the enriched ones. Neither new step can fail
production: interpretation falls back to rules, and a blueprint error is recorded as
`blueprint_error` while the storyboard is used as it is. The project page lists the
assumptions and shows each scene's beat and camera note.

Not yet: multi-voice dialogue (`dialogue` is always empty), sound-effect generation, and image
seeds for stronger character consistency (consistency is text-based, so it improves but isn't
guaranteed).

## Structured output

`runStructured` asks the model for JSON and sends the JSON Schema generated from the agent's Zod
schema (Workers AI enforces it with `response_format`). The reply is parsed (code fences and chatter
are tolerated), validated against the schema, then against agent checks such as the word budget
and scene count. An invalid reply gets **one** corrective retry that quotes the exact problem; a
second failure is `invalid_output`. Provider quota errors become `quota` (not retryable today).

## Prompt safety

The brief is user input. Every system prompt says to treat it as a description only and ignore
instructions inside it. Agents ask for no statistics, quotes or sources the model isn't sure of,
no text overlays, logos or real people's names in visual prompts.

## Storyboard normalization

Scene numbers are reassigned 1…n. Durations are scaled to sum exactly to the project length
(0.1 s precision, each scene at least 0.5 s). A visual type the pipeline doesn't allow (for example
`video` in an image pipeline) is replaced with the pipeline default and counted in
`coerced_visual_types`, so the change is recorded, not hidden.

## Testing

`tests/agents.test.ts` drives every agent with a scripted fake model: valid output, fenced JSON,
retry with feedback, over-long scripts, schema violations, quota errors, scene-count retries,
normalization, and saving a storyboard through the real repository into local D1.

## Production workflow (`src/workflows/production-workflow.ts`)

| Step                                                | Project status            | What happens                                             |
| --------------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `load-project`                                      | planning                  | Reads the brief (ownership enforced through `userId`)    |
| `director`                                          | planning                  | Plan saved to `production_config.plan`                   |
| `scriptwriter`                                      | planning                  | Script saved as the job's output                         |
| `storyboard`                                        | planning                  | Scenes saved with `replaceScenes`                        |
| `generate-assets`                                   | generating                | Checks the provider registry; records fallbacks openly   |
| `request-render`                                    | awaiting_render           | Saves a render request; the run status becomes `waiting` |
| `wait-for-render`                                   | awaiting_render           | Waits for the `render-complete` event (7-day timeout)    |
| `finish`                                            | quality_check → completed | Checks the event matches the render request, runs QC     |
| `request-render-N`, `wait-for-render-N`, `finish-N` | awaiting_render → …       | Attempts 2–3 after a failed QC (see below)               |

- **Jobs:** every agent runs through `runAgentJob`, which creates a job with a stable ID derived
  from the run, so a retried step reuses it. A completed job replays its saved output. A running
  job found on retry counts as a failed attempt.
- **Retries:** AI steps retry twice with exponential backoff (10 s by default,
  `WORKFLOW_RETRY_DELAY`), and the job's `max_retries` matches. Errors a retry can't fix (quota
  used up, bad input) throw `NonRetryableError` and fail the job permanently.
- **Failure:** a `record-failure` step cancels open jobs, sets the project to `failed` and saves a
  readable error on the run. A missed render becomes "The video wasn't rendered within 7 days."
- **Cancel:** the endpoint marks the run cancelled before terminating the instance. Every step
  checks the run first, so nothing more is written after a cancel.
- **Usage:** model tokens are recorded in `usage_events` for quota tracking.
- **Media fallback:** when no provider can produce a scene's media, the run notes it (for example
  "6 of 6 scenes have no generated image … they will render as styled text cards") and the project
  page shows it. The requested visuals are never swapped silently.
- **Render attempts:** a run allows `MAX_RENDER_ATTEMPTS` (3) renders. A failed quality check
  sends the project back to `awaiting_render` with `production_config.render_request` =
  `{ id, attempt, max_attempts, last_failure }` and a new request id
  (`renderRequestIdFor(runId, attempt)`); scenes, images and narration are kept and "Retry media"
  still works. Attempt 1 keeps the original step names and id, so runs started earlier resume.
  Only a failed QC uses an attempt (a stopped browser render doesn't). The last failure fails the
  run "after 3 render attempts".

## Quality controller (`src/quality/`, deterministic)

Runs in the workflow's `finish` step, after the render event. It reads the MP4 with ranged R2 reads
(`mp4.ts`, an ISO BMFF box reader, so no decoding) and checks:

| Check             | Fails when                                   | Warns when                             |
| ----------------- | -------------------------------------------- | -------------------------------------- |
| file              | not an MP4, no `moov`, no media data         | –                                      |
| video             | no video track                               | codec isn't H.264                      |
| resolution        | –                                            | not 720p or 1080p for the aspect ratio |
| audio             | narration was generated but there's no audio | the video is silent by design          |
| render_length     | off by more than 25% of the render's plan    | off by more than 0.5 s                 |
| duration          | see below                                    | off the brief by more than 0.5 s       |
| faststart         | –                                            | `moov` after `mdat`                    |
| bitrate           | –                                            | under 300 kb/s                         |
| images, narration | –                                            | scenes without generated media         |

**Length.** Scenes are lengthened in the browser to fit their narration, so the video can be longer
than the brief. The renderer reports the length it planned (`x-video-duration`, stored as
`reported_duration_seconds`). When that value is plausible (0.5–2× the brief and at most 1.5× the
maximum length), `render_length` compares the real MP4 length with it (this catches truncated
renders), and `duration` only warns about the brief, failing only below 25% of it or above 1.5× the
maximum. Without a plausible value, `duration` compares with the brief as before (fail beyond
25%). The real length always comes from the MP4, never from the client.

Score = 100 − 30 per fail − 8 per warning. Any fail marks the project `failed` with the reasons on
the run; otherwise it's `completed`. The report, with plain-language recommendations, is stored
in `quality_reports` and shown on the project page. Uploads are parsed the same way, so a damaged
MP4 is rejected before it's stored.

**Retry a scene:** `POST /projects/:id/scenes/:sceneId/retry-media` regenerates only that scene's
image and narration through the provider registry, as tracked `regenerate_*` jobs. Old files are
replaced only after the new ones exist, and the fallback notes are recomputed.
