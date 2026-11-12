# API

Base path: `/api/v1`. Contracts live in `packages/contracts` and `packages/schemas`.

## Envelope

```json
{ "success": true, "data": {} }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "retryable": false } }
```

Error codes: `VALIDATION_ERROR`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `PROJECT_NOT_FOUND`,
`ACCESS_DENIED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_QUOTA_EXCEEDED`, `GENERATION_FAILED`,
`RENDER_FAILED`, `QUALITY_CHECK_FAILED`, `RATE_LIMITED`, `INTERNAL_ERROR`.

## Implemented

### `GET /health`

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "ai-video-studio-api",
    "version": "0.1.0",
    "environment": "development",
    "timestamp": "2026-11-12T10:10:39.865Z"
  }
}
```

## Planned (not implemented)

Project CRUD, generate and cancel, jobs, scenes, assets, render, quality, providers and usage.
They arrive from Task 4 onward. The create-project request schema is already defined in
`packages/schemas`.
