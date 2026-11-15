import {
  API_PREFIX,
  MAX_RENDER_BYTES,
  RENDER_ATTEMPT_HEADER,
  RENDER_LEASE_MINUTES,
  VENDOR_FILES,
} from "@avs/contracts";
import { renderCompleteRequestSchema, type RenderManifest } from "@avs/schemas";
import {
  claimRenderAttempt,
  createAsset,
  deleteAsset,
  getAsset,
  getLatestWorkflowRun,
  listAssets,
  releaseRenderAttempt,
  renderAttemptOf,
  requireProject,
  type Project,
} from "../db";
import type { Env } from "../env";
import { ApiError } from "../lib/errors";
import { jsonOk } from "../lib/http";
import { readJson } from "../lib/request";
import type { Router } from "../lib/router";
import { inspectMp4, r2Reader } from "../quality/mp4";
import { compileForRender, currentTimeline } from "../timeline";
import { RENDER_EVENT } from "../workflows/production-workflow";
import type { Ctx } from "./projects";

/** The render request the workflow is waiting for, from production_config. */
function renderRequestOf(config: Record<string, unknown>): string | null {
  const r = config.render_request;
  return r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string"
    ? (r as { id: string }).id
    : null;
}

const LEASE_MS = RENDER_LEASE_MINUTES * 60_000;

/** The caller's attempt token must be the one holding the project, or the request is stale. */
function requireAttempt(project: Project, request: Request): string {
  const token = request.headers.get(RENDER_ATTEMPT_HEADER) ?? "";
  const held = renderAttemptOf(project.production_config);
  if (!token || !held || held.token !== token)
    throw new ApiError(
      409,
      "CONFLICT",
      "This render was replaced by another render of this project (another tab or device). Reload the page.",
    );
  return token;
}

const BAD_UPLOAD = (why: string) => new ApiError(400, "VALIDATION_ERROR", why);

