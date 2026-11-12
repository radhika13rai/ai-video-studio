import { applyD1Migrations, env } from "cloudflare:test";

// Idempotent: records applied migrations in d1_migrations, as wrangler does.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
