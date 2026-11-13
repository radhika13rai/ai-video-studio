# AI Video Studio

A universal, autonomous AI video production platform: one natural-language prompt in, one finished
video out. It runs on Cloudflare's free tier, and the user's browser does the video rendering.

**Status: Task 1 of 10, repository foundation.** The health endpoint and an app shell work. There are
no projects, agents, providers or renderer yet.

## Stack

| Part            | Technology                                            |
| --------------- | ----------------------------------------------------- |
| Frontend        | React + Vite + TypeScript (`apps/studio`)             |
| API and hosting | Cloudflare Workers with static assets (`workers/api`) |
| Database        | Cloudflare D1 (Task 2–3)                              |
| Media storage   | Cloudflare R2 (Task 2)                                |
| Orchestration   | Cloudflare Workflows (Task 7)                         |
| Rendering       | Browser-based FFmpeg.wasm (`renderer`, Task 9)        |
| Validation      | Zod (`packages/schemas`)                              |
| Tests           | Vitest                                                |

## Repository layout

```
apps/studio          React app (the user experience)
workers/api          Cloudflare Worker (all backend operations)
packages/types       Domain vocabulary and limits
packages/schemas     Zod schemas for requests and responses
packages/contracts   API paths, response envelope, error codes
packages/prompts, packages/video-templates, renderer   reserved for later tasks
docs                 Architecture and decision records
```

## Setup

You need Node 22 or newer and pnpm 10.

```bash
pnpm install
pnpm check        # typecheck, lint, format check, tests, frontend build
```

## Local development

```bash
pnpm build        # once, so the Worker has frontend assets to serve
pnpm --filter @avs/api db:migrate:local   # once, and after each new migration
pnpm dev          # Worker on http://127.0.0.1:8787 and Vite on http://localhost:5173
```

- Open **http://localhost:5173** for the app with hot reload. Vite proxies `/api` to the Worker.
- **http://127.0.0.1:8787** serves the built app and the API together, as it will in production.
- Check the API: `curl http://127.0.0.1:8787/api/v1/health`

No Cloudflare account or secrets are needed for local development. `wrangler dev` simulates D1,
R2 and Workflows on disk under `workers/api/.wrangler/` (git-ignored). Delete that folder to reset
local data.

## Deploying to Cloudflare

Already done for this project: the D1 database and R2 bucket exist, migrations are applied, and
the FFmpeg core is in R2.

**One-time, in the Cloudflare dashboard:**

1. Open **Workers & Pages** once. This creates your free `workers.dev` subdomain.
2. Set up sign-in (free for up to 50 users): **Zero Trust** → choose a team name → **Access →
   Applications → Add → Self-hosted**. Use the Worker's address
   (`ai-video-studio.<subdomain>.workers.dev`) and a policy that allows your email. Copy the
   **Application Audience (AUD) tag**.
3. Put the team domain (`<team>.cloudflareaccess.com`) and AUD tag in `workers/api/wrangler.jsonc`
   as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. These are not secrets.

Until step 3 is done, the deployed API rejects every call except `/health` (fail-closed).

**Deploy by hand:**

```bash
pnpm build
pnpm --filter @avs/api exec wrangler d1 migrations apply DB --remote   # reviewed migrations only
pnpm --filter @avs/api vendor:upload                                   # once per FFmpeg version
pnpm --filter @avs/api deploy                                          # runs validate-env.sh first
```

**Or automatically on every merge to `main`** (`.github/workflows/deploy.yml`):

1. GitHub → repository **Settings → Secrets and variables → Actions**: add
   `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts, D1 and Workers R2 Storage Edit) and
   `CLOUDFLARE_ACCOUNT_ID`.
2. Optional: **Settings → Environments → production → Required reviewers**, so migrations and
   deploys wait for your approval.

The workflow applies migrations in its own job, deploys, uploads the FFmpeg core if it's missing,
checks `/api/v1/health` and writes a summary. Without the secrets it reports "skipped".

**Roll back** a bad release: `pnpm --filter @avs/api exec wrangler rollback`. This rolls back code
only; D1 data stays as it is.

## Scripts

| Command                             | What it does                           |
| ----------------------------------- | -------------------------------------- |
| `pnpm dev`                          | Worker and frontend together           |
| `pnpm dev:api` / `pnpm dev:web`     | One of them                            |
| `pnpm build`                        | Type-check and build the frontend      |
| `pnpm typecheck`                    | Strict TypeScript across every package |
| `pnpm lint`                         | ESLint                                 |
| `pnpm format` / `pnpm format:check` | Prettier                               |
| `pnpm test`                         | Vitest across every package            |
| `pnpm check`                        | All of the above                       |

Worker-only (`pnpm --filter @avs/api <script>`): `deploy`, `cf:create`, `db:migrate:local`,
`db:migrate:remote`, `types`.

## API

Base path: `/api/v1`. Every response uses one envelope:

```json
{ "success": true, "data": {} }
{ "success": false, "error": { "code": "NOT_FOUND", "message": "…", "retryable": false } }
```

| Method               | Endpoint                                               | Status                                                     |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| GET                  | `/health`                                              | Public; reports D1, R2 and Workflows binding status        |
| GET                  | `/me`                                                  | The signed-in user                                         |
| POST / GET           | `/projects`                                            | Create (supports `Idempotency-Key`) / list with pagination |
| GET / PATCH / DELETE | `/projects/:id`                                        | Read, rename or change style, delete with its media        |
| GET                  | `/projects/:id/scenes`, `/jobs`, `/assets`, `/quality` | Read-only collections                                      |

See `docs/API.md` for details and `docs/SECURITY.md` for sign-in. Locally you are signed in as
developer@example.com; send `X-Dev-User: someone@example.com` to act as another user. A deploy
rejects API calls until Cloudflare Access is configured.

## Implementation tasks

- [x] 1. Repository foundation
- [x] 2. Cloudflare foundation (Wrangler, D1, R2, Workflows, local development)
- [x] 3. Database (nine tables, migrations, repository functions)
- [x] 4. API foundation (project CRUD, validation, errors, authentication)
- [x] 5. Project dashboard
- [x] 6. Director and creative agents
- [x] 7. Workflow orchestration
- [x] 8. Provider adapters
- [x] 9. Browser renderer
- [x] 10. Quality control, CI and deployment

Development rules are in [`CLAUDE.md`](CLAUDE.md).