export function registerRenderRoutes(router: Router<Ctx>): void {
  const base = `${API_PREFIX}/projects/:id/render`;

  /** Starts (or resumes) a browser render: moves the project to "rendering" and returns the manifest. */
  router.on("POST", base, async ({ db, user, url: reqUrl }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    const requestId = renderRequestOf(project.production_config);
    if (!requestId || !["awaiting_render", "rendering"].includes(project.status))
      throw new ApiError(
        409,
        "INVALID_STATE",
        `This project isn't ready to render (status: ${project.status}).`,
      );
    // One render at a time: claim the project atomically for this attempt.
    const attempt = { token: crypto.randomUUID(), started_at: new Date().toISOString() };
    const takeover = reqUrl.searchParams.get("takeover") === "1";
    const staleBefore = new Date(Date.now() - LEASE_MS).toISOString();
    if (!(await claimRenderAttempt(db, user.id, projectId, attempt, staleBefore, takeover))) {
      const held = renderAttemptOf(
        (await requireProject(db, user.id, projectId)).production_config,
      );
      const mins = held
        ? Math.max(1, Math.round((Date.now() - Date.parse(held.started_at)) / 60_000))
        : null;
      throw new ApiError(
        409,
        "CONFLICT",
        `This video is already rendering in another tab or device${mins ? ` (started ${mins} min ago)` : ""}. Wait for it, or start anyway to replace it.`,
      );
    }

    // The render plan comes from the project's timeline: the saved edit, or the one its
    // production implies (which renders exactly as before the editor existed).
    const { timeline, assets } = await currentTimeline(db, user.id, project);
    const compiled = compileForRender(projectId, timeline, assets);
    const scenes = compiled.scenes;
    if (scenes.length === 0)
      throw new ApiError(409, "INVALID_STATE", "This project has no scenes to render.");
    const fallbacks = Array.isArray(project.production_config.fallbacks)
      ? project.production_config.fallbacks.filter((f): f is string => typeof f === "string")
      : [];
    const manifest: RenderManifest = {
      render_request_id: requestId,
      render_attempt_token: attempt.token,
      project: {
        id: project.id,
        title: project.title,
        aspect_ratio: compiled.aspect_ratio,
        duration_seconds: compiled.duration_seconds,
      },
      scenes,
      fallbacks,
      ...(compiled.music ? { music: compiled.music } : {}),
    };
    return jsonOk(manifest);
  });

  /**
   * Receives the finished MP4 (raw body) and streams it into R2, then validates it there and
   * only then replaces the project's previous video.
   */
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
    const token = requireAttempt(project, request);
    if (!/^video\/mp4\b/i.test(request.headers.get("content-type") ?? ""))
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the video as video/mp4.");
    const lengthHeader = request.headers.get("content-length");
    const declared = Number(lengthHeader);
    if (!lengthHeader || !Number.isInteger(declared) || declared <= 0)
      throw new ApiError(411, "VALIDATION_ERROR", "The upload needs a Content-Length header.");
    if (declared > MAX_RENDER_BYTES)
      throw new ApiError(
        413,
        "PAYLOAD_TOO_LARGE",
        `The video must be at most ${Math.round(MAX_RENDER_BYTES / 1048576)} MB.`,
      );
    if (!env.MEDIA)
      throw new ApiError(503, "INTERNAL_ERROR", "Media storage is not configured.", true);
    if (!request.body) throw BAD_UPLOAD("The upload is empty.");
    const media = env.MEDIA;

    // Stream straight to R2 (never held in Worker memory). FixedLengthStream rejects a body
    // shorter or longer than declared, so nothing incomplete is stored.
    const run = await getLatestWorkflowRun(db, user.id, projectId);
    // A fresh name per upload: a failed retry can never overwrite (then delete) a good video.
    const storage_key = `projects/${projectId}/runs/${run?.id ?? "manual"}/final-${crypto.randomUUID().slice(0, 8)}.mp4`;
    try {
      await media.put(storage_key, request.body.pipeThrough(new FixedLengthStream(declared)), {
        httpMetadata: { contentType: "video/mp4" },
      });
    } catch {
      await media.delete(storage_key).catch(() => undefined);
      throw BAD_UPLOAD("The upload was incomplete. Render the video again.");
    }

    // Validate what was stored, with ranged reads. Anything wrong: remove it, keep the old video.
    let info;
    try {
      const head = await media.head(storage_key);
      if (!head || head.size !== declared) throw new Error("the stored size doesn't match");
      const start = await media.get(storage_key, { range: { offset: 4, length: 4 } });
      const brand = start ? new TextDecoder().decode(await start.arrayBuffer()) : "";
      if (brand !== "ftyp") throw new Error("not an MP4 file");
      info = await inspectMp4(r2Reader(media, storage_key), head.size);
      if (!info.tracks.some((t) => t.kind === "video")) throw new Error("it has no video track");
    } catch (err) {
      await media.delete(storage_key);
      const why = err instanceof Error ? err.message : "unreadable";
      throw BAD_UPLOAD(
        why === "not an MP4 file"
          ? "The upload isn't an MP4 file."
          : why === "it has no video track"
            ? "The MP4 has no video track."
            : `The MP4 is damaged: ${why}.`,
      );
    }

    // The attempt may have been replaced while the bytes were uploading.
    const now = await requireProject(db, user.id, projectId);
    if (renderAttemptOf(now.production_config)?.token !== token) {
      await media.delete(storage_key);
      requireAttempt(now, request); // throws the stale-attempt error
    }
    const durationHeader = Number(request.headers.get("x-video-duration") ?? "");
    const narration = narrationReport(request.headers);
    const asset = await createAsset(db, user.id, projectId, {
      asset_type: "render",
      storage_key,
      mime_type: "video/mp4",
      file_size: declared,
      source_provider: "browser-renderer",
      license: { source: "rendered" },
      metadata: {
        render_request_id: requestId,
        render_attempt: token,
        duration_seconds: Math.round(info.durationSeconds * 1000) / 1000,
        ...(Number.isFinite(durationHeader) && durationHeader > 0
          ? { reported_duration_seconds: durationHeader }
          : {}),
        encoder: (request.headers.get("x-video-encoder") ?? "").slice(0, 20),
        ...(narration ? { narration } : {}),
      },
    });
    // Only now that the new video is safe, remove the previous one(s).
    for (const old of (await listAssets(db, user.id, projectId)).filter(
      (a) => a.asset_type === "render" && a.id !== asset.id,
    )) {
      try {
        const { storage_key: key } = await deleteAsset(db, user.id, old.id);
        await media.delete(key);
      } catch (err) {
        console.warn("Old render cleanup failed", err instanceof Error ? err.message : err);
      }
    }
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
    const token = requireAttempt(project, request);
    const asset = await getAsset(db, user.id, body.asset_id);
    if (
      !asset ||
      asset.project_id !== projectId ||
      asset.asset_type !== "render" ||
      asset.metadata.render_request_id !== requestId ||
      asset.metadata.render_attempt !== token
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
    await releaseRenderAttempt(db, user.id, projectId, token);
    return jsonOk({ project_id: projectId, status: "quality_check" }, 202);
  });

  /** The browser gave up (error or cancel): allow another attempt. Requires its token. */
  router.on("POST", `${base}/abort`, async ({ request, db, user }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    const token = requireAttempt(project, request);
    // Only the render holding the project can hand it back; a stale tab changes nothing.
    if (!(await releaseRenderAttempt(db, user.id, projectId, token, "awaiting_render")))
      requireAttempt(await requireProject(db, user.id, projectId), request);
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

/**
 * What voiced the video, as the browser renderer reported it ("kokoro" + "3/4"). Ignored unless
 * both headers are well-formed; the quality check then falls back to the stored voice assets.
 */
export function narrationReport(
  headers: Headers,
): { kind: "kokoro" | "provider" | "none"; voiced: number; total: number } | null {
  const kind = headers.get("x-video-narration");
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(headers.get("x-video-narrated-scenes") ?? "");
  if ((kind !== "kokoro" && kind !== "provider" && kind !== "none") || !m) return null;
  const voiced = Number(m[1]);
  const total = Number(m[2]);
  return voiced <= total ? { kind, voiced, total } : null;
}
