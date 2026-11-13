// @ts-expect-error -- plain JS helper (Node APIs); this config runs in Node, not in the Worker.
import { loadMp4Fixtures } from "./tests/load-fixtures.mjs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the real Workers runtime (workerd via Miniflare) with the bindings from
// wrangler.jsonc: local D1, local R2 and the production workflow. The SQL migrations are read here
// (in Node) and applied inside the runtime by tests/apply-migrations.ts before each test file.
// Small real MP4s (made by the renderer) for the quality checks, passed in as base64.
const fixtures: Record<string, string> = loadMp4Fixtures("./tests/fixtures");
const migrations = await readD1Migrations("./migrations"); // relative to workers/api, where vitest runs;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Workers AI is remote-only; tests never call it (agents get a scripted fake model).
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_MP4: JSON.stringify(fixtures),
          APP_ENV: "test",
          AI_TEXT_PROVIDER: "none",
          AI_MEDIA_PROVIDER: "none",
          WORKFLOW_RETRY_DELAY: "1 second",
        },
      },
    }),
  ],
  test: { setupFiles: ["./tests/apply-migrations.ts"] },
});
