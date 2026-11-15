import { graphicsLayoutSchema, MAX_GRAPHICS_LAYOUT_BYTES, type GraphicsLayout } from "@avs/schemas";
import { LIMITS, SCENE_STATUSES, SCENE_VISUAL_TYPES, type SceneStatus } from "@avs/types";
import { z } from "zod";
import { invalidData, notFound } from "./errors";
import { requireProject } from "./projects";
import { newId, nowIso, OWNED } from "./util";

export interface Scene {
  id: string;
  project_id: string;
  scene_number: number;
  description: string;
  visual_prompt: string | null;
  voiceover: string | null;
  duration_seconds: number;
  visual_type: (typeof SCENE_VISUAL_TYPES)[number];
  status: SceneStatus;
  created_at: string;
  /** A graphics scene's layout (ADR 048); null for other scenes or when none was stored. */
  graphics_layout: GraphicsLayout | null;
}

type SceneRow = Omit<Scene, "graphics_layout"> & { graphics_layout?: string | null };

/** Stored layout JSON → layout; anything malformed reads as none (the renderer falls back). */
function parseLayout(text: string | null | undefined): GraphicsLayout | null {
  if (!text) return null;
  try {
    return graphicsLayoutSchema.safeParse(JSON.parse(text)).data ?? null;
  } catch {
    return null;
  }
}

const toScene = (row: SceneRow): Scene => ({
  ...row,
  graphics_layout: parseLayout(row.graphics_layout),
});

export const sceneInputSchema = z.object({
  scene_number: z.number().int().min(1).max(LIMITS.maxProjectScenes),
  description: z.string().trim().min(1).max(2000),
  visual_prompt: z.string().trim().max(2000).nullish(),
  voiceover: z.string().trim().max(2000).nullish(),
  duration_seconds: z.number().positive().max(LIMITS.maxVideoDurationSeconds).default(5),
  visual_type: z.enum(SCENE_VISUAL_TYPES).default("image"),
});
export type SceneInput = z.input<typeof sceneInputSchema>;

const scenesSchema = z
  .array(sceneInputSchema)
  .max(LIMITS.maxProjectScenes)
  .refine((s) => new Set(s.map((x) => x.scene_number)).size === s.length, {
    message: "scene numbers must be unique",
  });

/**
 * Replaces a project's storyboard atomically: the old scenes are deleted and the new ones inserted
 * in one D1 batch (a single transaction), so a failure leaves the previous storyboard intact.
 */
export async function replaceScenes(
  db: D1Database,
  userId: string,
  projectId: string,
  scenes: SceneInput[],
): Promise<Scene[]> {
  const parsed = scenesSchema.safeParse(scenes);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid scenes");
  await requireProject(db, userId, projectId);
  const now = nowIso();
  await db.batch([
    db
      .prepare(`DELETE FROM scenes WHERE project_id = ? AND ${OWNED("project_id")}`)
      .bind(projectId, userId),
    ...parsed.data.map((s) =>
      db
        .prepare(
          `INSERT INTO scenes (id, project_id, scene_number, description, visual_prompt, voiceover,
             duration_seconds, visual_type, status, created_at)
           SELECT ?, id, ?, ?, ?, ?, ?, ?, 'pending', ? FROM projects WHERE id = ? AND user_id = ?`,
        )
        .bind(
          newId(),
          s.scene_number,
          s.description,
          s.visual_prompt ?? null,
          s.voiceover ?? null,
          s.duration_seconds,
          s.visual_type,
          now,
          projectId,
          userId,
        ),
    ),
  ]);
  return listScenes(db, userId, projectId);
}

export async function listScenes(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<Scene[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM scenes WHERE project_id = ? AND ${OWNED("project_id")} ORDER BY scene_number`,
    )
    .bind(projectId, userId)
    .all<SceneRow>();
  return results.map(toScene);
}

/**
 * Stores graphics layouts by scene number (ADR 048). Each must be a valid layout of at most
 * MAX_GRAPHICS_LAYOUT_BYTES of JSON; null clears a scene's layout.
 */
export async function setSceneGraphicsLayouts(
  db: D1Database,
  userId: string,
  projectId: string,
  items: { scene_number: number; layout: GraphicsLayout | null }[],
): Promise<void> {
  await requireProject(db, userId, projectId);
  const statements = items.map((item) => {
    let json: string | null = null;
    if (item.layout !== null) {
      const parsed = graphicsLayoutSchema.safeParse(item.layout);
      if (!parsed.success)
        throw invalidData(
          `scene ${item.scene_number} layout: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
      json = JSON.stringify(parsed.data);
      if (new TextEncoder().encode(json).length > MAX_GRAPHICS_LAYOUT_BYTES)
        throw invalidData(`scene ${item.scene_number} layout is over 8 KB`);
    }
    return db
      .prepare(
        `UPDATE scenes SET graphics_layout = ? WHERE project_id = ? AND scene_number = ? AND ${OWNED("project_id")}`,
      )
      .bind(json, projectId, item.scene_number, userId);
  });
  if (statements.length) await db.batch(statements);
}

export async function updateSceneStatus(
  db: D1Database,
  userId: string,
  sceneId: string,
  status: SceneStatus,
): Promise<void> {
  const s = z.enum(SCENE_STATUSES).safeParse(status);
  if (!s.success) throw invalidData("scene status is not valid");
  const res = await db
    .prepare(`UPDATE scenes SET status = ? WHERE id = ? AND ${OWNED("project_id")}`)
    .bind(s.data, sceneId, userId)
    .run();
  if (res.meta.changes === 0) throw notFound("scene");
}
