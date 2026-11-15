import {
  ASPECT_RATIOS,
  ASSET_TYPES,
  CAMERA_MOVES,
  MUSIC_MOODS,
  SCENE_TRANSITIONS,
  SHOT_SIZES,
  PROVIDER_CAPABILITIES,
  PROVIDER_TIERS,
  PROVIDER_HEALTH_STATUSES,
  QUALITY_STATUSES,
  JOB_STATUSES,
  LIMITS,
  PROJECT_STATUSES,
  SCENE_STATUSES,
  SCENE_VISUAL_TYPES,
  TARGET_PLATFORMS,
  VIDEO_TYPES,
  WORKFLOW_RUN_STATUSES,
} from "@avs/types";
import {
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  OVERLAY_ANIMATIONS,
  OVERLAY_PRESETS,
  SFX_KINDS,
} from "./timeline";
import { z } from "zod";
import { graphicsLayoutSchema, graphicsThemeSchema } from "./graphics";

export const bindingCheckSchema = z.object({
  status: z.enum(["ok", "missing", "error"]),
  latency_ms: z.number().nonnegative().optional(),
  detail: z.string().optional(),
});
export type BindingCheck = z.infer<typeof bindingCheckSchema>;

/** GET /api/v1/health */
export const healthDataSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  version: z.string(),
  environment: z.string(),
  timestamp: z.string().datetime(),
  bindings: z.object({
    database: bindingCheckSchema,
    storage: bindingCheckSchema,
    workflows: bindingCheckSchema,
  }),
  /** Renderer files (models, runtimes) not uploaded to R2 yet; deploys upload exactly these. */
  missing_vendor_files: z.array(z.string()).optional(),
});
export type HealthData = z.infer<typeof healthDataSchema>;

/** POST /api/v1/projects (endpoint arrives in Task 4; the contract is fixed here). */
export const createProjectRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(4000),
  video_type: z.enum(VIDEO_TYPES).default("auto"),
  aspect_ratio: z.enum(ASPECT_RATIOS).default("9:16"),
  duration_seconds: z
    .number()
    .int()
    .min(LIMITS.minVideoDurationSeconds)
    .max(LIMITS.maxVideoDurationSeconds)
    .default(30),
  target_platform: z.enum(TARGET_PLATFORMS).default("youtube_shorts"),
  style: z.string().trim().max(200).optional(),
});
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;

/** PATCH /api/v1/projects/:id. Status is owned by the workflow and can't be set here. */
export const updateProjectRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    style: z.string().trim().max(200).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/** A project as returned by the API. */
export const projectSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  title: z.string(),
  prompt: z.string(),
  video_type: z.enum(VIDEO_TYPES),
  aspect_ratio: z.enum(ASPECT_RATIOS),
  duration_seconds: z.number().int(),
  target_platform: z.enum(TARGET_PLATFORMS),
  status: z.enum(PROJECT_STATUSES),
  production_config: z.record(z.string(), z.unknown()),
  /** The look of graphics scenes (ADR 048); absent from older servers. */
  graphics_theme: graphicsThemeSchema.nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectPageSchema = z.object({
  items: z.array(projectSchema),
  next_cursor: z.string().nullable(),
});
export type ProjectPage = z.infer<typeof projectPageSchema>;

export const listProjectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  created_at: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: apiErrorSchema,
});

export function successEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ success: z.literal(true), data });
}

export const sceneSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  scene_number: z.number().int(),
  description: z.string(),
  visual_prompt: z.string().nullable(),
  voiceover: z.string().nullable(),
  duration_seconds: z.number(),
  visual_type: z.enum(SCENE_VISUAL_TYPES),
  status: z.enum(SCENE_STATUSES),
  created_at: z.string(),
  /** A graphics scene's layout (ADR 048). */
  graphics_layout: graphicsLayoutSchema.nullable().optional(),
});
export type Scene = z.infer<typeof sceneSchema>;

