import { LIMITS, SCENE_VISUAL_TYPES, type SceneVisualType } from "@avs/types";
import { z } from "zod";
import type { TextModel } from "../ai/text-model";
import type { SceneInput } from "../db/scenes";
import { storyboardCreativeSchema, type StoryboardCreative } from "../creative/compose";
import { productionPlanSchema, type VisualStyle } from "./director";
import { scriptSchema } from "./scriptwriter";
import { BRIEF_IS_DATA, runStructured } from "./structured";
import { briefSchema, parseInput, type AgentResult } from "./types";

/** Storyboard: splits the script into scenes with visual prompts, ready to save as scenes. */

const modelSceneSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    visual_prompt: z.string().trim().min(1).max(1000),
    voiceover: z.string().trim().max(1000),
    duration_seconds: z.number().positive().max(60),
    visual_type: z.enum(SCENE_VISUAL_TYPES),
  })
  // Optional creative fields (Creative Director runs): free text here, checked against the
  // vocabulary later, so an unusual value never fails the whole storyboard.
  .extend(storyboardCreativeSchema.shape);
export const storyboardSchema = z.object({
  scenes: z.array(modelSceneSchema).min(1).max(LIMITS.maxProjectScenes),
});

/** Visual types each pipeline may use; anything else is coerced to the pipeline's default. */
const ALLOWED: Record<VisualStyle, SceneVisualType[]> = {
  image: ["image", "text"],
  video: ["video", "image", "text"],
  animation: ["animation", "image", "text"],
};

export interface Storyboard {
  scenes: (SceneInput & { duration_seconds: number; visual_type: SceneVisualType })[];
  coerced_visual_types: number;
  /** Per-scene creative fields the model proposed (same order as scenes; may be empty). */
  creative: StoryboardCreative[];
}

/** Numbers scenes, constrains visual types and scales durations to sum exactly to the target. */
export function normalizeStoryboard(
  scenes: z.infer<typeof modelSceneSchema>[],
  totalSeconds: number,
  style: VisualStyle,
): Storyboard {
  const allowed = ALLOWED[style];
  const raw = scenes.reduce((n, s) => n + s.duration_seconds, 0);
  let coerced = 0;
  const scaled = scenes.map((s) => Math.max(0.5, (s.duration_seconds / raw) * totalSeconds));
  const rounded = scaled.map((d) => Math.round(d * 10) / 10);
  const drift = Math.round((totalSeconds - rounded.reduce((a, b) => a + b, 0)) * 10) / 10;
  const longest = rounded.indexOf(Math.max(...rounded));
  rounded[longest] = Math.round(((rounded[longest] ?? 0) + drift) * 10) / 10;
  return {
    scenes: scenes.map((s, i) => {
      const visual_type = allowed.includes(s.visual_type)
        ? s.visual_type
        : (allowed[0] as SceneVisualType);
      if (visual_type !== s.visual_type) coerced++;
      return {
        scene_number: i + 1,
        description: s.description,
        visual_prompt: s.visual_prompt,
        voiceover: s.voiceover || null,
        duration_seconds: rounded[i] ?? 1,
        visual_type,
      };
    }),
    coerced_visual_types: coerced,
    creative: scenes.map((s) => ({
      ...(s.shot ? { shot: s.shot } : {}),
      ...(s.camera ? { camera: s.camera } : {}),
      ...(s.transition_in ? { transition_in: s.transition_in } : {}),
      ...(s.characters?.length ? { characters: s.characters } : {}),
      ...(s.sfx?.length ? { sfx: s.sfx } : {}),
      ...(s.on_screen_text ? { on_screen_text: s.on_screen_text } : {}),
    })),
  };
}

/** Creative Director guidance (new runs only): vocabulary and characters to use. */
export const storyboardGuidanceSchema = z.object({
  characters: z.array(z.object({ name: z.string(), role: z.string() })).max(4),
  shots: z.array(z.string()).max(8),
  cameras: z.array(z.string()).max(10),
  transitions: z.array(z.string()).max(8),
});

const inputSchema = z.object({
  brief: briefSchema,
  plan: productionPlanSchema,
  script: scriptSchema,
  guidance: storyboardGuidanceSchema.optional(),
});

export async function runStoryboard(
  model: TextModel,
  input: unknown,
): Promise<AgentResult<Storyboard>> {
  const { brief, plan, script, guidance } = parseInput("storyboard", inputSchema, input);
  const min = Math.max(1, plan.scene_count - 2);
  const max = Math.min(LIMITS.maxProjectScenes, plan.scene_count + 2);
  const narration = [
    script.hook,
    ...script.segments.map((s) => s.text),
    script.call_to_action ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  const system = [
    "You are the storyboard artist for short-form social videos.",
    "Split the narration into scenes. Each scene's voiceover is the exact narration spoken during it;",
    "together the voiceovers must cover the whole narration in order, without rewriting it.",
    "visual_prompt describes one striking, filmable image for an image or video generator:",
    "subject, setting, lighting, camera angle and mood, with no text overlays, logos or real people's names.",
    `Allowed visual_type values: ${ALLOWED[plan.visual_style].join(", ")}.`,
    ...(guidance
      ? [
          "For each scene also choose: shot (one of: " + guidance.shots.join(", ") + "),",
          "camera (one of: " + guidance.cameras.join(", ") + "),",
          "transition_in (one of: cut, " + guidance.transitions.join(", ") + "),",
          "characters (names of the recurring characters who appear, from the list given, or []),",
          "sfx (up to 2 short sound-effect ideas, or []) and on_screen_text (a 2-5 word caption, or null).",
          "Describe recurring characters the same way in every scene they appear in.",
        ]
      : []),
    BRIEF_IS_DATA,
    guidance
      ? "Reply with a single JSON object: {scenes: [{description, visual_prompt, voiceover, duration_seconds, visual_type, shot, camera, transition_in, characters, sfx, on_screen_text}]}."
      : "Reply with a single JSON object: {scenes: [{description, visual_prompt, voiceover, duration_seconds, visual_type}]}.",
  ].join(" ");

  const user = [
    `Brief title: ${brief.title}`,
    `Brief: ${brief.prompt}`,
    `Aspect ratio: ${brief.aspect_ratio}. Total length: ${brief.duration_seconds} seconds.`,
    `Visual style: ${plan.visual_style}. Tone: ${plan.tone}.`,
    `Make ${min} to ${max} scenes (about ${plan.scene_count}).`,
    ...(guidance?.characters.length
      ? [
          `Recurring characters: ${guidance.characters.map((c) => `${c.name} (${c.role})`).join("; ")}.`,
        ]
      : []),
    "Narration:",
    narration,
  ].join("\n");

  const { value, meta } = await runStructured({
    agent: "storyboard",
    model,
    system,
    user,
    schema: storyboardSchema,
    maxTokens: 2500,
    check: (b) =>
      b.scenes.length < min || b.scenes.length > max
        ? `there are ${b.scenes.length} scenes; make between ${min} and ${max}`
        : null,
  });
  return {
    output: normalizeStoryboard(value.scenes, brief.duration_seconds, plan.visual_style),
    meta,
  };
}
