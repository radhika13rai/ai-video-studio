import { API_PATHS, API_PREFIX, MAX_RENDER_BYTES, VENDOR_FILES } from "@avs/contracts";
import { renderCompleteRequestSchema, type RenderManifest } from "@avs/schemas";
import {
  createAsset,
  deleteAsset,
  getAsset,
  getLatestWorkflowRun,
  listAssets,
  listScenes,
  requireProject,
  setProjectStatusIf,
} from "../db";
import type { Env } from "../env";
import { ApiError } from "../lib/errors";
import { jsonOk } from "../lib/http";
import { readJson } from "../lib/request";
import type { Router } from "../lib/router";
import { bytesReader, inspectMp4 } from "../quality/mp4";
import { RENDER_EVENT } from "../workflows/production-workflow";
import type { Ctx } from "./projects";

/** The render request the workflow is waiting for, from production_config. */
function renderRequestOf(config: Record<string, unknown>): string | null {
  const r = config.render_request;
  return r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string"
    ? (r as { id: string }).id
    : null;
}

export function registerRenderRoutes(router: Router<Ctx>): void {
  const base = `${API_PREFIX}/projects/:id/render`;

  /** Starts (or resumes) a browser render: moves the project to "rendering" and returns the manifest. */
  router.on("POST", base, async ({ db, user }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    const requestId = renderRequestOf(project.production_config);
    if (!requestId || !["awaiting_render", "rendering"].includes(project.status))
      throw new ApiError(
        409,
        "INVALID_STATE",
        `This project isn't ready to render (status: ${project.status}).`,
      );
    await setProjectStatusIf(db, user.id, projectId, ["awaiting_render"], "rendering");

    const run = await getLatestWorkflowRun(db, user.id, projectId);
    const runPrefix = run ? `projects/${projectId}/runs/${run.id}/` : null;
    const assets = (await listAssets(db, user.id, projectId)).filter(
      (a) => !runPrefix || a.storage_key.startsWith(runPrefix),
    );
    const url = (assetId: string) => API_PATHS.assetContent(projectId, assetId);
    let start = 0;
    const scenes = (await listScenes(db, user.id, projectId)).map((s) => {
      const image = assets.find((a) => a.scene_id === s.id && a.asset_type === "image");
      const voice = assets.find((a) => a.scene_id === s.id && a.asset_type === "voiceover");
      const scene = {
        scene_number: s.scene_number,
        start_seconds: Math.round(start * 1000) / 1000,
        duration_seconds: s.duration_seconds,
        visual_type: s.visual_type,
        caption: (s.voiceover ?? "").trim() || s.description,
        narration: (s.voiceover ?? "").trim() || null,
        image_url: image ? url(image.id) : null,
        voice_url: voice ? url(voice.id) : null,
      };
      start += s.duration_seconds;
      return scene;
    });
    if (scenes.length === 0)
      throw new ApiError(409, "INVALID_STATE", "This project has no scenes to render.");
    const fallbacks = Array.isArray(project.production_config.fallbacks)
      ? project.production_config.fallbacks.filter((f): f is string => typeof f === "string")
      : [];
    const manifest: RenderManifest = {
      render_request_id: requestId,
      project: {
        id: project.id,
        title: project.title,
        aspect_ratio: project.aspect_ratio as RenderManifest["project"]["aspect_ratio"],
        duration_seconds: start,
      },
      scenes,
      fallbacks,
    };
    return jsonOk(manifest);
  });

  /** Receives the finished MP4 (raw body) and stores it in R2 as the project's render asset. */
  router.on("POST", `${base}/upload`, async ({ request, url, env, db, user }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    const requestId = renderRequestOf(project.production_config);
    if (project.status !== "rendering" || !requestId)
      throw new ApiError(409, "INVALID_STATE", "Start the render before uploading.");
    if (url.searchParams.get("render_request_id") !== requestId)
      throw new ApiError(
        409,
        "INVALID_STATE",
        "This upload is for an old render request. Reload the page.",
      );
    if (!/^video\/mp4\b/i.test(request.headers.get("content-type") ?? ""))
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the video as video/mp4.");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_RENDER_BYTES)
      throw new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        `The video must be at most ${Math.round(MAX_RENDER_BYTES / 1048576)} MB.`,
      );
    if (!env.MEDIA)
      throw new ApiError(503, "INTERNAL_ERROR", "Media storage is not configured.", true);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_RENDER_BYTES)
      throw new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        `The video must be at most ${Math.round(MAX_RENDER_BYTES / 1048576)} MB.`,
      );
    // An MP4 starts with an `ftyp` box and must contain a readable video track.
    if (bytes.byteLength < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp")
      throw new ApiError(400, "VALIDATION_ERROR", "The upload isn't an MP4 file.");
    let info;
    try {
      info = await inspectMp4(bytesReader(bytes), bytes.byteLength);
    } catch (err) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        `The MP4 is damaged: ${err instanceof Error ? err.message : "unreadable"}.`,
      );
    }
    if (!info.tracks.some((t) => t.kind === "video"))
      throw new ApiError(400, "VALIDATION_ERROR", "The MP4 has no video track.");

    const run = await getLatestWorkflowRun(db, user.id, projectId);
    const storage_key = `projects/${projectId}/runs/${run?.id ?? "manual"}/final-${requestId.slice(0, 8)}.mp4`;
    for (const old of (await listAssets(db, user.id, projectId)).filter(
      (a) => a.asset_type === "render",
    )) {
      const { storage_key: key } = await deleteAsset(db, user.id, old.id);
      await env.MEDIA.delete(key);
    }
    await env.MEDIA.put(storage_key, bytes, { httpMetadata: { contentType: "video/mp4" } });
    const durationHeader = Number(request.headers.get("x-video-duration") ?? "");
    const asset = await createAsset(db, user.id, projectId, {
      asset_type: "render",
      storage_key,
      mime_type: "video/mp4",
      file_size: bytes.byteLength,
      source_provider: "browser-renderer",
      license: { source: "rendered" },
      metadata: {
        render_request_id: requestId,
        duration_seconds: Math.round(info.durationSeconds * 1000) / 1000,
        ...(Number.isFinite(durationHeader) && durationHeader > 0
          ? { reported_duration_seconds: durationHeader }
          : {}),
        encoder: (request.headers.get("x-video-encoder") ?? "").slice(0, 20),
      },
    });
    return jsonOk(asset, 201);
  });

  /** Tells the waiting workflow the video is ready (after checking ownership and identity). */
  router.on("POST", `${base}/complete`, async ({ request, env, db, user }, p) => {
    const projectId = p.id ?? "";
    const body = await readJson(request, renderCompleteRequestSchema);
    const project = await requireProject(db, user.id, projectId);
    const requestId = renderRequestOf(project.production_config);
    if (project.status !== "rendering" || body.render_request_id !== requestId)
      throw new ApiError(409, "INVALID_STATE", "This render request isn't active.");
    const asset = await getAsset(db, user.id, body.asset_id);
    if (
      !asset ||
      asset.project_id !== projectId ||
      asset.asset_type !== "render" ||
      asset.metadata.render_request_id !== requestId
    )
      throw new ApiError(400, "VALIDATION_ERROR", "That asset isn't this render's video.");
    const run = await getLatestWorkflowRun(db, user.id, projectId);
    if (!run?.workflow_instance_id || run.status !== "waiting" || !env.PRODUCTION_WORKFLOW)
      throw new ApiError(
        409,
        "INVALID_STATE",
        "No production run is waiting for this render. Generate again.",
      );
    try {
      const instance = await env.PRODUCTION_WORKFLOW.get(run.workflow_instance_id);
      await instance.sendEvent({
        type: RENDER_EVENT,
        payload: { render_request_id: requestId, asset_id: asset.id },
      });
    } catch (err) {
      console.error("sendEvent failed", err);
      throw new ApiError(
        409,
        "INVALID_STATE",
        "The production run is no longer waiting. Generate again.",
      );
    }
    return jsonOk({ project_id: projectId, status: "quality_check" }, 202);
  });

  /** The browser gave up (error or cancel): allow another attempt. */
  router.on("POST", `${base}/abort`, async ({ db, user }, p) => {
    const projectId = p.id ?? "";
    await requireProject(db, user.id, projectId);
    await setProjectStatusIf(db, user.id, projectId, ["rendering"], "awaiting_render");
    return jsonOk(await requireProject(db, user.id, projectId));
  });
}

