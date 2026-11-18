import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { QualityStatus } from "@avs/types";
import { z } from "zod";
import { DEFAULT_GRAPHICS_THEME } from "@avs/schemas";
import {
  briefSchema,
  runDirector,
  runGraphicsLayout,
  runScriptwriter,
  runStoryboard,
  type Brief,
} from "../agents";
import { productionBlueprintSchema } from "../creative/blueprint";
import { productionPlanSchema, type ProductionPlan } from "../agents/director";
import {
  compose,
  interpretBrief,
  storyboardCreativeSchema,
  TEMPLATES,
  validateBlueprint,
  type Interpretation,
} from "../creative";
import { textModelFor } from "../ai/factory";
import {
  cancelOpenJobsForRun,
  createQualityReport,
  getAsset,
  getWorkflowRun,
  listAssets,
  listScenes,
  mergeProductionConfig,
  replaceScenes,
  requireProject,
  setProjectGraphicsTheme,
  setProjectStatusIfRun,
  terminateWorkflowRunIfLatest,
  setSceneGraphicsLayouts,
  updateWorkflowRun,
  getTimeline,
} from "../db";
import type { Env } from "../env";
import {
  animateSceneImage,
  GRAPHICS_SCENE_REASON,
  markSceneReady,
  prepareMediaStage,
  produceSceneMedia,
  summarizeFallbacks,
  type MediaOutcome,
  type SceneOutcome,
} from "./media";
import { hasCodeProvider } from "../providers/registry";
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
  /**
   * Creative Director version. Set for runs started after it was added; older runs (which may
   * still be waiting for a render) skip its steps, so their replay is unchanged.
   */
  blueprint: z.literal(1).optional(),
  /**
   * 1: re-export an already produced video (after editing): skip production and go straight to
   * the browser render and quality check, using the project's timeline (ADR 047).
   */
  renderOnly: z.literal(1).optional(),
  /** 2: video-style projects try stock footage per scene before images (ADR 041). */
  media: z.literal(2).optional(),
});
export type ProductionParams = z.infer<typeof paramsSchema>;

/** Render attempts per production run; a failed quality check uses one up. */
export const MAX_RENDER_ATTEMPTS = 3;

/** Attempt 1 keeps the original id, so runs started before retries existed still match. */
export const renderRequestIdFor = (runId: string, attempt = 1) =>
  stableUuid(attempt === 1 ? `${runId}:render` : `${runId}:render:${attempt}`);

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
 *   generating → images and narration per scene (recorded fallback when no provider works)
 *   awaiting_render → waits for the browser render with a bounded timeout
 *   quality_check → final checks, then completed; a failed check goes back to awaiting_render
 *                   for another attempt (up to MAX_RENDER_ATTEMPTS) without regenerating media
 */
