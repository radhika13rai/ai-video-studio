import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { QualityStatus } from "@avs/types";
import { z } from "zod";
import { briefSchema, runDirector, runScriptwriter, runStoryboard, type Brief } from "../agents";
import { textModelFor } from "../ai/factory";
import {
  cancelOpenJobs,
  createQualityReport,
  getAsset,
  getWorkflowRun,
  listAssets,
  listScenes,
  mergeProductionConfig,
  replaceScenes,
  requireProject,
  setProjectStatusIf,
  updateWorkflowRun,
} from "../db";
import type { Env } from "../env";
import {
  markSceneReady,
  prepareMediaStage,
  produceSceneMedia,
  summarizeFallbacks,
  type MediaOutcome,
} from "./media";
import { runQualityChecks } from "../quality/check";
import { r2Reader } from "../quality/mp4";
import { agentStepConfig, runAgentJob, stableUuid, type StepContext } from "./steps";

export const WORKFLOW_NAME = "production-workflow";
export const RENDER_EVENT = "render-complete";
/** How long a project waits in "Ready to render" before the run gives up. */
export const RENDER_TIMEOUT = "7 days";

const paramsSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  runId: z.uuid(),
});
export type ProductionParams = z.infer<typeof paramsSchema>;

export const renderRequestIdFor = (runId: string) => stableUuid(`${runId}:render`);

export const renderEventSchema = z.object({ render_request_id: z.string(), asset_id: z.string() });

export interface ProductionResult {
  projectId: string;
  runId: string;
  /** "quality_failed": the video was rendered but failed an automated quality check. */
  status: "completed" | "quality_failed";
  quality: QualityStatus;
  scenes: number;
  fallbacks: string[];
}

const PRODUCTION_STATUSES = [
  "planning",
  "generating",
  "awaiting_render",
  "rendering",
  "quality_check",
] as const;

/**
 * The durable production pipeline. Every step is checkpointed by Cloudflare Workflows, so a crash
 * or deploy resumes where it stopped. Each agent runs as a tracked job with the same retry policy
 * as its step. Stages:
 *   planning  → director, scriptwriter, storyboard (scenes saved to D1)
 *   generating → media assets (providers arrive in Task 8; until then a recorded fallback)
 *   awaiting_render → waits for the browser render (Task 9) with a bounded timeout
 *   quality_check → final checks (Task 10), then completed
 */
