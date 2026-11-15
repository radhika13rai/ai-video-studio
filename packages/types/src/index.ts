/** Domain vocabulary shared by the frontend, the API and (later) the renderer. */

export const VIDEO_TYPES = [
  "cinematic",
  "faceless",
  "animation",
  "presenter",
  "advertisement",
  "explainer",
  "auto",
] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];

export const ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const TARGET_PLATFORMS = [
  "youtube_shorts",
  "instagram_reels",
  "tiktok",
  "youtube",
  "facebook_reels",
] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

/** Conservative limits for the zero-budget MVP (see CLAUDE.md). */
export const LIMITS = {
  maxVideoDurationSeconds: 60,
  minVideoDurationSeconds: 5,
  maxProjectScenes: 20,
  maxGenerationRetriesPerScene: 3,
} as const;

/**
 * Lifecycle states. The database enforces the same lists with CHECK constraints
 * (workers/api/migrations); a test fails if the two drift apart.
 */
export const PROJECT_STATUSES = [
  "created",
  "planning",
  "generating",
  "awaiting_render",
  "rendering",
  "quality_check",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SCENE_STATUSES = ["pending", "generating", "ready", "failed", "skipped"] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const SCENE_VISUAL_TYPES = ["image", "video", "animation", "text", "graphics"] as const;
export type SceneVisualType = (typeof SCENE_VISUAL_TYPES)[number];

/** `queued` → `running` → `completed` | `failed` | `cancelled`. A failed attempt with retries
 * left goes back to `queued`. */
export const JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const QUALITY_STATUSES = ["passed", "warning", "failed"] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export const PROVIDER_HEALTH_STATUSES = ["unknown", "healthy", "degraded", "down"] as const;
export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATUSES)[number];

export const PROVIDER_CAPABILITIES = [
  "text",
  "image",
  "video",
  "image_to_video",
  "voice",
  "music",
  "sfx",
] as const;

export const PROVIDER_TIERS = ["free", "paid"] as const;
export type ProviderTier = (typeof PROVIDER_TIERS)[number];

export const PROVIDER_JOB_STATUSES = [
  "submitted",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type ProviderJobStatus = (typeof PROVIDER_JOB_STATUSES)[number];
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const ASSET_TYPES = [
  "image",
  "video",
  "audio",
  "voiceover",
  "music",
  "subtitle",
  "thumbnail",
  "render",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** Default retry policy for jobs (overridable per job, capped at the DB level at 10). */
export const JOB_RETRY_POLICY = { defaultMaxRetries: 3, hardMaxRetries: 10 } as const;

/** Creative vocabulary shared by the Creative Director (planning) and the renderer. */
export const SHOT_SIZES = ["wide", "medium", "close", "extreme_close", "overhead", "pov"] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

export const CAMERA_MOVES = [
  "static",
  "push_in",
  "pull_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "orbit",
  "handheld",
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

/** How a scene starts. "cut" is a hard cut; the rest match the renderer's transitions. */
export const SCENE_TRANSITIONS = ["cut", "crossfade", "zoom", "slide", "whip", "flash"] as const;
export type SceneTransition = (typeof SCENE_TRANSITIONS)[number];

export const MUSIC_MOODS = ["upbeat", "light", "ambient", "playful", "driving", "warm"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

export const NARRATIVE_STRUCTURES = [
  "aida",
  "tutorial",
  "three_act",
  "story",
  "listicle",
  "direct_address",
] as const;
export type NarrativeStructure = (typeof NARRATIVE_STRUCTURES)[number];
