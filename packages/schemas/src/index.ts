import {
  ASPECT_RATIOS,
  JOB_STATUSES,
  LIMITS,
  PROJECT_STATUSES,
  SCENE_STATUSES,
  SCENE_VISUAL_TYPES,
  TARGET_PLATFORMS,
  VIDEO_TYPES,
  WORKFLOW_RUN_STATUSES,
} from "@avs/types";
import { z } from "zod";

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
