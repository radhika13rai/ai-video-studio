# Providers

Agents depend on interfaces, never on a vendor SDK (CLAUDE.md rule 10).

## Text (`workers/api/src/ai/text-model.ts`)

`TextModel.generate({ system, messages, jsonSchema?, maxTokens, temperature })` returns
`{ text, usage? }` or throws `ModelError` (`quota`, `unavailable`, `bad_response`).

| Implementation       | Status                                  | Notes                                                                        |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `WorkersAiTextModel` | Implemented, tested with a fake binding | Default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON-schema output |

**Verified live (2026-11-13):** director → scriptwriter → storyboard ran against Workers AI through
this adapter. The first run's script was far too short (39 of 75 words). Fixes: a minimum of 70% of
the budget, "exactly two sentences per segment" instructions, segment count and minimum length in
the output schema, and a specific correction message. Later runs gave 73–74 words, and their
narration fills the scenes (4.3–5.0 s of voice for 5 s scenes). Responses are validated before use;
error 4006 (daily free allocation used up) maps to a non-retryable `quota` error.

Workers AI free tier: 10,000 Neurons per day at the time of writing; requests fail after that on
the Free plan, and some models need paid billing. Check Cloudflare's current pricing.

### Switching text generation on and off

`AI_TEXT_PROVIDER` is `workers-ai` in `wrangler.jsonc` and `none` under `pnpm dev` and in tests. The
binding object exists locally but can't run, so this explicit switch decides whether
`POST /generate` is allowed.

### Local development

Workers AI always runs on Cloudflare. `pnpm dev` uses `wrangler dev --local`, so it starts without
an account and the `AI` binding is unavailable. With `wrangler login` done, `pnpm --filter
@avs/api dev:ai` connects the real binding (it uses your free allowance). Tests never call it.

## Media (`workers/api/src/providers/`)

`MediaProvider.generate(request)` returns bytes plus their sniffed type, size or duration, and usage
units. It throws `ProviderError` (`quota`, `unavailable`, `bad_response`, `unsupported`).

| Capability | Provider (registry name) | Model                                            | Order | Daily cap* | Notes                                                                                                                 |
| ---------- | ------------------------ | ------------------------------------------------ | ----- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| image      | `workers-ai-flux`        | `@cf/black-forest-labs/flux-1-schnell` (4 steps) | 1     | 60         | Best prompt-following in testing. Square 1024², so 9:16 is cropped by the renderer; prompts ask for a centred subject |
| voice      | none                     | –                                                | –     | –          | Voiced by Kokoro in the browser at render time (ADR 033, 039)                                                         |
| video      | none                     | –                                                | –     | –          | No free video model; recorded fallback: still images with motion effects                                              |
| music      | none                     | –                                                | –     | –          | Not integrated                                                                                                        |

\*Our own safety caps, stored in `providers.quota_metadata.daily_limit` and editable in D1. They
are not Cloudflare's numbers; the real free-tier limit (Neurons per day) still applies and surfaces
as a `quota` error. Partner models (Leonardo, Deepgram Aura, FLUX.2) are billed separately and are
deliberately not used.

**Retired (ADR 039):** SDXL-Lightning and MeloTTS were removed because Cloudflare retires both
on 2026-11-20. Their old registry rows stay in D1 and are ignored.

**Sniffing, not trusting:** in live tests SDXL returned JPEG although its schema says PNG, and
MeloTTS returned WAV although its schema says MP3. `sniffMedia` reads the bytes to decide the
type, dimensions and duration, and anything that isn't real media is rejected.

**Narration in the browser:** narration is voiced at render time by Kokoro-82M in the user's
browser (see `RENDERER.md`, ADR 033). With no server voice provider registered, the workflow's
voice step is skipped, and the renderer reports how many narrated scenes it voiced, which the
quality check uses. In a browser that can't run Kokoro, captions carry the script and the
quality check warns.

### Registry and fallback

`generateMedia` syncs code providers into the `providers` table, inserting rows that are missing
and never overwriting edits. It then tries enabled providers in order: healthy first, then by
priority.

- A provider at its daily cap is skipped.
- A quota error moves on to the next provider.
- A transient failure marks the provider `degraded` and moves on.
- Success records usage and marks the provider `healthy`.
- When nothing works it throws `NoProviderError`, listing every attempt, with `retryable` set if a
  later retry could help.

In the workflow, each scene's image and narration is its own durable step and tracked job
(`visual-artist`, `voice-director`). A transient failure retries the step. When no provider can
produce the media, the scene continues with a recorded fallback ("2 of 3 scenes have no generated
image (…); they will render as styled text cards"). Files go to
`projects/<id>/runs/<runId>/scene-<n>-<image|voice>.<ext>`, and media from earlier runs is deleted
when a new run reaches this stage.

`GET /projects/:id/assets/:assetId/content` streams a file from the private bucket, only to the
project's owner. `GET /providers` lists every capability with its availability, health and usage
today.

### Switches

`AI_MEDIA_PROVIDER` is `workers-ai` when deployed and `none` under `pnpm dev` and in tests.
