import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the real Workers runtime (workerd via Miniflare) with the bindings from
// wrangler.jsonc: local D1, local R2 and the production workflow. The SQL migrations are read here
// (in Node) and applied inside the runtime by tests/apply-migrations.ts before each test file.
const migrations = await readD1Migrations("./migrations"); // relative to workers/api, where vitest runs;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Workers AI is remote-only; tests never call it (agents get a scripted fake model).
      remoteBindings: false,
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, APP_ENV: "test" } },
    }),
  ],
  test: { setupFiles: ["./tests/apply-migrations.ts"] },
});
