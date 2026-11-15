-- Migration 0004: editable timelines (ADR 043).
-- One current timeline per project (JSON, validated by the application), saved with optimistic
-- concurrency on `revision`, plus occasional snapshots for version history and recovery.
-- Media is referenced by asset id; bytes stay in R2.

CREATE TABLE timelines (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE timeline_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  reason TEXT NOT NULL,
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, revision)
);
CREATE INDEX idx_timeline_revisions_project ON timeline_revisions(project_id, created_at);
