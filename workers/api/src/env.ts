import type { ProductionParams } from "./workflows/production-workflow";

/** Bindings declared in wrangler.jsonc. Secrets are added with `wrangler secret put`, never here. */
export interface Env {
  APP_ENV?: string;
  MAX_VIDEO_DURATION?: string;
  MAX_PROJECT_SCENES?: string;
  ASSETS?: Fetcher;
  DB?: D1Database;
  MEDIA?: R2Bucket;
  PRODUCTION_WORKFLOW?: Workflow<ProductionParams>;
}
