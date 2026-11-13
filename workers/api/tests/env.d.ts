import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/env";

// Bindings as configured in wrangler.jsonc are always present inside the test runtime.
declare global {
  namespace Cloudflare {
    interface Env
      extends Required<Pick<WorkerEnv, "DB" | "MEDIA" | "PRODUCTION_WORKFLOW">>, WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** JSON map of fixture file name → base64 MP4. */
      TEST_MP4: string;
    }
  }
}
