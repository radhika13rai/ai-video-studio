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

`status` can't be changed through `PATCH`; the production workflow owns it.

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

Generate and cancel (Task 7), scene edits, asset upload and download, render (Task 9), providers
and usage (Task 8).
