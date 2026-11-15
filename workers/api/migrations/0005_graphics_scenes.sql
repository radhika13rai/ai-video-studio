-- Migration 0005: motion-graphics scenes (ADR 048).
-- SQLite can't change a CHECK constraint, so `scenes` is rebuilt with 'graphics' allowed and a
-- graphics_layout column (JSON, at most 8 KB, checked by the API). D1 keeps foreign keys on, and
-- dropping the old table runs ON DELETE SET NULL on assets.scene_id and jobs.scene_id, so those
-- links are saved first and restored after the rename.
PRAGMA defer_foreign_keys = true;

CREATE TABLE scenes_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL CHECK (scene_number >= 1),
  description TEXT NOT NULL,
  visual_prompt TEXT,
  voiceover TEXT,
  duration_seconds REAL NOT NULL DEFAULT 5 CHECK (duration_seconds > 0),
  visual_type TEXT NOT NULL DEFAULT 'image' CHECK (
    visual_type IN ('image', 'video', 'animation', 'text', 'graphics')
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'generating', 'ready', 'failed', 'skipped')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  graphics_layout TEXT,
  UNIQUE (project_id, scene_number)
);

INSERT INTO scenes_new (id, project_id, scene_number, description, visual_prompt, voiceover,
  duration_seconds, visual_type, status, created_at)
SELECT id, project_id, scene_number, description, visual_prompt, voiceover,
  duration_seconds, visual_type, status, created_at
FROM scenes;

CREATE TABLE scene_links_0005 (kind TEXT NOT NULL, id TEXT NOT NULL, scene_id TEXT NOT NULL);
INSERT INTO scene_links_0005 (kind, id, scene_id)
  SELECT 'asset', id, scene_id FROM assets WHERE scene_id IS NOT NULL;
INSERT INTO scene_links_0005 (kind, id, scene_id)
  SELECT 'job', id, scene_id FROM jobs WHERE scene_id IS NOT NULL;

DROP TABLE scenes;
ALTER TABLE scenes_new RENAME TO scenes;
CREATE INDEX idx_scenes_project ON scenes(project_id, scene_number);

UPDATE assets SET scene_id = (
  SELECT l.scene_id FROM scene_links_0005 l WHERE l.kind = 'asset' AND l.id = assets.id
) WHERE id IN (SELECT id FROM scene_links_0005 WHERE kind = 'asset');
UPDATE jobs SET scene_id = (
  SELECT l.scene_id FROM scene_links_0005 l WHERE l.kind = 'job' AND l.id = jobs.id
) WHERE id IN (SELECT id FROM scene_links_0005 WHERE kind = 'job');
DROP TABLE scene_links_0005;

ALTER TABLE projects ADD COLUMN graphics_theme TEXT;
