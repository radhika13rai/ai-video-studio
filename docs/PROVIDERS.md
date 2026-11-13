# Providers

Agents depend on interfaces, never on a vendor SDK (CLAUDE.md rule 10).

## Text (`workers/api/src/ai/text-model.ts`)

`TextModel.generate({ system, messages, jsonSchema?, maxTokens, temperature })` returns
`{ text, usage? }` or throws `ModelError` (`quota`, `unavailable`, `bad_response`).

| Implementation       | Status                                  | Notes                                                                        |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `WorkersAiTextModel` | Implemented, tested with a fake binding | Default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON-schema output |

**Verified live (2026-11-13):** director → scriptwriter → storyboard ran against Workers AI through
this adapter in about 19 s, using about 360 tokens. The run produced a valid script and 5 scenes
totalling exactly 30 s. Finding: the script was short (39 of a 75-word budget), because the
minimum is 50% of the budget; this is to be tightened. Responses are validated before use;
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

## Image, video, voice and music

Arrive in Task 8, behind the same kind of interface and the provider registry in D1.
