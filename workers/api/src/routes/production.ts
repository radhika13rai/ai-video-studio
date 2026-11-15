import { API_PREFIX, IDEMPOTENCY_HEADER } from "@avs/contracts";
import type { AspectRatio, ProjectStatus } from "@avs/types";
import { productionPlanSchema } from "../agents";
import { textModelFor } from "../ai/factory";
import {
  cancelOpenJobs,
  createWorkflowRun,
  getAsset,
  getLatestWorkflowRun,
  listScenes,
  mergeProductionConfig,
  requireProject,
  setProjectStatusIf,
  updateWorkflowRun,
} from "../db";
import { ApiError } from "../lib/errors";
import { jsonOk } from "../lib/http";
import { withIdempotency } from "../lib/idempotency";
import type { Router } from "../lib/router";
import { readJson } from "../lib/request";
import { currentTimeline, mediaRunId } from "../timeline";
import { refreshFallbacks, regenerateSceneMedia, regenerateSceneVersion } from "../workflows/media";
import { WORKFLOW_NAME } from "../workflows/production-workflow";
import type { Ctx } from "./projects";
import { timelineAssetIds } from "@avs/schemas";
import { z } from "zod";

/** Produced videos whose scenes can be regenerated in the editor. */
const EDITABLE: ProjectStatus[] = ["awaiting_render", "completed", "failed", "cancelled"];
/** Produced videos that can be rendered again (awaiting_render renders directly). */
const EXPORTABLE: ProjectStatus[] = ["completed", "failed", "cancelled"];

/** Statuses from which production may (re)start. */
export const STARTABLE: readonly ProjectStatus[] = [
  "created",
  "failed",
  "cancelled",
  "awaiting_render",
  "completed",
];
/** Statuses during which production can be cancelled. */
export const CANCELLABLE: readonly ProjectStatus[] = [
  "planning",
  "generating",
  "awaiting_render",
  "rendering",
  "quality_check",
];

