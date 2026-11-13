import type { AspectRatio } from "@avs/types";
import { createAsset, deleteAsset, listAssets, listScenes, updateSceneStatus } from "../db";
import type { Env } from "../env";
import { generateMedia, NoProviderError } from "../providers/registry";
import type { MediaCapability } from "../providers/types";
import { runAgentJob, type StepContext } from "./steps";

export interface SceneRef {
  id: string;
  scene_number: number;
  visual_prompt: string | null;
  voiceover: string | null;
  visual_type: string;
}

export type MediaOutcome =
  | { status: "ok"; asset_id: string; provider: string }
  | { status: "skipped"; reason: string }
  | { status: "fallback"; reason: string };

const runPrefix = (ctx: StepContext) => `projects/${ctx.projectId}/runs/${ctx.runId}/`;

/** Removes media from earlier runs (rows and R2 objects) and returns this run's scenes. */
export async function prepareMediaStage(ctx: StepContext, env: Env): Promise<SceneRef[]> {
  const prefix = runPrefix(ctx);
  for (const asset of await listAssets(ctx.db, ctx.userId, ctx.projectId)) {
    if (asset.storage_key.startsWith(prefix)) continue;
    const { storage_key } = await deleteAsset(ctx.db, ctx.userId, asset.id);
    await env.MEDIA?.delete(storage_key);
  }
  const scenes = await listScenes(ctx.db, ctx.userId, ctx.projectId);
  return scenes.map((s) => ({
    id: s.id,
    scene_number: s.scene_number,
    visual_prompt: s.visual_prompt,
    voiceover: s.voiceover,
    visual_type: s.visual_type,
  }));
}

const AGENT: Record<MediaCapability, string> = { image: "visual-artist", voice: "voice-director" };

/**
 * Generates one scene's image or narration, stores it in R2 and records the asset, as a tracked
 * job. Idempotent: a retried step finds the asset already saved. When every provider is out of
 * quota or missing, it returns a fallback instead of failing the whole production.
 */
export async function produceSceneMedia(
  ctx: StepContext,
  env: Env,
  scene: SceneRef,
  capability: MediaCapability,
  aspect: AspectRatio,
): Promise<MediaOutcome> {
  if (capability === "image" && (scene.visual_type === "text" || !scene.visual_prompt))
    return { status: "skipped", reason: "Scene is a text card by design." };
  if (capability === "voice" && !scene.voiceover?.trim())
    return { status: "skipped", reason: "Scene has no narration." };

  const keyStem = `${runPrefix(ctx)}scene-${scene.scene_number}-${capability}.`;
  const existing = (await listAssets(ctx.db, ctx.userId, ctx.projectId)).find((a) =>
    a.storage_key.startsWith(keyStem),
  );
  if (existing)
    return { status: "ok", asset_id: existing.id, provider: existing.source_provider ?? "" };
  if (!env.MEDIA) return { status: "fallback", reason: "Media storage (R2) isn't configured." };
  const media = env.MEDIA;

  return runAgentJob<MediaOutcome>(
    ctx,
    AGENT[capability],
    capability === "image" ? "generate_image" : "generate_voiceover",
    null,
    async () => {
      try {
        const { result, provider, attempts } = await generateMedia(
          ctx.db,
          env,
          { userId: ctx.userId, projectId: ctx.projectId },
          capability === "image"
            ? { capability, prompt: scene.visual_prompt ?? "", aspect_ratio: aspect }
            : { capability, text: scene.voiceover ?? "" },
        );
        const storage_key = `${keyStem}${result.extension}`;
        await media.put(storage_key, result.bytes, {
          httpMetadata: { contentType: result.mime_type },
        });
        const asset = await createAsset(ctx.db, ctx.userId, ctx.projectId, {
          asset_type: capability === "image" ? "image" : "voiceover",
          storage_key,
          mime_type: result.mime_type,
          file_size: result.bytes.byteLength,
          scene_id: scene.id,
          source_provider: provider,
          license: { source: "generated", provider, model: result.model },
          metadata: {
            model: result.model,
            ...(result.width ? { width: result.width, height: result.height } : {}),
            ...(result.duration_seconds ? { duration_seconds: result.duration_seconds } : {}),
            attempts,
          },
        });
        const outcome: MediaOutcome = { status: "ok", asset_id: asset.id, provider };
        return {
          output: outcome,
          meta: { agent: AGENT[capability], model: result.model, attempts: 1 },
        };
      } catch (err) {
        if (err instanceof NoProviderError && !err.retryable) {
          const outcome: MediaOutcome = { status: "fallback", reason: err.message };
          return {
            output: outcome,
            meta: { agent: AGENT[capability], model: "none", attempts: 1 },
          };
        }
        throw err; // transient: the job is re-queued and the workflow retries the step
      }
    },
    { jobKey: `${AGENT[capability]}:${scene.scene_number}`, sceneId: scene.id },
  );
}

export async function markSceneReady(ctx: StepContext, sceneId: string): Promise<void> {
  await updateSceneStatus(ctx.db, ctx.userId, sceneId, "ready");
}

/** Plain-language notes about anything that didn't go as the brief asked. */
export function summarizeFallbacks(
  visualStyle: "image" | "video" | "animation",
  narration: boolean,
  outcomes: { scene: number; image: MediaOutcome; voice: MediaOutcome }[],
): string[] {
  const notes: string[] = [];
  if (visualStyle !== "image")
    notes.push(
      `No ${visualStyle} generator is available on the free tier; scenes use generated still images with motion effects instead.`,
    );
  const noImage = outcomes.filter((o) => o.image.status === "fallback");
  if (noImage.length > 0)
    notes.push(
      `${noImage.length} of ${outcomes.length} scenes have no generated image (${reasonOf(noImage[0]?.image)}); they will render as styled text cards.`,
    );
  const noVoice = outcomes.filter((o) => o.voice.status === "fallback");
  if (narration && noVoice.length > 0)
    notes.push(
      `${noVoice.length} of ${outcomes.length} scenes have no narration audio (${reasonOf(noVoice[0]?.voice)}); captions will carry the script.`,
    );
  return notes;
}

const reasonOf = (o: MediaOutcome | undefined) =>
  o && o.status !== "ok" ? o.reason.replace(/\.$/, "") : "unknown reason";
