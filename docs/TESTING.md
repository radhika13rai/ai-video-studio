# Testing

`pnpm check` runs typecheck, lint, format check, every package's tests and the frontend build. CI
(`.github/workflows/ci.yml`) runs the same steps on every push and pull request, plus a
`wrangler deploy --dry-run` that validates the Worker configuration.

| Package            | Runner                                                                          | What it covers                                                                     |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `workers/api`      | Vitest in workerd (`@cloudflare/vitest-plugin`) with local D1, R2 and Workflows | Repositories, API, auth, workflow, agents, providers, renderer API, quality checks |
| `renderer`         | Vitest in Node                                                                  | Timing, captions, cropping, motion, WAV, graphics cues and layouts                 |
| `apps/studio`      | Vitest + happy-dom + Testing Library                                            | Pages, forms, production controls, render panel                                    |
| `packages/schemas` | Vitest                                                                          | Contracts                                                                          |

AI models are replaced with scripted fakes in tests (`setTextModelOverride`,
`setMediaProvidersOverride`); real MP4s made by the renderer live in `workers/api/tests/fixtures`.
Live checks against Workers AI and in a real browser are recorded in `PROVIDERS.md` and
`RENDERER.md`. Graphics scenes have a browser script, `node renderer/scripts/graphics-fixture.mjs`
(headless Chromium + ffmpeg; not part of `pnpm check`), that renders the 12-scene fixture and
checks stills, the safe area, the preview, the MP4 and the sound cues.

## Blueprint acceptance tests

| Test                         | Expected                    | Status                                                   | Where                                               |
| ---------------------------- | --------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| Create project               | Saved in D1                 | ✅ automated                                             | `api.test.ts`                                       |
| Submit prompt                | Workflow starts             | ✅ automated                                             | `workflow.test.ts`                                  |
| Generate script              | Structured script saved     | ✅ automated, ✅ live (Workers AI)                       | `agents.test.ts`, `workflow.test.ts`                |
| Create storyboard            | Scenes saved in D1          | ✅ automated, ✅ live                                    | `workflow.test.ts`                                  |
| Generate images              | Assets stored in R2         | ✅ automated, ✅ live (FLUX)                             | `providers.test.ts`                                 |
| Generate narration           | Voiced in the browser       | ✅ automated (step skipped; QC uses the render's report) | `providers.test.ts`                                 |
| Open renderer                | Correct manifest loads      | ✅ automated, ✅ browser                                 | `render.test.ts`                                    |
| Export video                 | Valid MP4                   | ✅ browser + ffprobe; QC parses it                       | `RENDERER.md`, `quality.test.ts`                    |
| Upload video                 | Final file in R2            | ✅ automated, ✅ browser                                 | `render.test.ts`                                    |
| Run QC                       | Quality report generated    | ✅ automated                                             | `quality.test.ts`, `workflow.test.ts`               |
| Exhaust provider quota       | Graceful fallback           | ✅ automated                                             | `providers.test.ts`, `workflow.test.ts`             |
| Retry failed scene           | Only that scene regenerates | ✅ automated                                             | `quality.test.ts`                                   |
| Unauthorized project access  | 403 or 404                  | ✅ automated (404)                                       | `api.test.ts`, `render.test.ts`                     |
| Duplicate generation request | No duplicate workflow       | ✅ automated                                             | `workflow.test.ts`, `api.test.ts` (Idempotency-Key) |

**Not yet verified:** one uninterrupted prompt-to-MP4 run on the deployed Worker with live AI.
Every stage has run live separately; the full chain needs the production deployment (see
README, "Deploying").
