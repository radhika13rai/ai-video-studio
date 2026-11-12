import type { Env as WorkerEnv } from "../src/env";

// Bindings as configured in wrangler.jsonc are always present inside the test runtime.
declare global {
  namespace Cloudflare {
    interface Env
      extends Required<Pick<WorkerEnv, "DB" | "MEDIA" | "PRODUCTION_WORKFLOW">>, WorkerEnv {}
  }
}
