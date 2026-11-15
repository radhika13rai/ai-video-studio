# API

Base path: `/api/v1`. Contracts live in `packages/contracts` (paths, error codes) and
`packages/schemas` (Zod schemas for every request and response).

## Envelope

```json
{ "success": true, "data": {} }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "title: Too small", "retryable": false } }
```

| HTTP    | Code                              | When                                                    |
| ------- | --------------------------------- | ------------------------------------------------------- |
| 400     | `VALIDATION_ERROR`                | Body, query or header failed validation (field named)   |
| 401     | `UNAUTHENTICATED`                 | No valid Cloudflare Access token, or sign-in not set up |
| 404     | `NOT_FOUND` / `PROJECT_NOT_FOUND` | Unknown route, or a project you don't own               |
| 405     | `METHOD_NOT_ALLOWED`              | Wrong method (see the `Allow` header)                   |
| 409     | `CONFLICT` / `INVALID_STATE`      | Duplicate key, wrong lifecycle state, request in flight |
| 413     | `PAYLOAD_TOO_LARGE`               | JSON body over 64 KB                                    |
| 415     | `UNSUPPORTED_MEDIA_TYPE`          | Body not sent as `application/json`                     |
| 422     | `IDEMPOTENCY_KEY_REUSED`          | Same Idempotency-Key, different request                 |
| 500/503 | `INTERNAL_ERROR` (retryable)      | Unexpected error or missing binding                     |

Another user's project always answers **404**, never 403, so IDs can't be probed.

## Authentication

Every endpoint except `/health` needs a signed-in user. See `SECURITY.md`.

## Endpoints

| Method | Path                    | Body / query                                             | Returns                                                     |
| ------ | ----------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/health`               | –                                                        | Service and binding status (public)                         |
| GET    | `/me`                   | –                                                        | The signed-in user                                          |
| POST   | `/projects`             | `createProjectRequestSchema`; optional `Idempotency-Key` | 201, project, `Location` header                             |
| GET    | `/projects`             | `?limit=1–100&cursor=…&status=…`                         | `{ items, next_cursor }`, newest first                      |
| GET    | `/projects/:id`         | –                                                        | Project                                                     |
| PATCH  | `/projects/:id`         | `{ title?, style? }` (`style: null` removes it)          | Project                                                     |
| DELETE | `/projects/:id`         | –                                                        | `{ id, deleted, media_deleted }`; also deletes its R2 media |
| GET    | `/projects/:id/scenes`  | –                                                        | Scenes in order                                             |
| GET    | `/projects/:id/jobs`    | –                                                        | Agent jobs                                                  |
| GET    | `/projects/:id/assets`  | –                                                        | Asset metadata                                              |
| GET    | `/projects/:id/quality` | –                                                        | Latest quality report or `null`                             |

| POST | `/projects/:id/generate` | optional `Idempotency-Key` | 202 `{ project_id, workflow_run_id, status: "planning" }` |
| POST | `/projects/:id/cancel` | – | The cancelled project |
| GET | `/projects/:id/run` | – | Latest workflow run or `null` |
| GET | `/projects/:id/timeline` | – | `{ project_id, revision, timeline, updated_at }`; revision 0 = built from the production, not yet saved |
| PUT | `/projects/:id/timeline` | `{ base_revision, timeline }` (≤ 256 KB) | The saved timeline (revision + 1); 409 `CONFLICT` if another save came first; 400 on an invalid timeline or a reference outside the project |
| GET | `/projects/:id/timeline/revisions` | – | Snapshots, newest first: `{ revision, reason, created_at }` |
| POST | `/projects/:id/timeline/revisions/:rev/restore` | `{ base_revision }` | Restores a snapshot as the newest revision |
| POST | `/projects/:id/scenes/:sceneId/regenerate` | `{ what: "image" \| "footage", prompt? }` | 201 `{ scene_id, asset }`: a new version (earlier ones kept, at most 3 plus any in use); 502 `GENERATION_FAILED` with the providers' reasons |
| POST | `/projects/:id/export` | – | 202: a render-only run for a finished (`completed`, `failed`, `cancelled`) video; the project goes to "Ready to render" with its timeline |
| GET | `/providers` | – | Every capability with its providers: availability, health, tier, price, pause state, usage today |
| GET | `/providers/costs` | – | `{ paid: { enabled, daily_budget_usd, user_daily_budget_usd, spent_today_usd, you_spent_today_usd }, today, last_30_days }` |

`status` can't be changed through `PATCH`; the production workflow owns it.

### Production

`generate` works from `created`, `failed`, `cancelled`, `awaiting_render` or `completed` (a run still
waiting for its render is superseded). It claims the project atomically, so a second click gets
409 `INVALID_STATE`. When no text model is available (local `pnpm dev`, or `AI_TEXT_PROVIDER=none`)
it returns 503 `PROVIDER_UNAVAILABLE` and the project is unchanged. `cancel` works while the
project is planning, generating, awaiting or in render or quality check; it marks the run
cancelled, terminates the workflow instance and cancels open jobs. Progress is read from
`/jobs`, `/scenes` and `/run`; the dashboard polls every 3 seconds while production is active.

### Render (browser)

| Method | Path                                              | Body / headers                                                            | Returns                                 |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| POST   | `/projects/:id/render[?takeover=1]`               | –                                                                         | Manifest incl. `render_attempt_token`   |
| POST   | `/projects/:id/render/upload?render_request_id=…` | raw `video/mp4`, `Content-Length`, `x-render-attempt`, `x-video-duration` | 201 render asset                        |
| POST   | `/projects/:id/render/complete`                   | `{ render_request_id, asset_id }`, `x-render-attempt`                     | 202 `{ status: "quality_check" }`       |
| POST   | `/projects/:id/render/abort`                      | `x-render-attempt`                                                        | The project (back to `awaiting_render`) |

- **One render at a time.** Starting a render claims the project atomically with a new attempt
  token, held for 30 minutes (`RENDER_LEASE_MINUTES`). A second start meanwhile gets 409
  `CONFLICT` ("already rendering in another tab or device"); `?takeover=1` replaces the holder.
  An expired lease needs no takeover.
- **Token required.** Upload, complete and abort must send the holder's token in
  `x-render-attempt`; a missing or replaced token gets 409 `CONFLICT` and changes nothing.
  Complete and abort release the token.
- **Upload.** `Content-Length` is required (411 without it; 413 over 95 MB, before reading). The
  body streams into R2 under a fresh name; a body shorter or longer than declared is rejected.
  The stored file is then checked with ranged reads (size, `ftyp`, MP4 structure, a video track);
  a bad file is deleted and the previous video stays. Only after the new asset is recorded are
  older render files removed.

### Create a project

```http
POST /api/v1/projects
Content-Type: application/json
Idempotency-Key: project-create-001

{ "title": "The Future of Smart Watches", "prompt": "Create an engaging product advertisement",
  "video_type": "advertisement", "aspect_ratio": "9:16", "duration_seconds": 30,
  "target_platform": "youtube_shorts", "style": "premium cinematic" }
```

Defaults: `video_type` auto, `aspect_ratio` 9:16, `duration_seconds` 30 (5–60),
`target_platform` youtube_shorts. Response: the full project with `status: "created"`.

### Idempotency

Send `Idempotency-Key` (1–255 visible ASCII characters) on `POST /projects` to make retries safe.
Within 24 hours, the same key and body replays the first response (header
`Idempotent-Replayed: true`); the same key with a different body returns 422. Keys are per user.
Server errors aren't stored, so a 5xx can be retried with the same key.

## Planned

Scene text edits, user asset upload, rate limiting.
