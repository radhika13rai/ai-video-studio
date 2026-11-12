import { ASPECT_RATIOS, LIMITS, TARGET_PLATFORMS, VIDEO_TYPES } from "@avs/types";
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
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

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