export class ProductionWorkflow extends WorkflowEntrypoint<Env, ProductionParams> {
  override async run(
    event: WorkflowEvent<ProductionParams>,
    step: WorkflowStep,
  ): Promise<ProductionResult> {
    const parsed = paramsSchema.safeParse(event.payload);
    if (!parsed.success) throw new NonRetryableError("Invalid workflow parameters.");
    const { projectId, userId, runId } = parsed.data;
    const creativeDirector = parsed.data.blueprint === 1;
    const mediaV2 = parsed.data.media === 2;
    const renderOnly = parsed.data.renderOnly === 1;
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
      let plan: ProductionPlan;
      let sceneCount: number;
      let fallbacks: string[];
      if (renderOnly) {
        // Re-export: the media exists; render the (edited) timeline again.
        ({ plan, sceneCount, fallbacks } = await step.do("load-for-export", async () => {
          await ensureActive("load-for-export");
          const p = await requireProject(db, userId, projectId);
          const stored = productionPlanSchema.safeParse(p.production_config.plan);
          if (!stored.success)
            throw new NonRetryableError("This project has no production plan to export.");
          const timeline = await getTimeline(db, userId, projectId);
          const notes = Array.isArray(p.production_config.fallbacks)
            ? p.production_config.fallbacks.filter((f): f is string => typeof f === "string")
            : [];
          return {
            plan: stored.data,
            sceneCount:
              timeline?.timeline.clips.length ?? (await listScenes(db, userId, projectId)).length,
            fallbacks: notes,
          };
        }));
      } else {
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

        plan = await step.do("director", async () => {
          await ensureActive("director");
          const result = await runAgentJob(ctx, "director", "plan_production", null, async () =>
            runDirector(brief),
          );
          await mergeProductionConfig(db, userId, projectId, { plan: result });
          return result;
        });

        // Creative Director: interpret the request (model proposal, validated; rules as fallback).
        // It never fails the run: any model problem falls back to the templates.
        const interpretation: Interpretation | null = creativeDirector
          ? await step.do("creative-director", async () => {
              await ensureActive("creative-director");
              const model = textModelFor(this.env);
              const result = await runAgentJob(
                ctx,
                "creative-director",
                "interpret_brief",
                model,
                async () => {
                  const { interpretation: output, meta } = await interpretBrief(model, brief, plan);
                  return { output, meta };
                },
              );
              await mergeProductionConfig(db, userId, projectId, { interpretation: result });
              return result;
            })
          : null;
        const template = TEMPLATES[plan.video_type];

        const script = await step.do("scriptwriter", retry, async () => {
          await ensureActive("scriptwriter");
          const model = textModelFor(this.env);
          if (!model)
            throw new NonRetryableError("No text model is available in this environment.");
          const guidance = interpretation
            ? {
                beats: template.beats.map((b) => ({ name: b.name, purpose: b.purpose })),
                key_message: interpretation.key_message,
                audience: interpretation.audience,
                call_to_action: interpretation.call_to_action,
              }
            : undefined;
          return runAgentJob(ctx, "scriptwriter", "write_script", model, () =>
            runScriptwriter(model, { brief, plan, ...(guidance ? { guidance } : {}) }),
          );
        });

        sceneCount = await step.do("storyboard", retry, async () => {
          await ensureActive("storyboard");
          const model = textModelFor(this.env);
          if (!model)
            throw new NonRetryableError("No text model is available in this environment.");
          const guidance = interpretation
            ? {
                characters: interpretation.characters.map((c) => ({ name: c.name, role: c.role })),
                shots: template.shots,
                cameras: template.cameras,
                transitions: template.transitions,
              }
            : undefined;
          const board = await runAgentJob(
            ctx,
            "storyboard",
            "create_storyboard",
            model,
            async () => {
              const r = await runStoryboard(model, {
                brief,
                plan,
                script,
                ...(guidance ? { guidance } : {}),
              });
              await replaceScenes(db, userId, projectId, r.output.scenes);
              return r;
            },
          );
          if (creativeDirector)
            await mergeProductionConfig(db, userId, projectId, {
              storyboard_creative: board.creative ?? [],
            });
          return board.scenes.length;
        });

        // Blueprint: deterministic compose + validate. Scenes get consistency-enriched prompts.
        // A problem here is recorded and production continues with the storyboard as it is.
        if (interpretation)
          await step.do("blueprint", async () => {
            await ensureActive("blueprint");
            try {
              const project = await requireProject(db, userId, projectId);
              const stored = project.production_config.storyboard_creative;
              const creative = Array.isArray(stored)
                ? stored.map((c) => storyboardCreativeSchema.safeParse(c).data ?? null)
                : [];
              const sceneRows = await listScenes(db, userId, projectId);
              const blueprint = validateBlueprint(
                compose({ brief, plan, interpretation, scenes: sceneRows, creative }),
              );
              await replaceScenes(
                db,
                userId,
                projectId,
                sceneRows.map((s, i) => ({
                  scene_number: s.scene_number,
                  description: s.description,
                  visual_prompt: blueprint.scenes[i]?.visual_prompt || s.visual_prompt,
                  voiceover: s.voiceover,
                  duration_seconds: blueprint.scenes[i]?.duration_seconds ?? s.duration_seconds,
                  visual_type: s.visual_type,
                })),
              );
              await mergeProductionConfig(db, userId, projectId, {
                blueprint,
                blueprint_error: null,
              });
              return { scenes: blueprint.scenes.length, issues: blueprint.issues.length };
            } catch (err) {
              const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
              console.error("Blueprint step failed; continuing with the storyboard", message);
              await mergeProductionConfig(db, userId, projectId, { blueprint_error: message });
              return { scenes: 0, issues: 0 };
            }
          });

        // Motion graphics (ADR 048): pick a layout preset per graphics scene and fill its text
        // slots (model, validated; deterministic fallback per scene, so it never fails the run).
        if (plan.visual_style === "motion_graphics")
          await step.do("graphics-layout", retry, async () => {
            await ensureActive("graphics-layout");
            const project = await requireProject(db, userId, projectId);
            const rows = (await listScenes(db, userId, projectId)).filter(
              (s) => s.visual_type === "graphics",
            );
            if (rows.length === 0) return { model: 0, fallback: 0 };
            const bp = productionBlueprintSchema.safeParse(project.production_config.blueprint);
            const planned = (n: number) =>
              bp.success ? bp.data.scenes.find((s) => s.scene_number === n) : undefined;
            const beat = (n: number) =>
              bp.success
                ? (bp.data.narrative.beats.find((b) => b.id === planned(n)?.beat_id)?.name ?? "")
                : "";
            const model = textModelFor(this.env);
            const result = await runAgentJob(
              ctx,
              "graphics-layout",
              "layout_graphics",
              model,
              async () =>
                runGraphicsLayout(model, {
                  brief,
                  scenes: rows.map((s) => ({
                    scene_number: s.scene_number,
                    beat: beat(s.scene_number).slice(0, 60),
                    narration: (s.voiceover ?? "").slice(0, 2000),
                    on_screen_text: planned(s.scene_number)?.on_screen_text?.slice(0, 80) ?? null,
                    description: s.description.slice(0, 2000),
                  })),
                }),
            );
            await setSceneGraphicsLayouts(
              db,
              userId,
              projectId,
              result.layouts.map(({ scene_number, layout }) => ({ scene_number, layout })),
            );
            await setProjectGraphicsTheme(db, userId, projectId, DEFAULT_GRAPHICS_THEME);
            return {
              model: result.layouts.filter((l) => l.source === "model").length,
              fallback: result.layouts.filter((l) => l.source === "fallback").length,
            };
          });

        const scenes = await step.do("generate-assets", async () => {
          await ensureActive("generate-assets");
          if (!(await setProjectStatusIfRun(db, userId, projectId, runId, ["planning"], "generating"))) {
            throw new NonRetryableError("This workflow run is no longer the active project run.");
          }
          return prepareMediaStage(ctx, this.env);
        });

        // Video-style projects try stock footage first, when a video provider is usable. Decided
        // once, in a step, so a key added mid-run can't change the path on replay.
        const useVideo =
          mediaV2 && plan.visual_style === "video"
            ? await step.do("video-plan", async () => hasCodeProvider(this.env, "video"))
            : false;

        // Paid image-to-video, only when switched on with a budget and a key (ADR 042).
        const useAnimation =
          mediaV2 && plan.visual_style === "video"
            ? await step.do("animate-plan", async () => hasCodeProvider(this.env, "image_to_video"))
            : false;

        // One durable step per scene and medium: a failure on scene 5 never redoes scenes 1–4.
        const outcomes: SceneOutcome[] = [];
        for (const scene of scenes) {
          const media = async (capability: "image" | "voice" | "video"): Promise<MediaOutcome> => {
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
          // Graphics scenes (ADR 048) are drawn by the renderer: no picture or footage at all.
          const graphics = scene.visual_type === "graphics";
          const video: MediaOutcome = graphics
            ? { status: "skipped", reason: GRAPHICS_SCENE_REASON }
            : useVideo
              ? await media("video")
              : { status: "skipped", reason: "Not a video-style project." };
          const image: MediaOutcome = graphics
            ? { status: "skipped", reason: GRAPHICS_SCENE_REASON }
            : video.status === "ok"
              ? { status: "skipped", reason: "Scene uses stock footage." }
              : await media("image");
          const animated: MediaOutcome =
            useAnimation && image.status === "ok"
              ? await animateSceneImage(
                  step,
                  ctx,
                  this.env,
                  scene,
                  image.asset_id,
                  brief.aspect_ratio,
                )
              : { status: "skipped", reason: "Not animated." };
          const voice = await media("voice");
          outcomes.push({ scene: scene.scene_number, image, voice, video, animated });
        }

        fallbacks = await step.do("summarize-assets", async () => {
          await ensureActive("summarize-assets");
          for (const scene of scenes) await markSceneReady(ctx, scene.id);
          const notes = summarizeFallbacks(plan.visual_style, plan.narration, outcomes);
          await mergeProductionConfig(db, userId, projectId, { fallbacks: notes });
          return notes;
        });
      }

      // Render attempts. Attempt 1 keeps the original step names so runs that were already
      // waiting when retries were added still resume; later attempts get a suffix.
      let quality: QualityStatus = "failed";
      let lastFailure: string | null = null;
      for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
        const sfx = attempt === 1 ? "" : `-${attempt}`;
        const failure = lastFailure;
        const renderRequestId = await step.do(`request-render${sfx}`, async () => {
          await ensureActive(`request-render${sfx}`);
          // Derived from the run, so a retried step keeps the same id the browser was given.
          const id = await renderRequestIdFor(runId, attempt);
          await mergeProductionConfig(db, userId, projectId, {
            render_request: {
              id,
              requested_at: new Date().toISOString(),
              attempt,
              max_attempts: MAX_RENDER_ATTEMPTS,
              ...(failure ? { last_failure: failure } : {}),
            },
          });
          if (
            !(await setProjectStatusIfRun(
              db,
              userId,
              projectId,
              runId,
              ["generating", "quality_check"],
              "awaiting_render",
            ))
          ) {
            throw new NonRetryableError("This workflow run is no longer the active project run.");
          }
          await updateWorkflowRun(db, userId, runId, {
            status: "waiting",
            current_step: attempt === 1 ? "awaiting-render" : `awaiting-render-${attempt}`,
          });
          return id;
        });

        // The browser renders the video and the completion endpoint sends this event.
        const rendered = await step.waitForEvent<z.infer<typeof renderEventSchema>>(
          `wait-for-render${sfx}`,
          { type: RENDER_EVENT, timeout: RENDER_TIMEOUT },
        );

        const finalAttempt = attempt === MAX_RENDER_ATTEMPTS;
        const outcome = await step.do(
          `finish${sfx}`,
          async (): Promise<{ quality: QualityStatus; failure: string | null }> => {
            const evt = renderEventSchema.safeParse(rendered.payload);
            if (!evt.success || evt.data.render_request_id !== renderRequestId)
              throw new NonRetryableError("Render event doesn't match this run's render request.");
            const video = await getAsset(db, userId, evt.data.asset_id);
            if (!video || video.project_id !== projectId || video.asset_type !== "render")
              throw new NonRetryableError("The rendered video is missing.");
            await updateWorkflowRun(db, userId, runId, {
              status: "running",
              current_step: `quality-check${sfx}`,
            });
            if (
              !(await setProjectStatusIfRun(
                db,
                userId,
                projectId,
                runId,
                ["awaiting_render", "rendering"],
                "quality_check",
              ))
            ) {
              throw new NonRetryableError("This workflow run is no longer the active project run.");
            }
            const reported = video.metadata.reported_duration_seconds;
            const edited = await getTimeline(db, userId, projectId);
            const current = await requireProject(db, userId, projectId);
            const report = await runQualityChecks({
              project: edited
                ? {
                    ...current,
                    aspect_ratio: edited.timeline.aspect_ratio,
                    duration_seconds: edited.timeline.clips.reduce((n, c) => n + c.duration_s, 0),
                  }
                : current,
              scenes: await listScenes(db, userId, projectId),
              assets: await listAssets(db, userId, projectId),
              narrationPlanned: plan.narration,
              renderPlanSeconds: typeof reported === "number" ? reported : null,
              renderNarration: narrationFromMetadata(video.metadata.narration),
              video: this.env.MEDIA
                ? {
                    read: r2Reader(this.env.MEDIA, video.storage_key),
                    size:
                      video.file_size ?? (await this.env.MEDIA.head(video.storage_key))?.size ?? 0,
                  }
                : null,
            });
            await createQualityReport(db, userId, projectId, {
              overall_status: report.overall_status,
              score: report.score,
              checks: { items: report.checks, mp4: report.mp4, attempt },
              recommendations: report.recommendations,
            });
            if (report.overall_status !== "failed") {
              if (!(await setProjectStatusIfRun(db, userId, projectId, runId, ["quality_check"], "completed"))) {
                throw new NonRetryableError("This workflow run is no longer the active project run.");
              }
              await updateWorkflowRun(db, userId, runId, {
                status: "completed",
                current_step: "done",
              });
              return { quality: report.overall_status, failure: null };
            }
            const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.detail);
            const message = `Quality check failed: ${failed.join(" ")}`;
            if (finalAttempt) {
              if (!(await setProjectStatusIfRun(db, userId, projectId, runId, ["quality_check"], "failed"))) {
                throw new NonRetryableError("This workflow run is no longer the active project run.");
              }
              await updateWorkflowRun(db, userId, runId, {
                status: "failed",
                error_message:
                  MAX_RENDER_ATTEMPTS > 1
                    ? `${message} (after ${MAX_RENDER_ATTEMPTS} render attempts)`
                    : message,
              });
            }
            // Otherwise the next attempt's request step moves the project back to
            // "Ready to render"; scenes, images and narration are kept as they are.
            return { quality: "failed", failure: message };
          },
        );
        quality = outcome.quality;
        lastFailure = outcome.failure;
        if (quality !== "failed") break;
      }

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
        const failedCurrentRun = await terminateWorkflowRunIfLatest(
          db,
          userId,
          projectId,
          runId,
          "failed",
          PRODUCTION_STATUSES,
          friendly(message),
        );
        if (failedCurrentRun) await cancelOpenJobsForRun(db, userId, projectId, runId);
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

/** The renderer's narration report stored on the render asset, if it is well-formed. */
function narrationFromMetadata(
  value: unknown,
): { kind: string; voiced: number; total: number } | null {
  const parsed = z
    .object({
      kind: z.enum(["kokoro", "provider", "none"]),
      voiced: z.number().int().min(0),
      total: z.number().int().min(0),
    })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}
