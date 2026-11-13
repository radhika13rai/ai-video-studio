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

`status` can't be changed through `PATCH`; the production workflow owns it.

### Production

`generate` works from `created`, `failed`, `cancelled`, `awaiting_render` or `completed` (a run still
waiting for its render is superseded). It claims the project atomically, so a second click gets
409 `INVALID_STATE`. When no text model is available (local `pnpm dev`, or `AI_TEXT_PROVIDER=none`)
it returns 503 `PROVIDER_UNAVAILABLE` and the project is unchanged. `cancel` works while the
project is planning, generating, awaiting or in render or quality check; it marks the run
cancelled, terminates the workflow instance and cancels open jobs. Progress is read from
`/jobs`, `/scenes` and `/run`; the dashboard polls every 3 seconds while production is active.

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

Scene edits, asset upload, render (Task 9).
