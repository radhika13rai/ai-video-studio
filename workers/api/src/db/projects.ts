import {
  createProjectRequestSchema,
  graphicsThemeSchema,
  type CreateProjectRequest,
  type GraphicsTheme,
} from "@avs/schemas";
import { PROJECT_STATUSES, type ProjectStatus } from "@avs/types";
import { z } from "zod";
import { invalidData, notFound } from "./errors";
import { jsonObject, type JsonObject } from "./schemas";
import { fromJson, newId, nowIso, toJson } from "./util";

interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  video_type: string;
  aspect_ratio: string;
  duration_seconds: number;
  target_platform: string;
  status: string;
  production_config: string;
  /** JSON (migration 0005); absent in rows read before it. */
  graphics_theme?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project extends Omit<
  ProjectRow,
  "production_config" | "status" | "graphics_theme"
> {
  status: ProjectStatus;
  production_config: JsonObject;
  /** The look of the project's graphics scenes (ADR 048); null when it has none. */
  graphics_theme: GraphicsTheme | null;
}

/** Parses stored theme JSON; anything malformed reads as no theme (the renderer's default). */
function parseTheme(text: string | null | undefined): GraphicsTheme | null {
  if (!text) return null;
  try {
    return graphicsThemeSchema.safeParse(JSON.parse(text)).data ?? null;
  } catch {
    return null;
  }
}

function toProject(row: ProjectRow): Project {
  const { graphics_theme, ...rest } = row;
  return {
    ...rest,
    status: z.enum(PROJECT_STATUSES).parse(row.status),
    production_config: fromJson(jsonObject, row.production_config, "production_config"),
    graphics_theme: parseTheme(graphics_theme),
  };
}

