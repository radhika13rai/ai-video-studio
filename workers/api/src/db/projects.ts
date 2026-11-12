import { createProjectRequestSchema, type CreateProjectRequest } from "@avs/schemas";
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
  created_at: string;
  updated_at: string;
}

export interface Project extends Omit<ProjectRow, "production_config" | "status"> {
  status: ProjectStatus;
  production_config: JsonObject;
}

function toProject(row: ProjectRow): Project {
  return {
    ...row,
    status: z.enum(PROJECT_STATUSES).parse(row.status),
    production_config: fromJson(jsonObject, row.production_config, "production_config"),
  };
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
): Promise<{ storage_keys: string[] }> {
  const [keys, del] = await db.batch<{ storage_key: string }>([
    db
      .prepare(
        "SELECT a.storage_key FROM assets a JOIN projects p ON p.id = a.project_id WHERE p.id = ? AND p.user_id = ?",
      )
      .bind(projectId, userId),
    db.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").bind(projectId, userId),
  ]);
  if (!del || del.meta.changes === 0) throw notFound("project");
  return { storage_keys: (keys?.results ?? []).map((r) => r.storage_key) };
}
