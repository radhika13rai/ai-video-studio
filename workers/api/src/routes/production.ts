import { API_PREFIX, IDEMPOTENCY_HEADER } from "@avs/contracts";
import type { AspectRatio, ProjectStatus } from "@avs/types";
import { productionPlanSchema } from "../agents";
import { textModelFor } from "../ai/factory";
import {
  cancelOpenJobs,
  createWorkflowRun,
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
import { refreshFallbacks, regenerateSceneMedia } from "../workflows/media";
import { WORKFLOW_NAME } from "../workflows/production-workflow";
import type { Ctx } from "./projects";

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
    const run = await getLatestWorkflowRun(db, user.id, projectId);
    if (!run) throw new ApiError(409, "INVALID_STATE", "This project has no production run.");
    const ctx = { db, userId: user.id, projectId, runId: run.id };
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
