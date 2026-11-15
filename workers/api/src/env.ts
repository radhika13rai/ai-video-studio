import type { ProductionParams } from "./workflows/production-workflow";

/** Bindings declared in wrangler.jsonc. Secrets are added with `wrangler secret put`, never here. */
export interface Env {
  /** "production" (the default in wrangler.jsonc), "development" or "test". */
  APP_ENV?: string;
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". Not a secret. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience (AUD) tag. Not a secret. */
  ACCESS_AUD?: string;
  MAX_VIDEO_DURATION?: string;
  MAX_PROJECT_SCENES?: string;
  /** "workers-ai" (default) or "none" to disable text generation (local dev, tests). */
  AI_TEXT_PROVIDER?: string;
  /** "workers-ai" (default) or "none" to disable image and voice generation. */
  AI_MEDIA_PROVIDER?: string;
  /** Pexels API key (Worker secret, `wrangler secret put PEXELS_API_KEY`). Enables stock video. */
  PEXELS_API_KEY?: string;
  /** "on" lets paid providers run (still only within the budgets below). Default off. */
  PAID_PROVIDERS?: string;
  /** Most all paid generation may cost per UTC day, in USD (default 0 = none). */
  PAID_DAILY_BUDGET_USD?: string;
  /** Most one user's paid generation may cost per UTC day, in USD (default: the daily budget). */
  PAID_USER_DAILY_BUDGET_USD?: string;
  /** Delay between retries of AI steps, e.g. "10 seconds" (default). Tests shorten it. */
  WORKFLOW_RETRY_DELAY?: string;
  /** Optional override of the Workers AI text model id. */
  AI_TEXT_MODEL?: string;
  ASSETS?: Fetcher;
  /** Workers AI. Remote-only: absent under `pnpm dev` (wrangler dev --local) and in tests. */
  AI?: Ai;
  DB?: D1Database;
  MEDIA?: R2Bucket;
  PRODUCTION_WORKFLOW?: Workflow<ProductionParams>;
}