export function registerProductionRoutes(router: Router<Ctx>): void {
  const base = `${API_PREFIX}/projects/:id`;

  router.on("POST", `${base}/generate`, async ({ request, env, db, user }, p) =>
    withIdempotency(db, user.id, request.headers.get(IDEMPOTENCY_HEADER), request, async () => {
      const projectId = p.id ?? "";
      const project = await requireProject(db, user.id, projectId);
      if (!env.PRODUCTION_WORKFLOW)
        throw new ApiError(503, "INTERNAL_ERROR", "The workflow service is not configured.", true);
      if (!textModelFor(env))
        throw new ApiError(
          503,
          "PROVIDER_UNAVAILABLE",
          "AI text generation isn't available here. Locally, run `pnpm --filter @avs/api dev:ai` after `wrangler login`.",
          false,
        );
      if (!STARTABLE.includes(project.status))
        throw new ApiError(
          409,
          "INVALID_STATE",
          `Production is already running (status: ${project.status}).`,
        );

      // A previous run still waiting for its render is superseded by this one.
      const previous = await getLatestWorkflowRun(db, user.id, projectId);
      if (previous && ["queued", "running", "waiting"].includes(previous.status)) {
        await terminate(env.PRODUCTION_WORKFLOW, previous.workflow_instance_id);
        await updateWorkflowRun(db, user.id, previous.id, {
          status: "cancelled",
          error_message: "Superseded by a new run.",
        });
      }

      // Claim the project atomically so two clicks can't start two runs.
      if (!(await setProjectStatusIf(db, user.id, projectId, STARTABLE, "planning")))
        throw new ApiError(
          409,
          "INVALID_STATE",
          "Production was started by another request.",
          true,
        );

      const runId = crypto.randomUUID();
      await createWorkflowRun(db, user.id, projectId, {
        id: runId,
        workflow_name: WORKFLOW_NAME,
        workflow_instance_id: runId,
      });
      try {
        await env.PRODUCTION_WORKFLOW.create({
          id: runId,
          params: { projectId, userId: user.id, runId, blueprint: 1, media: 2 },
        });
      } catch (err) {
        console.error("Workflow create failed", err);
        await updateWorkflowRun(db, user.id, runId, {
          status: "failed",
          error_message: "Could not start the workflow.",
        });
        await setProjectStatusIf(db, user.id, projectId, ["planning"], project.status);
        throw new ApiError(503, "INTERNAL_ERROR", "Could not start production. Try again.", true);
      }
      return jsonOk({ project_id: projectId, workflow_run_id: runId, status: "planning" }, 202);
    }),
  );

  router.on("POST", `${base}/cancel`, async ({ env, db, user }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    if (!CANCELLABLE.includes(project.status))
      throw new ApiError(409, "INVALID_STATE", `Nothing to cancel (status: ${project.status}).`);
    const run = await getLatestWorkflowRun(db, user.id, projectId);
    if (run && ["queued", "running", "waiting"].includes(run.status)) {
      // Mark the run first: steps check it and stop even if terminate() is slow.
      await updateWorkflowRun(db, user.id, run.id, {
        status: "cancelled",
        error_message: "Cancelled by the user.",
      });
      await terminate(env.PRODUCTION_WORKFLOW, run.workflow_instance_id);
    }
    await cancelOpenJobs(db, user.id, projectId);
    await setProjectStatusIf(db, user.id, projectId, CANCELLABLE, "cancelled");
    return jsonOk(await requireProject(db, user.id, projectId));
  });

  /** Regenerates one scene's image and narration (before rendering). Only that scene changes. */
  router.on("POST", `${base}/scenes/:sceneId/retry-media`, async ({ env, db, user }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    if (project.status !== "awaiting_render")
      throw new ApiError(
        409,
        "INVALID_STATE",
        "Scenes can be retried once production reaches 'Ready to render'.",
      );
    const scene = (await listScenes(db, user.id, projectId)).find((s) => s.id === p.sceneId);
    if (!scene) throw new ApiError(404, "NOT_FOUND", "Scene not found.");
    const runId = await mediaRunId(db, user.id, project);
    if (!runId) throw new ApiError(409, "INVALID_STATE", "This project has no production run.");
    const ctx = { db, userId: user.id, projectId, runId };
    const result = await regenerateSceneMedia(
      ctx,
      env,
      scene,
      project.aspect_ratio as AspectRatio,
      ["image", "voice"],
    );
    const plan = productionPlanSchema.safeParse(project.production_config.plan);
    const fallbacks = await refreshFallbacks(
      ctx,
      plan.success ? plan.data.visual_style : "image",
      plan.success ? plan.data.narration : true,
      env,
    );
    await mergeProductionConfig(db, user.id, projectId, { fallbacks });
    return jsonOk({
      scene_id: scene.id,
      image: result.image ?? null,
      voice: result.voice ?? null,
      fallbacks,
    });
  });

  /**
   * A new version of one scene's picture for the editor: a fresh image (optionally from an edited
   * prompt) or another stock clip. Earlier versions are kept (ADR 047).
   */
  router.on("POST", `${base}/scenes/:sceneId/regenerate`, async ({ request, env, db, user }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    if (!EDITABLE.includes(project.status))
      throw new ApiError(
        409,
        "INVALID_STATE",
        `Scenes can be regenerated once the video is produced (status: ${project.status}).`,
      );
    const body = await readJson(
      request,
      z.object({
        what: z.enum(["image", "footage"]),
        prompt: z.string().trim().max(1000).nullish(),
      }),
    );
    const scene = (await listScenes(db, user.id, projectId)).find((s) => s.id === p.sceneId);
    if (!scene) throw new ApiError(404, "NOT_FOUND", "Scene not found.");
    const runId = await mediaRunId(db, user.id, project);
    if (!runId) throw new ApiError(409, "INVALID_STATE", "This project has no production run.");
    const { timeline } = await currentTimeline(db, user.id, project);
    const inUse = new Set(timelineAssetIds(timeline));
    const res = await regenerateSceneVersion(
      { db, userId: user.id, projectId, runId },
      env,
      scene,
      body.what,
      body.prompt ?? null,
      timeline.aspect_ratio,
      inUse,
    );
    if (res.outcome.status !== "ok")
      throw new ApiError(
        502,
        "GENERATION_FAILED",
        res.outcome.status === "fallback" ? res.outcome.reason : "Nothing was generated.",
        true,
      );
    const asset = await getAsset(db, user.id, res.asset_id ?? "");
    return jsonOk({ scene_id: scene.id, asset }, 201);
  });

  /**
   * Renders an already produced (and possibly edited) video again: a render-only run that skips
   * production and waits for the browser render and the quality check (ADR 047).
   */
  router.on("POST", `${base}/export`, async ({ env, db, user }, p) => {
    const projectId = p.id ?? "";
    const project = await requireProject(db, user.id, projectId);
    if (!env.PRODUCTION_WORKFLOW)
      throw new ApiError(503, "INTERNAL_ERROR", "The workflow service is not configured.", true);
    if (project.status === "awaiting_render")
      throw new ApiError(
        409,
        "INVALID_STATE",
        "This video is ready to render: render it from the project page.",
      );
    if (!EXPORTABLE.includes(project.status))
      throw new ApiError(
        409,
        "INVALID_STATE",
        `This video can't be exported now (status: ${project.status}).`,
      );
    if (!productionPlanSchema.safeParse(project.production_config.plan).success)
      throw new ApiError(409, "INVALID_STATE", "Generate the video first.");
    // Keep pointing at the media run: the export run makes no media of its own.
    const mediaRun = await mediaRunId(db, user.id, project);
    if (mediaRun && project.production_config.media_run_id !== mediaRun)
      await mergeProductionConfig(db, user.id, projectId, { media_run_id: mediaRun });
    if (!(await setProjectStatusIf(db, user.id, projectId, EXPORTABLE, "generating")))
      throw new ApiError(409, "INVALID_STATE", "An export was started by another request.", true);
    const runId = crypto.randomUUID();
    await createWorkflowRun(db, user.id, projectId, {
      id: runId,
      workflow_name: WORKFLOW_NAME,
      workflow_instance_id: runId,
    });
    try {
      await env.PRODUCTION_WORKFLOW.create({
        id: runId,
        params: { projectId, userId: user.id, runId, renderOnly: 1 },
      });
    } catch (err) {
      console.error("Workflow create failed", err);
      await updateWorkflowRun(db, user.id, runId, {
        status: "failed",
        error_message: "Could not start the export.",
      });
      await setProjectStatusIf(db, user.id, projectId, ["generating"], project.status);
      throw new ApiError(503, "INTERNAL_ERROR", "Could not start the export. Try again.", true);
    }
    return jsonOk({ project_id: projectId, workflow_run_id: runId, status: "generating" }, 202);
  });

  router.on("GET", `${base}/run`, async ({ db, user }, p) => {
    await requireProject(db, user.id, p.id ?? "");
    return jsonOk(await getLatestWorkflowRun(db, user.id, p.id ?? ""));
  });
}

async function terminate(workflow: Workflow | undefined, instanceId: string | null): Promise<void> {
  if (!workflow || !instanceId) return;
  try {
    const instance = await workflow.get(instanceId);
    await instance.terminate();
  } catch (err) {
    // Already finished or never started; the database state is what matters.
    console.warn("Workflow terminate skipped", err instanceof Error ? err.message : err);
  }
}