/** Sets (or clears) the project's graphics theme. */
export async function setProjectGraphicsTheme(
  db: D1Database,
  userId: string,
  projectId: string,
  theme: GraphicsTheme | null,
): Promise<void> {
  const parsed = theme === null ? null : graphicsThemeSchema.safeParse(theme);
  if (parsed && !parsed.success) throw invalidData("graphics theme is not valid");
  const res = await db
    .prepare("UPDATE projects SET graphics_theme = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(parsed ? JSON.stringify(parsed.data) : null, nowIso(), projectId, userId)
    .run();
  if (res.meta.changes === 0) throw notFound("project");
}

export async function createProject(
  db: D1Database,
  userId: string,
  input: CreateProjectRequest,
): Promise<Project> {
  const parsed = createProjectRequestSchema.safeParse(input);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid project");
  const p = parsed.data;
  const id = newId();
  const now = nowIso();
  const config = toJson(jsonObject, p.style ? { style: p.style } : {}, "production_config");
  await db
    .prepare(
      `INSERT INTO projects (id, user_id, title, prompt, video_type, aspect_ratio, duration_seconds,
         target_platform, status, production_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      p.title,
      p.prompt,
      p.video_type,
      p.aspect_ratio,
      p.duration_seconds,
      p.target_platform,
      config,
      now,
      now,
    )
    .run();
  const created = await getProject(db, userId, id);
  if (!created) throw new Error("project insert failed");
  return created;
}

/** Returns the project only if `userId` owns it; otherwise null (never reveals existence). */
export async function getProject(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<Project | null> {
  const row = await db
    .prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?")
    .bind(projectId, userId)
    .first<ProjectRow>();
  return row ? toProject(row) : null;
}

export async function requireProject(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<Project> {
  const project = await getProject(db, userId, projectId);
  if (!project) throw notFound("project");
  return project;
}

export interface ProjectPage {
  items: Project[];
  /** Opaque cursor for the next page, or null when there are no more. */
  next_cursor: string | null;
}

const cursorSchema = z.object({ c: z.string(), i: z.string() });

/** Lists the user's projects, newest first, with keyset pagination on (created_at, id). */
export async function listProjects(
  db: D1Database,
  userId: string,
  opts: { limit?: number; cursor?: string | null; status?: ProjectStatus } = {},
): Promise<ProjectPage> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const where = ["user_id = ?"];
  const binds: unknown[] = [userId];
  if (opts.status) {
    where.push("status = ?");
    binds.push(opts.status);
  }
  if (opts.cursor) {
    let cur: z.infer<typeof cursorSchema>;
    try {
      cur = cursorSchema.parse(JSON.parse(atob(opts.cursor)));
    } catch {
      throw invalidData("cursor is not valid");
    }
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(cur.c, cur.c, cur.i);
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM projects WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<ProjectRow>();
  const page = results.slice(0, limit).map(toProject);
  const last = page[page.length - 1];
  return {
    items: page,
    next_cursor:
      results.length > limit && last
        ? btoa(JSON.stringify({ c: last.created_at, i: last.id }))
        : null,
  };
}

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    status: z.enum(PROJECT_STATUSES),
    production_config: jsonObject,
  })
  .partial();
export type ProjectUpdate = z.infer<typeof updateSchema>;

export async function updateProject(
  db: D1Database,
  userId: string,
  projectId: string,
  patch: ProjectUpdate,
): Promise<Project> {
  const parsed = updateSchema.safeParse(patch);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid update");
  const sets: string[] = [];
  const binds: unknown[] = [];
  const u = parsed.data;
  if (u.title !== undefined) {
    sets.push("title = ?");
    binds.push(u.title);
  }
  if (u.status !== undefined) {
    sets.push("status = ?");
    binds.push(u.status);
  }
  if (u.production_config !== undefined) {
    sets.push("production_config = ?");
    binds.push(toJson(jsonObject, u.production_config, "production_config"));
  }
  sets.push("updated_at = ?");
  binds.push(nowIso());
  const res = await db
    .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...binds, projectId, userId)
    .run();
  if (res.meta.changes === 0) throw notFound("project");
  return requireProject(db, userId, projectId);
}

/** Deletes the project and (via ON DELETE CASCADE) its scenes, jobs, assets, runs and reports.
 * Returns the R2 keys of its assets so the caller can delete the media too. */
export async function deleteProject(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<{ storage_keys: string[]; workflow_instance_id: string | null }> {
  // Capture the active workflow in the same D1 batch as deletion. The batch is atomic,
  // so a workflow run cannot be inserted for a project after its row has been deleted.
  const [keys, runs, del] = await db.batch<{
    storage_key?: string;
    workflow_instance_id?: string | null;
  }>([
    db
      .prepare(
        "SELECT a.storage_key FROM assets a JOIN projects p ON p.id = a.project_id WHERE p.id = ? AND p.user_id = ?",
      )
      .bind(projectId, userId),
    db
      .prepare(
        `SELECT wr.workflow_instance_id
         FROM workflow_runs wr JOIN projects p ON p.id = wr.project_id
         WHERE p.id = ? AND p.user_id = ? AND wr.status IN ('queued', 'running', 'waiting')
         ORDER BY wr.created_at DESC, wr.id DESC LIMIT 1`,
      )
      .bind(projectId, userId),
    db.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").bind(projectId, userId),
  ]);
  if (!del || del.meta.changes === 0) throw notFound("project");
  return {
    storage_keys: (keys?.results ?? [])
      .map((r) => r.storage_key)
      .filter((key): key is string => typeof key === "string"),
    workflow_instance_id: runs?.results?.[0]?.workflow_instance_id ?? null,
  };
}

/**
 * Moves a project to `to` only if its status is one of `from`. Returns false when it wasn't
 * (another request or the workflow got there first). This is how status races are avoided.
 */
export async function setProjectStatusIf(
  db: D1Database,
  userId: string,
  projectId: string,
  from: readonly ProjectStatus[],
  to: ProjectStatus,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE projects SET status = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status IN (${from.map(() => "?").join(", ")})`,
    )
    .bind(to, nowIso(), projectId, userId, ...from)
    .run();
  return res.meta.changes === 1;
}

/**
 * Sets top-level keys of production_config (plan, fallbacks, render request …) in one atomic
 * UPDATE (json_set), so concurrent writers to different keys never overwrite each other.
 */
export async function mergeProductionConfig(
  db: D1Database,
  userId: string,
  projectId: string,
  patch: JsonObject,
): Promise<void> {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const setExpr = entries.reduce((acc) => `json_set(${acc}, ?, json(?))`, "production_config");
  const args = entries.flatMap(([k, v]) => [`$."${k.replace(/"/g, "")}"`, JSON.stringify(v)]);
  const res = await db
    .prepare(
      `UPDATE projects SET production_config = ${setExpr}, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(...args, nowIso(), projectId, userId)
    .run();
  if (res.meta.changes !== 1) throw notFound("project");
}

/** The browser render currently holding the project, from production_config.render_attempt. */
export interface RenderAttempt {
  token: string;
  started_at: string;
}

export function renderAttemptOf(config: JsonObject): RenderAttempt | null {
  const a = config.render_attempt;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const { token, started_at } = a as Record<string, unknown>;
  return typeof token === "string" && typeof started_at === "string" ? { token, started_at } : null;
}

/**
 * Atomically claims the project for one browser render and moves it to "rendering". Succeeds
 * when no render holds it, the holder started before `staleBefore` (lease expired), or
 * `takeover` is set. Returns false when another live render holds it.
 */
export async function claimRenderAttempt(
  db: D1Database,
  userId: string,
  projectId: string,
  attempt: RenderAttempt,
  staleBefore: string,
  takeover: boolean,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE projects
       SET status = 'rendering', updated_at = ?,
           production_config = json_set(production_config, '$.render_attempt', json(?))
       WHERE id = ? AND user_id = ? AND status IN ('awaiting_render', 'rendering')
         AND (status = 'awaiting_render'
              OR json_extract(production_config, '$.render_attempt.token') IS NULL
              OR json_extract(production_config, '$.render_attempt.started_at') < ?
              OR ? = 1)`,
    )
    .bind(nowIso(), JSON.stringify(attempt), projectId, userId, staleBefore, takeover ? 1 : 0)
    .run();
  return res.meta.changes === 1;
}

/**
 * Releases the render held by `token`. With `toStatus`, also moves the project from
 * "rendering" to that status (abort). Returns false if `token` doesn't hold the project.
 */
export async function releaseRenderAttempt(
  db: D1Database,
  userId: string,
  projectId: string,
  token: string,
  toStatus?: ProjectStatus,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE projects
       SET production_config = json_remove(production_config, '$.render_attempt'),
           status = ${toStatus ? "?" : "status"}, updated_at = ?
       WHERE id = ? AND user_id = ?
         AND json_extract(production_config, '$.render_attempt.token') = ?
         ${toStatus ? "AND status = 'rendering'" : ""}`,
    )
    .bind(...(toStatus ? [toStatus] : []), nowIso(), projectId, userId, token)
    .run();
  return res.meta.changes === 1;
}
