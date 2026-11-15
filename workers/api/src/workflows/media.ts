import type { AspectRatio } from "@avs/types";
import {
  createAsset,
  deleteAsset,
  deleteTimeline,
  mergeProductionConfig,
  listAssets,
  listScenes,
  updateSceneStatus,
} from "../db";
import type { Env } from "../env";
import { generateMedia, hasCodeProvider, NoProviderError } from "../providers/registry";
import type { MediaRequest } from "../providers/types";
import { runMediaJob, type JobSteps } from "./media-jobs";
import { stockQuery } from "../providers/pexels";

/** The per-scene media the production workflow makes. */
type MediaCapability = "image" | "voice" | "video";
import { runAgentJob, type StepContext } from "./steps";

export interface SceneRef {
  id: string;
  scene_number: number;
  visual_prompt: string | null;
  voiceover: string | null;
  visual_type: string;
  /** Present for runs prepared after stock video was added. */
  description?: string;
  duration_seconds?: number;
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
  await deleteTimeline(ctx.db, ctx.userId, ctx.projectId);
  await mergeProductionConfig(ctx.db, ctx.userId, ctx.projectId, { media_run_id: ctx.runId });
  const scenes = await listScenes(ctx.db, ctx.userId, ctx.projectId);
  return scenes.map((s) => ({
    id: s.id,
    scene_number: s.scene_number,
    visual_prompt: s.visual_prompt,
    voiceover: s.voiceover,
    visual_type: s.visual_type,
    description: s.description,
    duration_seconds: s.duration_seconds,
  }));
}

/** Narration with no server voice provider is voiced by Kokoro in the browser at render time. */
export const BROWSER_VOICE_REASON =
  "Narration is voiced in the browser (Kokoro) when the video renders.";

const AGENT: Record<MediaCapability, string> = {
  image: "visual-artist",
  voice: "voice-director",
  video: "footage-scout",
};
const JOB_TYPE: Record<MediaCapability, string> = {
  image: "generate_image",
  voice: "generate_voiceover",
  video: "find_stock_video",
};
const ASSET_TYPE: Record<MediaCapability, "image" | "voiceover" | "video"> = {
  image: "image",
  voice: "voiceover",
  video: "video",
};

