import {
  LIMITS,
  PROVIDER_CAPABILITIES,
  VIDEO_TYPES,
  type ProviderCapability,
  type VideoType,
} from "@avs/types";
import { z } from "zod";
import { briefSchema, parseInput, type AgentResult, type Brief } from "./types";

/**
 * Director: picks the video type (when "auto") and plans the pipeline. Deterministic on purpose
 * (CLAUDE.md rule 15): keyword rules are free, instant, testable and good enough for routing.
 */

export type ConcreteVideoType = Exclude<VideoType, "auto">;
export type VisualStyle = "image" | "video" | "animation" | "motion_graphics";

export const productionPlanSchema = z.object({
  video_type: z.enum(VIDEO_TYPES).exclude(["auto"]),
  classified_by: z.enum(["user", "rules"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  /** motion_graphics: every scene is a deterministic graphics layout, no AI media (ADR 048). */
  visual_style: z.enum(["image", "video", "animation", "motion_graphics"]),
  narration: z.boolean(),
  presenter: z.boolean(),
  /** Capabilities the providers must cover for this video. */
  capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)),
  scene_count: z.number().int().min(1).max(LIMITS.maxProjectScenes),
  /** Spoken words that fit the duration at a comfortable ~2.5 words per second. */
  word_budget: z.number().int().positive(),
  tone: z.string(),
});
export type ProductionPlan = z.infer<typeof productionPlanSchema>;

const RULES: { type: ConcreteVideoType; words: RegExp[] }[] = [
  {
    type: "advertisement",
    words: [
      /\bads?\b/,
      /\badvert/,
      /\bproduct\b/,
      /\blaunch/,
      /\bbuy\b/,
      /\bsale\b/,
      /\bbrand/,
      /\bpromo/,
      /\bdiscount/,
      /\boffer\b/,
      /\bshop\b/,
    ],
  },
  {
    type: "explainer",
    words: [
      /\bhow\b/,
      /\bwhy\b/,
      /\bexplain/,
      /\bwhat is\b/,
      /\bguide\b/,
      /\btutorial/,
      /\bsteps?\b/,
      /\blearn/,
      /\bteach/,
    ],
  },
  {
    type: "animation",
    words: [/\bcartoon/, /\banimat/, /\bkids?\b/, /\bfairy ?tale/, /\bcharacters?\b/, /\banime\b/],
  },
  {
    type: "cinematic",
    words: [
      /\bcinematic/,
      /\bepic\b/,
      /\bfilm\b/,
      /\btrailer/,
      /\bdramatic/,
      /\bstory\b/,
      /\bmovie/,
    ],
  },
  {
    type: "presenter",
    words: [
      /\bpresenter/,
      /\bhost\b/,
      /\btalking head/,
      /\bon camera\b/,
      /\bspokesperson/,
      /\bavatar/,
    ],
  },
  {
    type: "faceless",
    words: [
      /\bfacts?\b/,
      /\btop \d+/,
      /\blist\b/,
      /\btips?\b/,
      /\bquotes?\b/,
      /\bnarrat/,
      /\bvoice ?over/,
    ],
  },
];

const PIPELINES: Record<
  ConcreteVideoType,
  { visual_style: VisualStyle; narration: boolean; presenter: boolean; tone: string }
> = {
  faceless: {
    visual_style: "image",
    narration: true,
    presenter: false,
    tone: "clear and engaging",
  },
  explainer: {
    visual_style: "image",
    narration: true,
    presenter: false,
    tone: "friendly and clear",
  },
  advertisement: {
    visual_style: "video",
    narration: true,
    presenter: false,
    tone: "persuasive and premium",
  },
  cinematic: {
    visual_style: "video",
    narration: true,
    presenter: false,
    tone: "atmospheric and dramatic",
  },
  animation: {
    visual_style: "animation",
    narration: true,
    presenter: false,
    tone: "playful and warm",
  },
  presenter: {
    visual_style: "video",
    narration: true,
    presenter: true,
    tone: "direct and personable",
  },
};

/** Briefs asking for a motion-graphics explainer get graphics scenes instead of AI pictures. */
const MOTION_GRAPHICS =
  /\bmotion[- ]?graphics?\b|\bmotion design\b|\banimated (?:software |product |saas )?explainer\b|\bkinetic typography\b|\bexplainer animation\b/;

export function wantsMotionGraphics(brief: Pick<Brief, "title" | "prompt" | "style">): boolean {
  return MOTION_GRAPHICS.test(`${brief.title} ${brief.prompt} ${brief.style ?? ""}`.toLowerCase());
}

/** Keyword hits per video type, highest first (shared with the Creative Director). */
export function scoreTypes(text: string): { type: ConcreteVideoType; hits: number }[] {
  const lower = text.toLowerCase();
  return RULES.map((r) => ({
    type: r.type,
    hits: r.words.filter((w) => w.test(lower)).length,
  })).sort((a, b) => b.hits - a.hits);
}

export function classify(brief: Pick<Brief, "title" | "prompt" | "style">): {
  type: ConcreteVideoType;
  confidence: number;
  reason: string;
} {
  const scored = scoreTypes(`${brief.title} ${brief.prompt} ${brief.style ?? ""}`);
  const [best, second] = scored;
  if (!best || best.hits === 0)
    return {
      type: "faceless",
      confidence: 0.4,
      reason: "No strong signal; faceless narration suits most topics.",
    };
  const margin = best.hits - (second?.hits ?? 0);
  const confidence = Math.min(0.95, 0.5 + 0.15 * best.hits + 0.1 * margin);
  return {
    type: best.type,
    confidence: Math.round(confidence * 100) / 100,
    reason: `Matched ${best.hits} ${best.type} keyword${best.hits === 1 ? "" : "s"}${margin === 0 ? " (tied; first match wins)" : ""}.`,
  };
}

export function runDirector(input: unknown): AgentResult<ProductionPlan> {
  const brief = parseInput("director", briefSchema, input);
  const picked =
    brief.video_type === "auto"
      ? { ...classify(brief), classified_by: "rules" as const }
      : {
          type: brief.video_type,
          confidence: 1,
          reason: "Chosen by the user.",
          classified_by: "user" as const,
        };
  const base = PIPELINES[picked.type];
  const pipe = wantsMotionGraphics(brief)
    ? { ...base, visual_style: "motion_graphics" as const, tone: `${base.tone}; motion graphics` }
    : base;
  const capabilities: ProviderCapability[] = ["text"];
  // Graphics scenes are drawn in the browser: no picture provider needed.
  if (pipe.visual_style !== "motion_graphics")
    capabilities.push(pipe.visual_style === "image" ? "image" : "video");
  if (pipe.narration) capabilities.push("voice");
  capabilities.push("music");
  const scene_count = Math.max(
    2,
    Math.min(LIMITS.maxProjectScenes, Math.round(brief.duration_seconds / 5)),
  );
  return {
    output: {
      video_type: picked.type,
      classified_by: picked.classified_by,
      confidence: picked.confidence,
      reason: picked.reason,
      visual_style: pipe.visual_style,
      narration: pipe.narration,
      presenter: pipe.presenter,
      capabilities,
      scene_count,
      word_budget: Math.round(brief.duration_seconds * 2.5),
      tone: brief.style ? `${pipe.tone}; style: ${brief.style}` : pipe.tone,
    },
    meta: { agent: "director", model: "deterministic", attempts: 1 },
  };
}
