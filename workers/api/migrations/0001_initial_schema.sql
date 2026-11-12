-- Migration 0001: initial schema (nine core tables).
-- Rules: IDs are application-generated UUIDs; timestamps are UTC ISO-8601 strings;
-- JSON lives in TEXT columns and is validated before writing; media binaries live in R2.
-- Status lists must match the constants in packages/types/src/index.ts (enforced by tests).

PRAGMA foreign_keys = ON;

-- 1. Users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 2. Projects
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  video_type TEXT NOT NULL CHECK (
    video_type IN ('cinematic', 'faceless', 'animation', 'presenter', 'advertisement', 'explainer', 'auto')
  ),
  aspect_ratio TEXT NOT NULL DEFAULT '9:16' CHECK (aspect_ratio IN ('9:16', '16:9', '1:1')),
  duration_seconds INTEGER NOT NULL DEFAULT 30 CHECK (duration_seconds BETWEEN 1 AND 600),
  target_platform TEXT NOT NULL DEFAULT 'youtube_shorts' CHECK (
    target_platform IN ('youtube_shorts', 'instagram_reels', 'tiktok', 'youtube', 'facebook_reels')
  ),
  status TEXT NOT NULL DEFAULT 'created' CHECK (
    status IN ('created', 'planning', 'generating', 'awaiting_render', 'rendering', 'quality_check',
               'completed', 'failed', 'cancelled')
  ),
  production_config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(production_config)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 3. Scenes
CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL CHECK (scene_number >= 1),
  description TEXT NOT NULL,
  visual_prompt TEXT,
  voiceover TEXT,
  duration_seconds REAL NOT NULL DEFAULT 5 CHECK (duration_seconds > 0),
  visual_type TEXT NOT NULL DEFAULT 'image' CHECK (visual_type IN ('image', 'video', 'animation', 'text')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'generating', 'ready', 'failed', 'skipped')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, scene_number)
);

-- 4. Jobs (status + retry policy are mandatory: see CLAUDE.md rule 8)
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL,
  agent_name TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 0 AND 10),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (retry_count <= max_retries)
);

-- 5. Assets (metadata only; the bytes live in R2 under storage_key)
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL,
  asset_type TEXT NOT NULL CHECK (
    asset_type IN ('image', 'video', 'audio', 'voiceover', 'music', 'subtitle', 'thumbnail', 'render')
  ),
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  file_size INTEGER CHECK (file_size IS NULL OR file_size >= 0),
  source_provider TEXT,
  license_metadata TEXT CHECK (license_metadata IS NULL OR json_valid(license_metadata)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 6. Provider registry (no credentials here: those are Worker secrets)
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('text', 'image', 'video', 'voice', 'music')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    health_status IN ('unknown', 'healthy', 'degraded', 'down')
  ),
  quota_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(quota_metadata)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider_name, capability)
);

-- 7. Workflow executions
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  workflow_instance_id TEXT,
  current_step TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (
    status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')
  ),
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 8. Usage tracking (kept when a project is deleted, for quota accounting)
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  provider_name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('text', 'image', 'video', 'voice', 'music')),
  units_used REAL NOT NULL DEFAULT 0 CHECK (units_used >= 0),
  unit_type TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 9. Quality reports
CREATE TABLE quality_reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  overall_status TEXT NOT NULL CHECK (overall_status IN ('passed', 'warning', 'failed')),
  score REAL CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  checks_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checks_json)),
  recommendations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommendations_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Indexes
CREATE INDEX idx_projects_user ON projects(user_id, created_at);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_jobs_project ON jobs(project_id, created_at);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_scenes_project ON scenes(project_id, scene_number);
CREATE INDEX idx_assets_project ON assets(project_id);
CREATE INDEX idx_workflows_project ON workflow_runs(project_id);
CREATE INDEX idx_usage_project ON usage_events(project_id, created_at);
CREATE INDEX idx_usage_provider ON usage_events(provider_name, capability, created_at);
CREATE INDEX idx_quality_project ON quality_reports(project_id, created_at);