/** The typed provider request for one scene's medium. */
function requestFor(
  scene: SceneRef,
  capability: MediaCapability,
  aspect: AspectRatio,
): MediaRequest {
  if (capability === "image")
    return { capability, prompt: scene.visual_prompt ?? "", aspect_ratio: aspect };
  if (capability === "voice") return { capability, text: scene.voiceover ?? "" };
  return {
    capability,
    prompt: stockQuery(scene.description || scene.visual_prompt || ""),
    aspect_ratio: aspect,
    duration_seconds: scene.duration_seconds ?? 5,
  };
}

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
  if (capability !== "voice" && (scene.visual_type === "text" || !scene.visual_prompt))
    return { status: "skipped", reason: "Scene is a text card by design." };
  if (capability === "voice" && !scene.voiceover?.trim())
    return { status: "skipped", reason: "Scene has no narration." };
  if (capability === "voice" && !hasCodeProvider(env, "voice"))
    return { status: "skipped", reason: BROWSER_VOICE_REASON };
  if (capability === "video" && !stockQuery(scene.description || scene.visual_prompt || ""))
    return { status: "fallback", reason: "Nothing to search stock footage for." };

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
    JOB_TYPE[capability],
    null,
    async () => {
      try {
        const { result, provider, attempts } = await generateMedia(
          ctx.db,
          env,
          { userId: ctx.userId, projectId: ctx.projectId },
          requestFor(scene, capability, aspect),
        );
        const storage_key = `${keyStem}${result.extension}`;
        await media.put(storage_key, result.bytes, {
          httpMetadata: { contentType: result.mime_type },
        });
        const asset = await createAsset(ctx.db, ctx.userId, ctx.projectId, {
          asset_type: ASSET_TYPE[capability],
          storage_key,
          mime_type: result.mime_type,
          file_size: result.bytes.byteLength,
          scene_id: scene.id,
          source_provider: provider,
          license: result.license ?? { source: "generated", provider, model: result.model },
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

/**
 * Animates a scene's generated image with a paid image-to-video provider (ADR 042), as a
 * long-running job: submit, wait, poll, fall over. The clip is stored next to the image, which
 * stays as the fallback. Returns a fallback (never throws) when no provider can do it.
 */
export async function animateSceneImage(
  step: JobSteps,
  ctx: StepContext,
  env: Env,
  scene: SceneRef,
  imageAssetId: string,
  aspect: AspectRatio,
): Promise<MediaOutcome> {
  const media = env.MEDIA;
  if (!media) return { status: "fallback", reason: "Media storage (R2) isn't configured." };
  const key = `${runPrefix(ctx)}scene-${scene.scene_number}-video.mp4`;
  const out = await runMediaJob(
    step,
    { db: ctx.db, env, owner: { userId: ctx.userId, projectId: ctx.projectId } },
    `animate-scene-${scene.scene_number}`,
    async () => {
      const asset = (await listAssets(ctx.db, ctx.userId, ctx.projectId)).find(
        (a) => a.id === imageAssetId,
      );
      const object = asset ? await media.get(asset.storage_key) : null;
      if (!asset || !object) throw new Error("The scene's image is missing.");
      return {
        capability: "image_to_video",
        prompt:
          `${scene.visual_prompt ?? scene.description ?? ""}. Subtle natural motion, smooth cinematic camera movement.`.slice(
            0,
            800,
          ),
        aspect_ratio: aspect,
        duration_seconds: (scene.duration_seconds ?? 5) > 5 ? 10 : 5,
        image: { bytes: new Uint8Array(await object.arrayBuffer()), mime_type: asset.mime_type },
      };
    },
    async (result, jobId) => {
      // Idempotent: a repeated poll after a crash finds the clip already saved.
      const existing = (await listAssets(ctx.db, ctx.userId, ctx.projectId)).find(
        (a) => a.storage_key === key,
      );
      if (existing) return key;
      await media.put(key, result.bytes, { httpMetadata: { contentType: result.mime_type } });
      await createAsset(ctx.db, ctx.userId, ctx.projectId, {
        asset_type: "video",
        storage_key: key,
        mime_type: result.mime_type,
        file_size: result.bytes.byteLength,
        scene_id: scene.id,
        source_provider: result.license?.provider ?? "image-to-video",
        license: result.license ?? { source: "generated", model: result.model },
        metadata: {
          model: result.model,
          provider_job_id: jobId,
          animated_from: imageAssetId,
          ...(result.duration_seconds ? { duration_seconds: result.duration_seconds } : {}),
        },
      });
      return key;
    },
  );
  if (out.status === "fallback") return out;
  const asset = (await listAssets(ctx.db, ctx.userId, ctx.projectId)).find(
    (a) => a.storage_key === key,
  );
  return asset
    ? { status: "ok", asset_id: asset.id, provider: out.provider }
    : { status: "fallback", reason: "The animated clip wasn't saved." };
}

export async function markSceneReady(ctx: StepContext, sceneId: string): Promise<void> {
  await updateSceneStatus(ctx.db, ctx.userId, sceneId, "ready");
}

export interface SceneOutcome {
  scene: number;
  image: MediaOutcome;
  voice: MediaOutcome;
  /** Stock footage (video-style projects; absent for older runs). */
  video?: MediaOutcome;
  /** Paid image-to-video animation of the scene's image, when switched on. */
  animated?: MediaOutcome;
}

/** Plain-language notes about anything that didn't go as the brief asked. */
export function summarizeFallbacks(
  visualStyle: "image" | "video" | "animation",
  narration: boolean,
  outcomes: SceneOutcome[],
): string[] {
  const notes: string[] = [];
  const tried = (o: MediaOutcome | undefined) => !!o && o.status !== "skipped";
  const triedVideo = outcomes.filter((o) => tried(o.video));
  const triedAnimation = outcomes.filter((o) => tried(o.animated));
  // A scene has real motion with stock footage or an animated image.
  const moving = (o: SceneOutcome) => o.video?.status === "ok" || o.animated?.status === "ok";
  if (visualStyle === "video" && triedAnimation.length > 0) {
    const eligible = outcomes.filter((o) => tried(o.video) || tried(o.animated));
    const failed = eligible.find((o) => !moving(o));
    if (failed)
      notes.push(
        `${eligible.filter(moving).length} of ${eligible.length} scenes have real motion (stock footage or an animated image); the others use generated still images with motion effects (${reasonOf(failed.animated?.status === "fallback" ? failed.animated : failed.video)}).`,
      );
  } else if (visualStyle === "video" && triedVideo.length > 0) {
    const withVideo = triedVideo.filter((o) => o.video?.status === "ok");
    if (withVideo.length < triedVideo.length)
      notes.push(
        `${withVideo.length} of ${triedVideo.length} scenes use stock footage from Pexels; the others use generated still images with motion effects (${reasonOf(triedVideo.find((o) => o.video?.status !== "ok")?.video)}).`,
      );
  } else if (visualStyle !== "image")
    notes.push(
      visualStyle === "video"
        ? "No video source is set up (add a free Pexels key for stock footage); scenes use generated still images with motion effects instead."
        : "No animation generator is available on the free tier; scenes use generated still images with motion effects instead.",
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

/**
 * Regenerates one scene's image and/or narration on demand ("retry this scene"), replacing
 * whatever that scene had. Other scenes are untouched. Each attempt is a tracked job.
 */
export async function regenerateSceneMedia(
  ctx: StepContext,
  env: Env,
  scene: SceneRef,
  aspect: AspectRatio,
  capabilities: ("image" | "voice")[],
): Promise<Record<"image" | "voice", MediaOutcome | undefined>> {
  const out: Record<"image" | "voice", MediaOutcome | undefined> = {
    image: undefined,
    voice: undefined,
  };
  const attempt = crypto.randomUUID().slice(0, 8);
  for (const capability of capabilities) {
    if (capability === "image" && (scene.visual_type === "text" || !scene.visual_prompt)) {
      out.image = { status: "skipped", reason: "Scene is a text card by design." };
      continue;
    }
    if (capability === "voice" && !scene.voiceover?.trim()) {
      out.voice = { status: "skipped", reason: "Scene has no narration." };
      continue;
    }
    if (capability === "voice" && !hasCodeProvider(env, "voice")) {
      out.voice = { status: "skipped", reason: BROWSER_VOICE_REASON };
      continue;
    }
    if (!env.MEDIA) {
      out[capability] = { status: "fallback", reason: "Media storage (R2) isn't configured." };
      continue;
    }
    const media = env.MEDIA;
    out[capability] = await runAgentJob<MediaOutcome>(
      ctx,
      AGENT[capability],
      capability === "image" ? "regenerate_image" : "regenerate_voiceover",
      null,
      async () => {
        try {
          const { result, provider, attempts } = await generateMedia(
            ctx.db,
            env,
            { userId: ctx.userId, projectId: ctx.projectId },
            requestFor(scene, capability, aspect),
          );
          // Only replace the old file once the new one exists.
          const type = capability === "image" ? "image" : "voiceover";
          for (const old of (await listAssets(ctx.db, ctx.userId, ctx.projectId)).filter(
            (a) => a.scene_id === scene.id && a.asset_type === type,
          )) {
            const { storage_key } = await deleteAsset(ctx.db, ctx.userId, old.id);
            await media.delete(storage_key);
          }
          const storage_key = `${runPrefix(ctx)}scene-${scene.scene_number}-${capability}-retry-${attempt}.${result.extension}`;
          await media.put(storage_key, result.bytes, {
            httpMetadata: { contentType: result.mime_type },
          });
          const asset = await createAsset(ctx.db, ctx.userId, ctx.projectId, {
            asset_type: type,
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
              retried: true,
            },
          });
          return {
            output: { status: "ok", asset_id: asset.id, provider },
            meta: { agent: AGENT[capability], model: result.model, attempts: 1 },
          };
        } catch (err) {
          if (err instanceof NoProviderError)
            return {
              output: { status: "fallback", reason: err.message },
              meta: { agent: AGENT[capability], model: "none", attempts: 1 },
            };
          throw err;
        }
      },
      { jobKey: `${AGENT[capability]}:${scene.scene_number}:retry:${attempt}`, sceneId: scene.id },
    );
  }
  return out;
}

/** Rebuilds the fallback notes from the assets that exist now (after a retry). */
export async function refreshFallbacks(
  ctx: StepContext,
  visualStyle: "image" | "video" | "animation",
  narration: boolean,
  env: Env,
): Promise<string[]> {
  const browserVoice = !hasCodeProvider(env, "voice");
  const scenes = await listScenes(ctx.db, ctx.userId, ctx.projectId);
  const assets = await listAssets(ctx.db, ctx.userId, ctx.projectId);
  const outcomes = scenes.map((s) => {
    const has = (t: string) => assets.some((a) => a.scene_id === s.id && a.asset_type === t);
    const image: MediaOutcome =
      s.visual_type === "text" || !s.visual_prompt
        ? { status: "skipped", reason: "text card" }
        : has("image")
          ? { status: "ok", asset_id: "", provider: "" }
          : { status: "fallback", reason: "no image was generated" };
    const voice: MediaOutcome = !s.voiceover?.trim()
      ? { status: "skipped", reason: "no narration" }
      : browserVoice
        ? { status: "skipped", reason: BROWSER_VOICE_REASON }
        : has("voiceover")
          ? { status: "ok", asset_id: "", provider: "" }
          : { status: "fallback", reason: "no narration was generated" };
    return { scene: s.scene_number, image, voice };
  });
  return summarizeFallbacks(visualStyle, narration, outcomes);
}

/** Generated versions kept per scene and kind (so undo in the editor still finds them). */
export const MAX_SCENE_VERSIONS = 3;

/**
 * A new version of one scene's picture (ADR 047): a fresh image (optionally from an edited
 * prompt) or a fresh stock clip. Earlier versions are kept, so the editor can switch back or
 * undo; beyond MAX_SCENE_VERSIONS the oldest ones the saved timeline doesn't use are deleted.
 */
export async function regenerateSceneVersion(
  ctx: StepContext,
  env: Env,
  scene: SceneRef & { description: string; duration_seconds: number },
  what: "image" | "footage",
  prompt: string | null,
  aspect: AspectRatio,
  keep: ReadonlySet<string>,
): Promise<{ outcome: MediaOutcome; asset_id: string | null }> {
  const media = env.MEDIA;
  if (!media)
    return {
      outcome: { status: "fallback", reason: "Media storage (R2) isn't configured." },
      asset_id: null,
    };
  const capability = what === "image" ? "image" : "video";
  const text = (prompt ?? "").trim();
  const request: MediaRequest =
    capability === "image"
      ? {
          capability,
          prompt: text || scene.visual_prompt || scene.description,
          aspect_ratio: aspect,
        }
      : {
          capability,
          prompt: stockQuery(text || scene.description || scene.visual_prompt || ""),
          aspect_ratio: aspect,
          duration_seconds: scene.duration_seconds,
          // "Another clip": skip the ones this scene already has.
          avoid: (await listAssets(ctx.db, ctx.userId, ctx.projectId))
            .filter((a) => a.scene_id === scene.id && a.asset_type === "video")
            .map((a) => (typeof a.metadata.model === "string" ? a.metadata.model : ""))
            .filter(Boolean),
        };
  const version = crypto.randomUUID().slice(0, 8);
  const outcome = await runAgentJob<MediaOutcome>(
    ctx,
    AGENT[capability],
    capability === "image" ? "regenerate_image" : "find_other_stock_video",
    null,
    async () => {
      try {
        const { result, provider, attempts } = await generateMedia(
          ctx.db,
          env,
          { userId: ctx.userId, projectId: ctx.projectId },
          request,
        );
        const storage_key = `${runPrefix(ctx)}scene-${scene.scene_number}-${capability}-v${version}.${result.extension}`;
        await media.put(storage_key, result.bytes, {
          httpMetadata: { contentType: result.mime_type },
        });
        const asset = await createAsset(ctx.db, ctx.userId, ctx.projectId, {
          asset_type: ASSET_TYPE[capability],
          storage_key,
          mime_type: result.mime_type,
          file_size: result.bytes.byteLength,
          scene_id: scene.id,
          source_provider: provider,
          license: result.license ?? { source: "generated", provider, model: result.model },
          metadata: {
            model: result.model,
            version: true,
            ...(text ? { prompt: text.slice(0, 1000) } : {}),
            ...(result.width ? { width: result.width, height: result.height } : {}),
            ...(result.duration_seconds ? { duration_seconds: result.duration_seconds } : {}),
            attempts,
          },
        });
        return {
          output: { status: "ok", asset_id: asset.id, provider },
          meta: { agent: AGENT[capability], model: result.model, attempts: 1 },
        };
      } catch (err) {
        if (err instanceof NoProviderError)
          return {
            output: { status: "fallback", reason: err.message },
            meta: { agent: AGENT[capability], model: "none", attempts: 1 },
          };
        throw err;
      }
    },
    { jobKey: `${AGENT[capability]}:${scene.scene_number}:version:${version}`, sceneId: scene.id },
  );
  if (outcome.status === "ok")
    await pruneSceneVersions(
      ctx,
      media,
      scene.id,
      ASSET_TYPE[capability],
      new Set([...keep, outcome.asset_id]),
    );
  return { outcome, asset_id: outcome.status === "ok" ? outcome.asset_id : null };
}

/** Deletes a scene's oldest versions of one kind beyond the limit, sparing those in `keep`. */
export async function pruneSceneVersions(
  ctx: StepContext,
  media: R2Bucket,
  sceneId: string,
  type: "image" | "voiceover" | "video",
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const versions = (await listAssets(ctx.db, ctx.userId, ctx.projectId)).filter(
    (a) => a.scene_id === sceneId && a.asset_type === type,
  );
  const removable = versions
    .slice(0, Math.max(0, versions.length - MAX_SCENE_VERSIONS))
    .filter((a) => !keep.has(a.id));
  for (const old of removable) {
    const { storage_key } = await deleteAsset(ctx.db, ctx.userId, old.id);
    await media.delete(storage_key);
  }
  return removable.map((a) => a.id);
}