export class ProductionWorkflow extends WorkflowEntrypoint<Env, ProductionParams> {
  override async run(
    event: WorkflowEvent<ProductionParams>,
    step: WorkflowStep,
  ): Promise<ProductionResult> {
    const parsed = paramsSchema.safeParse(event.payload);
    if (!parsed.success) throw new NonRetryableError("Invalid workflow parameters.");
    const { projectId, userId, runId } = parsed.data;
    const db = this.env.DB;
    if (!db) throw new NonRetryableError("The database binding is missing.");
    const ctx: StepContext = { db, userId, projectId, runId };
    const retry = agentStepConfig(this.env.WORKFLOW_RETRY_DELAY);

    /** Stops quietly if the user cancelled while the previous step ran. */
    const ensureActive = async (stepName: string) => {
      const run = await getWorkflowRun(db, userId, runId);
      if (!run || run.status !== "running")
        throw new NonRetryableError(`Run is ${run?.status ?? "missing"}.`);
      await updateWorkflowRun(db, userId, runId, { current_step: stepName });
    };

    try {
      const brief = await step.do("load-project", async (): Promise<Brief> => {
        await ensureActive("load-project");
        const p = await requireProject(db, userId, projectId);
        const style = p.production_config.style;
        return briefSchema.parse({
          title: p.title,
          prompt: p.prompt,
          video_type: p.video_type,
          aspect_ratio: p.aspect_ratio,
          duration_seconds: p.duration_seconds,
          target_platform: p.target_platform,
          style: typeof style === "string" ? style : null,
        });
      });

      const plan = await step.do("director", async () => {
        await ensureActive("director");
        const result = await runAgentJob(ctx, "director", "plan_production", null, async () =>
          runDirector(brief),
        );
        await mergeProductionConfig(db, userId, projectId, { plan: result });
        return result;
      });

      const script = await step.do("scriptwriter", retry, async () => {
        await ensureActive("scriptwriter");
        const model = textModelFor(this.env);
        if (!model) throw new NonRetryableError("No text model is available in this environment.");
        return runAgentJob(ctx, "scriptwriter", "write_script", model, () =>
          runScriptwriter(model, { brief, plan }),
        );
      });

      const sceneCount = await step.do("storyboard", retry, async () => {
        await ensureActive("storyboard");
        const model = textModelFor(this.env);
        if (!model) throw new NonRetryableError("No text model is available in this environment.");
        const board = await runAgentJob(ctx, "storyboard", "create_storyboard", model, async () => {
          const r = await runStoryboard(model, { brief, plan, script });
          await replaceScenes(db, userId, projectId, r.output.scenes);
          return r;
        });
        return board.scenes.length;
      });

      const scenes = await step.do("generate-assets", async () => {
        await ensureActive("generate-assets");
        await setProjectStatusIf(db, userId, projectId, ["planning"], "generating");
        return prepareMediaStage(ctx, this.env);
      });

      // One durable step per scene and medium: a failure on scene 5 never redoes scenes 1–4.
      const outcomes: { scene: number; image: MediaOutcome; voice: MediaOutcome }[] = [];
      for (const scene of scenes) {
        const media = async (capability: "image" | "voice"): Promise<MediaOutcome> => {
          if (capability === "voice" && !plan.narration)
            return { status: "skipped", reason: "No narration planned." };
          try {
            return await step.do(`${capability}-scene-${scene.scene_number}`, retry, async () => {
              await ensureActive(`${capability}-scene-${scene.scene_number}`);
              return produceSceneMedia(ctx, this.env, scene, capability, brief.aspect_ratio);
            });
          } catch (err) {
            // Retries used up: keep going with a recorded fallback instead of failing the video.
            const message = err instanceof Error ? err.message : String(err);
            if (/^Run is /.test(message)) throw err; // cancelled
            return { status: "fallback", reason: message.slice(0, 200) };
          }
        };
        const image = await media("image");
        const voice = await media("voice");
        outcomes.push({ scene: scene.scene_number, image, voice });
      }

      const fallbacks = await step.do("summarize-assets", async () => {
        await ensureActive("summarize-assets");
        for (const scene of scenes) await markSceneReady(ctx, scene.id);
        const notes = summarizeFallbacks(plan.visual_style, plan.narration, outcomes);
        await mergeProductionConfig(db, userId, projectId, { fallbacks: notes });
        return notes;
      });

      const renderRequestId = await step.do("request-render", async () => {
        await ensureActive("request-render");
        // Derived from the run, so a retried step keeps the same id the browser was given.
        const id = await renderRequestIdFor(runId);
        await mergeProductionConfig(db, userId, projectId, {
          render_request: { id, requested_at: new Date().toISOString() },
        });
        await setProjectStatusIf(db, userId, projectId, ["generating"], "awaiting_render");
        await updateWorkflowRun(db, userId, runId, {
          status: "waiting",
          current_step: "awaiting-render",
        });
        return id;
      });

      // The browser renders the video and the completion endpoint (Task 9) sends this event.
      const rendered = await step.waitForEvent<z.infer<typeof renderEventSchema>>(
        "wait-for-render",
        {
          type: RENDER_EVENT,
          timeout: RENDER_TIMEOUT,
        },
      );

      const quality = await step.do("finish", async (): Promise<QualityStatus> => {
        const evt = renderEventSchema.safeParse(rendered.payload);
        if (!evt.success || evt.data.render_request_id !== renderRequestId)
          throw new NonRetryableError("Render event doesn't match this run's render request.");
        const video = await getAsset(db, userId, evt.data.asset_id);
        if (!video || video.project_id !== projectId || video.asset_type !== "render")
          throw new NonRetryableError("The rendered video is missing.");
        await updateWorkflowRun(db, userId, runId, {
          status: "running",
          current_step: "quality-check",
        });
        await setProjectStatusIf(
          db,
          userId,
          projectId,
          ["awaiting_render", "rendering"],
          "quality_check",
        );
        const report = await runQualityChecks({
          project: await requireProject(db, userId, projectId),
          scenes: await listScenes(db, userId, projectId),
          assets: await listAssets(db, userId, projectId),
          narrationPlanned: plan.narration,
          video: this.env.MEDIA
            ? {
                read: r2Reader(this.env.MEDIA, video.storage_key),
                size: video.file_size ?? (await this.env.MEDIA.head(video.storage_key))?.size ?? 0,
              }
            : null,
        });
        await createQualityReport(db, userId, projectId, {
          overall_status: report.overall_status,
          score: report.score,
          checks: { items: report.checks, mp4: report.mp4 },
          recommendations: report.recommendations,
        });
        if (report.overall_status === "failed") {
          await setProjectStatusIf(db, userId, projectId, ["quality_check"], "failed");
          const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.detail);
          await updateWorkflowRun(db, userId, runId, {
            status: "failed",
            error_message: `Quality check failed: ${failed.join(" ")}`,
          });
          return report.overall_status;
        }
        await setProjectStatusIf(db, userId, projectId, ["quality_check"], "completed");
        await updateWorkflowRun(db, userId, runId, { status: "completed", current_step: "done" });
        return report.overall_status;
      });

      return {
        projectId,
        runId,
        status: quality === "failed" ? "quality_failed" : "completed",
        quality,
        scenes: sceneCount,
        fallbacks,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do("record-failure", async () => {
        const run = await getWorkflowRun(db, userId, runId);
        if (run?.status === "cancelled") return; // the cancel endpoint already updated everything
        await cancelOpenJobs(db, userId, projectId);
        await setProjectStatusIf(db, userId, projectId, PRODUCTION_STATUSES, "failed");
        if (run && !["completed", "failed", "cancelled"].includes(run.status))
          await updateWorkflowRun(db, userId, runId, {
            status: "failed",
            error_message: friendly(message),
          });
      });
      throw err;
    }
  }
}

function friendly(message: string): string {
  if (/waitForEvent|timed? ?out/i.test(message))
    return `The video wasn't rendered within ${RENDER_TIMEOUT}. Generate again to retry.`;
  return message.slice(0, 500);
}