export const jobSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  scene_id: z.string().nullable(),
  agent_name: z.string(),
  job_type: z.string(),
  status: z.enum(JOB_STATUSES),
  error_message: z.string().nullable(),
  retry_count: z.number().int(),
  max_retries: z.number().int(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

export const workflowRunSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  workflow_name: z.string(),
  workflow_instance_id: z.string().nullable(),
  current_step: z.string().nullable(),
  status: z.enum(WORKFLOW_RUN_STATUSES),
  error_message: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/** POST /api/v1/projects/:id/generate */
export const generateResponseSchema = z.object({
  project_id: z.string(),
  workflow_run_id: z.string(),
  status: z.enum(PROJECT_STATUSES),
});
export type GenerateResponse = z.infer<typeof generateResponseSchema>;

export const assetSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  scene_id: z.string().nullable(),
  asset_type: z.enum(ASSET_TYPES),
  storage_key: z.string(),
  mime_type: z.string(),
  file_size: z.number().nullable(),
  source_provider: z.string().nullable(),
  license: z.record(z.string(), z.unknown()).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type Asset = z.infer<typeof assetSchema>;

/** GET /api/v1/providers */
export const providerStatusSchema = z.object({
  capability: z.enum(PROVIDER_CAPABILITIES),
  provider_name: z.string().nullable(),
  available: z.boolean(),
  enabled: z.boolean(),
  health_status: z.enum(PROVIDER_HEALTH_STATUSES),
  priority: z.number().nullable(),
  daily_limit: z.number().nullable(),
  used_today: z.number(),
  note: z.string().nullable(),
  /** Facts the provider declares in code (null for text and empty capabilities). */
  tier: z.enum(PROVIDER_TIERS).nullable().optional(),
  mode: z.enum(["sync", "async"]).nullable().optional(),
  cost_unit: z.string().nullable().optional(),
  usd_per_unit: z.number().nullable().optional(),
  commercial_use: z.boolean().nullable().optional(),
  /** Whether the provider's key is set (never the key). Null when it needs none. */
  credential_set: z.boolean().nullable().optional(),
  /** Circuit breaker state. */
  consecutive_failures: z.number().optional(),
  cooldown_until: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

const costLineSchema = z.object({
  provider_name: z.string(),
  capability: z.enum(PROVIDER_CAPABILITIES),
  tier: z.enum(PROVIDER_TIERS),
  calls: z.number(),
  units: z.number(),
  estimated_usd: z.number(),
  actual_usd: z.number().nullable(),
});

/** GET /api/v1/providers/costs: paid settings, today's spend and per-provider totals. */
export const providerCostsSchema = z.object({
  paid: z.object({
    enabled: z.boolean(),
    daily_budget_usd: z.number(),
    user_daily_budget_usd: z.number(),
    spent_today_usd: z.number(),
    you_spent_today_usd: z.number(),
  }),
  today: z.array(costLineSchema),
  last_30_days: z.array(costLineSchema),
});
export type ProviderCosts = z.infer<typeof providerCostsSchema>;

const manifestOverlaySchema = z.object({
  text: z.string().min(1).max(120),
  start_s: z.number().min(0),
  duration_s: z.number().positive(),
  preset: z.enum(OVERLAY_PRESETS),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  animation: z.enum(OVERLAY_ANIMATIONS),
});
const manifestSfxSchema = z.object({
  kind: z.enum(SFX_KINDS),
  at_s: z.number().min(0),
  gain_db: z.number().min(-40).max(12),
});

/** POST /api/v1/projects/:id/render: everything the browser needs to render the video. */
export const renderManifestSchema = z.object({
  render_request_id: z.string(),
  /** This browser render's token; send it as the x-render-attempt header on upload/complete/abort. */
  render_attempt_token: z.string().min(1),
  project: z.object({
    id: z.string(),
    title: z.string(),
    aspect_ratio: z.enum(ASPECT_RATIOS),
    duration_seconds: z.number().positive(),
  }),
  scenes: z
    .array(
      z.object({
        scene_number: z.number().int().positive(),
        start_seconds: z.number().nonnegative(),
        duration_seconds: z.number().positive(),
        visual_type: z.enum(SCENE_VISUAL_TYPES),
        caption: z.string(),
        /** Text to speak (null for silent scenes). The browser voices it with Kokoro. */
        narration: z.string().nullable().optional(),
        /** Creative Director direction (absent for projects planned before it existed). */
        shot: z.enum(SHOT_SIZES).optional(),
        camera: z.enum(CAMERA_MOVES).optional(),
        transition_in: z.enum(SCENE_TRANSITIONS).optional(),
        on_screen_text: z.string().max(80).nullable().optional(),
        image_url: z.string().nullable(),
        voice_url: z.string().nullable(),
        /** Stock footage for the scene (absent: picture or text card). */
        video_url: z.string().nullable().optional(),
        /** Attribution for the scene's footage, e.g. "Video by Ann on Pexels". */
        credit: z.string().max(200).nullable().optional(),
        /** Editor fields (ADR 044); each is present only when it differs from the default. */
        overlays: z.array(manifestOverlaySchema).max(8).optional(),
        sfx: z.array(manifestSfxSchema).max(8).optional(),
        voice_id: z.string().max(40).optional(),
        voice_speed: z.number().min(0.5).max(1.5).optional(),
        voice_gain_db: z.number().min(-40).max(12).optional(),
        transition_seconds: z.number().min(0.1).max(2).optional(),
        focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
        trim_in_seconds: z.number().min(0).max(120).optional(),
        /** A motion-graphics scene's layout (ADR 048). */
        graphics: graphicsLayoutSchema.optional(),
      }),
    )
    .min(1)
    .max(LIMITS.maxProjectScenes),
  fallbacks: z.array(z.string()),
  /** Caption look (absent: on, bold, at the bottom). */
  captions: z
    .object({
      enabled: z.boolean(),
      style: z.enum(CAPTION_STYLES),
      position: z.enum(CAPTION_POSITIONS),
    })
    .optional(),
  /** Mix settings (absent: music at 0 dB, ducked under the voice, transition sounds on). */
  audio: z
    .object({
      music: z.boolean(),
      music_gain_db: z.number().min(-40).max(12),
      duck_under_voice: z.boolean(),
      transition_sfx: z.boolean(),
    })
    .optional(),
  /** The look of graphics scenes (absent: the default theme). */
  graphics_theme: graphicsThemeSchema.optional(),
  /** Background music direction from the blueprint (absent: the default track). */
  music: z
    .object({ mood: z.enum(MUSIC_MOODS), tempo_bpm: z.number().int().min(60).max(140) })
    .optional(),
});
export type RenderManifest = z.infer<typeof renderManifestSchema>;

/** POST /api/v1/projects/:id/render/complete */
export const renderCompleteRequestSchema = z.object({
  render_request_id: z.string().min(1),
  asset_id: z.string().min(1),
});

/** GET /api/v1/projects/:id/quality (latest report; null before the first render). */
export const qualityReportSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  overall_status: z.enum(QUALITY_STATUSES),
  score: z.number().nullable(),
  checks: z
    .object({
      items: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          status: z.enum(["pass", "warn", "fail"]),
          detail: z.string(),
        }),
      ),
    })
    .loose(),
  recommendations: z.array(z.string()),
  created_at: z.string(),
});
export type QualityReport = z.infer<typeof qualityReportSchema>;
export * from "./timeline";
export * from "./graphics";
