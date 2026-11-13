import type { ProjectStatus, TargetPlatform, VideoType } from "@avs/types";

export type Tone = "neutral" | "active" | "attention" | "success" | "danger";

/** How each project status is shown. `active` statuses are polled for updates. */
export const STATUS_DISPLAY: Record<ProjectStatus, { label: string; tone: Tone; hint: string }> = {
  created: { label: "Draft", tone: "neutral", hint: "Created, production not started." },
  planning: { label: "Planning", tone: "active", hint: "Writing the script and storyboard." },
  generating: { label: "Generating", tone: "active", hint: "Creating images, video and voice." },
  awaiting_render: {
    label: "Ready to render",
    tone: "attention",
    hint: "Open the project to render the video in your browser.",
  },
  rendering: { label: "Rendering", tone: "active", hint: "Assembling the final video." },
  quality_check: { label: "Checking quality", tone: "active", hint: "Running quality checks." },
  completed: { label: "Completed", tone: "success", hint: "The video is ready." },
  failed: { label: "Failed", tone: "danger", hint: "Production stopped with an error." },
  cancelled: { label: "Cancelled", tone: "neutral", hint: "Production was cancelled." },
};

export const isActive = (s: ProjectStatus) => STATUS_DISPLAY[s].tone === "active";

export const VIDEO_TYPE_LABELS: Record<VideoType, string> = {
  auto: "Let AI decide",
  faceless: "Faceless (voice + visuals)",
  explainer: "Explainer",
  advertisement: "Advertisement",
  cinematic: "Cinematic",
  animation: "Animation",
  presenter: "Presenter",
};

export const PLATFORM_LABELS: Record<TargetPlatform, string> = {
  youtube_shorts: "YouTube Shorts",
  instagram_reels: "Instagram Reels",
  tiktok: "TikTok",
  facebook_reels: "Facebook Reels",
  youtube: "YouTube",
};

/** "just now", "5 min ago", "3 h ago", "2 days ago", or a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
