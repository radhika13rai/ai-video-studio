import { timelineSchema, type Timeline, type TimelineRevision } from "@avs/schemas";
import { invalidData } from "./errors";
import { newId, nowIso, OWNED } from "./util";

/**
 * Persistence for editable timelines (ADR 043). Every query enforces project ownership. Saves use
 * optimistic concurrency: a save names the revision it started from and is refused when another
 * tab or device saved in between, so edits are never silently overwritten.
 */

/** Keep at most this many snapshots per project. */
export const MAX_TIMELINE_SNAPSHOTS = 20;
/** Autosave snapshots at most this often; explicit reasons (restore, export) always snapshot. */
export const SNAPSHOT_EVERY_MS = 5 * 60_000;

export interface StoredTimelineRow {
  project_id: string;
  revision: number;
  timeline: Timeline;
  updated_at: string;
}

interface Row {
  project_id: string;
  revision: number;
  doc: string;
  updated_at: string;
}

function parseDoc(doc: string): Timeline {
  let raw: unknown;
  try {
    raw = JSON.parse(doc);
  } catch {
    throw invalidData("stored timeline is malformed");
  }
  const parsed = timelineSchema.safeParse(raw);
  if (!parsed.success) throw invalidData("stored timeline has an unexpected shape");
  return parsed.data;
}

export async function getTimeline(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<StoredTimelineRow | null> {
  const row = await db
    .prepare(`SELECT * FROM timelines WHERE project_id = ? AND ${OWNED("project_id")}`)
    .bind(projectId, userId)
    .first<Row>();
  return row
    ? {
        project_id: row.project_id,
        revision: row.revision,
        timeline: parseDoc(row.doc),
        updated_at: row.updated_at,
      }
    : null;
}

export type SaveResult =
  { ok: true; saved: StoredTimelineRow } | { ok: false; current: StoredTimelineRow | null };

/**
 * Saves `timeline` if the stored revision is still `baseRevision` (0 = nothing saved yet).
 * The caller validates the timeline first. Snapshots for history every few minutes, or always
 * when `reason` is given.
 */
export async function saveTimeline(
  db: D1Database,
  userId: string,
  projectId: string,
  baseRevision: number,
  timeline: Timeline,
  reason: string | null = null,
): Promise<SaveResult> {
  const doc = JSON.stringify(timeline);
  const now = nowIso();
  const res =
    baseRevision === 0
      ? await db
          .prepare(
            `INSERT INTO timelines (project_id, revision, doc, updated_at)
             SELECT id, 1, ?, ? FROM projects WHERE id = ? AND user_id = ?
             ON CONFLICT(project_id) DO NOTHING`,
          )
          .bind(doc, now, projectId, userId)
          .run()
      : await db
          .prepare(
            `UPDATE timelines SET revision = revision + 1, doc = ?, updated_at = ?
             WHERE project_id = ? AND revision = ? AND ${OWNED("project_id")}`,
          )
          .bind(doc, now, projectId, baseRevision, userId)
          .run();
  const current = await getTimeline(db, userId, projectId);
  if (res.meta.changes === 0 || !current) return { ok: false, current };
  await maybeSnapshot(db, projectId, current, reason ?? "autosave", reason !== null);
  return { ok: true, saved: current };
}

async function maybeSnapshot(
  db: D1Database,
  projectId: string,
  current: StoredTimelineRow,
  reason: string,
  force: boolean,
): Promise<void> {
  if (!force) {
    const last = await db
      .prepare(
        "SELECT created_at FROM timeline_revisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(projectId)
      .first<{ created_at: string }>();
    if (last && Date.now() - Date.parse(last.created_at) < SNAPSHOT_EVERY_MS) return;
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO timeline_revisions (id, project_id, revision, reason, doc, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, revision) DO NOTHING`,
      )
      .bind(
        newId(),
        projectId,
        current.revision,
        reason.slice(0, 40),
        JSON.stringify(current.timeline),
        nowIso(),
      ),
    db
      .prepare(
        `DELETE FROM timeline_revisions WHERE project_id = ? AND id NOT IN (
           SELECT id FROM timeline_revisions WHERE project_id = ?
           ORDER BY created_at DESC, revision DESC LIMIT ?)`,
      )
      .bind(projectId, projectId, MAX_TIMELINE_SNAPSHOTS),
  ]);
}

export async function listTimelineRevisions(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<TimelineRevision[]> {
  const { results } = await db
    .prepare(
      `SELECT revision, reason, created_at FROM timeline_revisions
       WHERE project_id = ? AND ${OWNED("project_id")} ORDER BY created_at DESC, revision DESC`,
    )
    .bind(projectId, userId)
    .all<TimelineRevision>();
  return results;
}

export async function getTimelineRevision(
  db: D1Database,
  userId: string,
  projectId: string,
  revision: number,
): Promise<Timeline | null> {
  const row = await db
    .prepare(
      `SELECT doc FROM timeline_revisions
       WHERE project_id = ? AND revision = ? AND ${OWNED("project_id")}`,
    )
    .bind(projectId, revision, userId)
    .first<{ doc: string }>();
  return row ? parseDoc(row.doc) : null;
}

/** Forgets a project's timeline and history (a new production replaces all its media). */
export async function deleteTimeline(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(`DELETE FROM timelines WHERE project_id = ? AND ${OWNED("project_id")}`)
      .bind(projectId, userId),
    db
      .prepare(`DELETE FROM timeline_revisions WHERE project_id = ? AND ${OWNED("project_id")}`)
      .bind(projectId, userId),
  ]);
}
