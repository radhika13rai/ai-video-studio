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
