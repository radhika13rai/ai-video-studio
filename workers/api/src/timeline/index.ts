import { API_PATHS } from "@avs/contracts";
import {
  compileTimeline,
  timelineFromProduction,
  timelineSchema,
  type CompiledTimeline,
  type Timeline,
} from "@avs/schemas";
import type { AspectRatio } from "@avs/types";
import { productionBlueprintSchema } from "../creative/blueprint";
import {
  getLatestWorkflowRun,
  getTimeline,
  listAssets,
  listScenes,
  requireProject,
  type Asset,
  type Project,
  type Scene,
} from "../db";

/**
 * The server side of editable timelines (ADR 043): the default timeline a production implies,
 * reference checks for saved timelines, repair of references to replaced media, and compiling
 * to the render manifest.
 */

/**
 * The run that made the project's media: recorded when a run reaches the media stage, so a
 * later re-export run (which makes no media) doesn't hide it. Older projects: the latest run.
 */
export async function mediaRunId(
  db: D1Database,
  userId: string,
  project: Pick<Project, "id" | "production_config">,
): Promise<string | null> {
  const recorded = project.production_config.media_run_id;
  if (typeof recorded === "string" && recorded) return recorded;
  return (await getLatestWorkflowRun(db, userId, project.id))?.id ?? null;
}

/** The current media (older runs' files are deleted when a new run makes media). */
export async function currentMedia(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<{ scenes: Scene[]; assets: Asset[] }> {
  const runId = await mediaRunId(db, userId, await requireProject(db, userId, projectId));
  const prefix = runId ? `projects/${projectId}/runs/${runId}/` : null;
  const assets = (await listAssets(db, userId, projectId)).filter(
    (a) => a.asset_type !== "render" && (!prefix || a.storage_key.startsWith(prefix)),
  );
  return { scenes: await listScenes(db, userId, projectId), assets };
}

export function defaultTimeline(project: Project, scenes: Scene[], assets: Asset[]): Timeline {
  const bp = productionBlueprintSchema.safeParse(project.production_config.blueprint);
  return timelineFromProduction({
    aspect_ratio: project.aspect_ratio as AspectRatio,
    scenes,
    assets,
    directions: bp.success
      ? bp.data.scenes.map((s) => ({
          scene_number: s.scene_number,
          shot: s.shot,
          camera: s.camera,
          transition_in: s.transition_in,
          on_screen_text: s.on_screen_text,
        }))
      : [],
    music: bp.success ? { mood: bp.data.music.mood, tempo_bpm: bp.data.music.tempo_bpm } : null,
  });
}

const KIND = { image_asset_id: "image", video_asset_id: "video" } as const;

/**
 * Points references to media that no longer exists (a scene's image was regenerated) at that
 * scene's newest media of the same kind, or clears them. Returns the repaired timeline and
 * whether anything changed.
 */
export function repairTimeline(
  t: Timeline,
  assets: Asset[],
): { timeline: Timeline; changed: boolean } {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const newest = (sceneId: string, type: string) =>
    assets.filter((a) => a.scene_id === sceneId && a.asset_type === type).at(-1)?.id ?? null;
  let changed = false;
  const clips = t.clips.map((c) => {
    const next = { ...c, voice: { ...c.voice } };
    for (const key of ["image_asset_id", "video_asset_id"] as const) {
      const ref = c[key];
      if (ref && byId.get(ref)?.asset_type !== KIND[key]) {
        next[key] = newest(c.scene_id, KIND[key]);
        changed = true;
      }
    }
    if (c.voice.asset_id && byId.get(c.voice.asset_id)?.asset_type !== "voiceover") {
      next.voice.asset_id = newest(c.scene_id, "voiceover");
      if (!next.voice.asset_id && next.voice.mode === "asset") next.voice.mode = "kokoro";
      changed = true;
    }
    return next;
  });
  return { timeline: changed ? { ...t, clips } : t, changed };
}

/** Problems with a saved timeline's references, in plain language (empty when it's fine). */
export function referenceProblems(t: Timeline, scenes: Scene[], assets: Asset[]): string[] {
  const sceneIds = new Set(scenes.map((s) => s.id));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const problems: string[] = [];
  t.clips.forEach((c, i) => {
    const where = `Clip ${i + 1}`;
    if (!sceneIds.has(c.scene_id)) problems.push(`${where} refers to a scene not in this project.`);
    const check = (ref: string | null, type: string, what: string) => {
      if (ref && byId.get(ref)?.asset_type !== type)
        problems.push(`${where}'s ${what} isn't one of this project's ${type} files.`);
    };
    check(c.image_asset_id, "image", "image");
    check(c.video_asset_id, "video", "footage");
    check(c.voice.asset_id, "voiceover", "voice recording");
    if (c.voice.mode === "asset" && !c.voice.asset_id)
      problems.push(`${where} uses a voice recording but none is chosen.`);
  });
  return problems;
}

/** The project's timeline: the saved one (repaired) or the one its production implies. */
export async function currentTimeline(
  db: D1Database,
  userId: string,
  project: Project,
): Promise<{ revision: number; timeline: Timeline; updated_at: string | null; assets: Asset[] }> {
  const { scenes, assets } = await currentMedia(db, userId, project.id);
  const stored = await getTimeline(db, userId, project.id);
  if (!stored)
    return {
      revision: 0,
      timeline: defaultTimeline(project, scenes, assets),
      updated_at: null,
      assets,
    };
  return {
    revision: stored.revision,
    timeline: repairTimeline(stored.timeline, assets).timeline,
    updated_at: stored.updated_at,
    assets,
  };
}

/** Compiles a timeline into manifest scenes with the project's asset URLs and footage credits. */
export function compileForRender(
  projectId: string,
  timeline: Timeline,
  assets: Asset[],
): CompiledTimeline {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return compileTimeline(timeline, (id) => {
    const a = byId.get(id);
    if (!a) return null;
    const credit = typeof a.license?.credit === "string" ? a.license.credit : null;
    return { url: API_PATHS.assetContent(projectId, a.id), credit };
  });
}

/** Parses an untrusted timeline (from a request); returns the issues on failure. */
export function parseTimeline(
  raw: unknown,
): { ok: true; timeline: Timeline } | { ok: false; message: string } {
  const parsed = timelineSchema.safeParse(raw);
  if (parsed.success) return { ok: true, timeline: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") ?? "";
  return {
    ok: false,
    message: `${path ? `${path}: ` : ""}${issue?.message ?? "the timeline isn't valid"}`,
  };
}
