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
