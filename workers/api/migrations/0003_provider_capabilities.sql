-- Migration 0003: capability-aware providers (ADR 040).
-- * Two new capabilities: image_to_video and sfx (SQLite can't alter a CHECK, so the providers
--   and usage_events tables are rebuilt; nothing references either table).
-- * Circuit breaker state on providers: consecutive failures, cool-down and last error.
-- * Costs on usage_events: estimated (before the call) and actual (reported by the provider),
--   the owning user (for per-user budgets) and the provider job, if any.
-- * provider_jobs: long-running provider work (submit, then poll) with a deadline.

CREATE TABLE providers_new (
  id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (
    capability IN ('text', 'image', 'video', 'image_to_video', 'voice', 'music', 'sfx')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    health_status IN ('unknown', 'healthy', 'degraded', 'down')
  ),
  quota_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(quota_metadata)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  cooldown_until TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider_name, capability)
);
INSERT INTO providers_new (id, provider_name, capability, enabled, priority, health_status,
  quota_metadata, updated_at)
SELECT id, provider_name, capability, enabled, priority, health_status, quota_metadata, updated_at
FROM providers;
DROP TABLE providers;
ALTER TABLE providers_new RENAME TO providers;

CREATE TABLE usage_events_new (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider_name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (
    capability IN ('text', 'image', 'video', 'image_to_video', 'voice', 'music', 'sfx')
  ),
  units_used REAL NOT NULL DEFAULT 0 CHECK (units_used >= 0),
  unit_type TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  actual_cost_usd REAL CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'paid')),
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO usage_events_new (id, project_id, user_id, provider_name, capability, units_used,
  unit_type, estimated_cost_usd, created_at)
SELECT u.id, u.project_id, p.user_id, u.provider_name, u.capability, u.units_used, u.unit_type,
  u.estimated_cost_usd, u.created_at
FROM usage_events u LEFT JOIN projects p ON p.id = u.project_id;
DROP TABLE usage_events;
ALTER TABLE usage_events_new RENAME TO usage_events;
CREATE INDEX idx_usage_project ON usage_events(project_id, created_at);
CREATE INDEX idx_usage_provider ON usage_events(provider_name, capability, created_at);
CREATE INDEX idx_usage_spend ON usage_events(tier, created_at);
CREATE INDEX idx_usage_user ON usage_events(user_id, tier, created_at);

CREATE TABLE provider_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (
    capability IN ('text', 'image', 'video', 'image_to_video', 'voice', 'music', 'sfx')
  ),
  -- Our own idempotency key, e.g. "<run>:video:scene-3"; a retried submit finds the same job.
  job_key TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')
  ),
  polls INTEGER NOT NULL DEFAULT 0 CHECK (polls >= 0),
  estimated_cost_usd REAL NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  actual_cost_usd REAL CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  result_key TEXT,
  error_message TEXT,
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, job_key)
);
CREATE INDEX idx_provider_jobs_status ON provider_jobs(status, deadline_at);
