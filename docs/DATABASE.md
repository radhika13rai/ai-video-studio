# Database

Cloudflare D1 (SQLite). Schema: `workers/api/migrations/0001_initial_schema.sql`.
Data access: `workers/api/src/db/` (the only code that writes SQL).

## Tables

| Table              | Holds                                                         | Deleted with project     |
| ------------------ | ------------------------------------------------------------- | ------------------------ |
| `users`            | One row per verified identity (email, unique)                 | n/a                      |
| `projects`         | The video request, its settings, status and config JSON       | n/a                      |
| `scenes`           | The storyboard: one row per scene, unique per `scene_number`  | yes (cascade)            |
| `jobs`             | Agent work items with status and retry policy                 | yes (cascade)            |
| `assets`           | Metadata for media stored in R2 (`storage_key`), never bytes  | yes (cascade)            |
| `providers`        | Routing registry: enabled, priority, health, quota, breaker   | n/a (global)             |
| `provider_jobs`    | Long-running provider work (submit/poll), deadline, cost      | yes (cascade)            |
| `workflow_runs`    | Durable workflow executions and their current step            | yes (cascade)            |
| `usage_events`     | Provider usage: units, tier, estimated and actual cost, user  | no (`project_id` → NULL) |
| `quality_reports`  | QC results: status, score, checks, recommendations            | yes (cascade)            |
| `idempotency_keys` | Stored POST responses for safe retries (24 h, migration 0002) | with the user            |

## Rules

1. IDs are UUIDs generated in the application (`crypto.randomUUID()`).
2. Timestamps are UTC ISO-8601 with milliseconds (`2026-11-12T14:27:44.128Z`); the column defaults
   produce the same format, so ordering by text is chronological.
3. JSON lives in TEXT columns. It is validated with Zod before writing, the database rejects
   malformed JSON (`json_valid` CHECKs), and it is re-validated when read.
4. Media goes to R2 under `projects/<projectId>/…`; D1 stores only the key and metadata.
5. **Ownership is enforced inside the SQL.** Every project-scoped function takes `userId` and
   filters with `user_id = ?` or `project_id IN (SELECT id FROM projects WHERE user_id = ?)`.
   Inserts use `INSERT … SELECT … FROM projects WHERE id = ? AND user_id = ?`, so nothing is written
   for a project the caller doesn't own. Someone else's project reads as "not found".
6. Multi-statement changes (replacing a storyboard) use `db.batch`, which D1 runs as one transaction.
7. No credentials in D1. `upsertProvider` refuses quota keys that look like secrets.
8. Every status column has a CHECK list matching the constants in `packages/types`. A test fails if
   they drift apart.

## Job lifecycle and retry policy

```
queued ──start──▶ running ──complete──▶ completed
   ▲                 │
   └──fail (retries left: retry_count + 1)
                     └──fail (no retries left)──▶ failed
queued | running ──cancel──▶ cancelled
```

`max_retries` defaults to 3 per job (max 10, enforced by CHECK, with `retry_count <= max_retries`).
`failJob` applies the policy in one UPDATE, so concurrent workers can't double-count. Transitions are
guarded: starting a cancelled job or completing a queued one raises `invalid_state`.

## Repository errors

`RepositoryError.kind` is one of `not_found`, `conflict` (unique key), `invalid_state` (wrong
lifecycle state) or `invalid_data` (validation). The API layer maps these to HTTP responses in Task 4.

## Migrations

```bash
pnpm --filter @avs/api db:migrate:local    # local D1 used by wrangler dev
pnpm --filter @avs/api db:migrate:remote   # Cloudflare (after the D1 database exists)
```

Never edit an applied migration; add the next numbered file. Migration 0003 (ADR 040) rebuilt
`providers` and `usage_events` to allow the `image_to_video` and `sfx` capabilities (SQLite can't
alter a CHECK), keeping every row and filling `usage_events.user_id` from the project, and added
`provider_jobs`. Tests apply all migrations to a fresh local D1
before each test file.

## Free-tier limits

D1 Free: 5 million rows read and 100,000 rows written per day, 500 MB per database. Check
Cloudflare's current limits; queries are indexed on `user_id`, `project_id` and `status` to keep
reads low.