/**
 * Serves the FFmpeg.wasm core (32 MB, over the 25 MiB static-asset limit) from R2. Public,
 * immutable and versioned; uploaded with `pnpm --filter @avs/api vendor:upload`.
 */
const VENDOR_BY_PATH = new Map(VENDOR_FILES.map((f) => [`/vendor/${f.path}`, f]));

/** Keys of vendor files that are not in R2 yet (reported by /health so deploys upload them). */
export async function missingVendorFiles(env: Env): Promise<string[]> {
  if (!env.MEDIA) return VENDOR_FILES.map((f) => f.path);
  const heads = await Promise.all(VENDOR_FILES.map((f) => env.MEDIA?.head(`vendor/${f.path}`)));
  return VENDOR_FILES.filter((_, i) => !heads[i]).map((f) => f.path);
}

/** Serves pinned third-party renderer files (FFmpeg core, ONNX runtime, models) from R2. */
export async function serveVendor(env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/vendor/")) return null;
  const file = VENDOR_BY_PATH.get(pathname);
  if (!file) return new Response("Not found", { status: 404 });
  const object = await env.MEDIA?.get(`vendor/${file.path}`);
  if (!object)
    return new Response(`${file.path} is not uploaded. Run: pnpm --filter @avs/api vendor:upload`, {
      status: 404,
    });
  return new Response(object.body, {
    headers: {
      "content-type": file.contentType,
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
