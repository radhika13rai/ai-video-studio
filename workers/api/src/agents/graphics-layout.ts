import { fallbackGraphicsLayout, graphicsLayoutSchema, type GraphicsLayout } from "@avs/schemas";
import { LIMITS } from "@avs/types";
import { z } from "zod";
import type { TextModel } from "../ai/text-model";
import { BRIEF_IS_DATA, runStructured } from "./structured";
import { AgentError, briefSchema, parseInput, type AgentResult } from "./types";

/**
 * Graphics layout (ADR 048): for each graphics scene, picks one of the code-defined layout
 * presets and fills its size-capped text slots from the scene's narration and on-screen text.
 * The model never lays out a frame. Any model problem (off, quota, invalid output) falls back to
 * the deterministic layout for that scene, so this step never fails a run.
 */

const sceneInputSchema = z.object({
  scene_number: z.number().int().min(1).max(LIMITS.maxProjectScenes),
  /** The blueprint beat's name ("Hook", "Call to action"…), or "" without a blueprint. */
  beat: z.string().max(60),
  narration: z.string().max(2000),
  on_screen_text: z.string().max(80).nullable(),
  description: z.string().max(2000),
});

export const graphicsLayoutInputSchema = z.object({
  brief: briefSchema,
  scenes: z.array(sceneInputSchema).min(1).max(LIMITS.maxProjectScenes),
});
export type GraphicsLayoutInput = z.infer<typeof graphicsLayoutInputSchema>;

export interface GraphicsLayoutOutput {
  layouts: { scene_number: number; layout: GraphicsLayout; source: "model" | "fallback" }[];
}

/** What the model returns: one layout per scene number. */
export const graphicsLayoutReplySchema = z.object({
  scenes: z
    .array(z.object({ scene_number: z.number().int().min(1), layout: graphicsLayoutSchema }))
    .min(1)
    .max(LIMITS.maxProjectScenes),
});

const PRESET_GUIDE = [
  "hook_headline {pill? (≤24 chars), headline (≤40), items: up to 6 short labels (≤18) floating around}: the opening hook.",
  "card_list {headline? (≤40), rows: 1-6 of {title (≤28), subtitle? (≤40)}}: a list of things.",
  "collect_into_anchor {headline? (≤40), cards: 1-6 labels (≤20)}: several things gathered into one place.",
  "headline_papers {headline (≤40), caption? (≤40)}: a big statement with documents.",
  "headline_badge {headline (≤40), badge (≤20)}: a big statement with a highlight badge.",
  "progress_card {headline? (≤40), label (≤28), percent (0-100)}: something loading or progressing.",
  "checklist {headline (≤40), rows: 1-6 items (≤28)}: things ticked off one by one.",
  "chat_objection {message (≤60), label (≤24)}: a customer's objection in a chat.",
  "chat_reply {reply (≤120), tags: up to 2 labels (≤18)}: the answer to an objection, typed out.",
  "stacked_cards {headline? (≤40), cards: 1-5 of {title (≤28), subtitle? (≤40)}}: steps or principles in order.",
  "cta_card {headline (≤40), handle (≤30, like @name), button (≤18), line (≤48)}: the closing call to action.",
].join("\n");

/** The deterministic layout of every scene (used when the model is off or fails). */
export function fallbackLayouts(input: GraphicsLayoutInput): GraphicsLayoutOutput {
  const count = input.scenes.length;
  return {
    layouts: input.scenes.map((s, index) => ({
      scene_number: s.scene_number,
      layout: fallbackGraphicsLayout({
        index,
        count,
        beat: s.beat,
        narration: s.narration || s.description,
        on_screen_text: s.on_screen_text,
      }),
      source: "fallback" as const,
    })),
  };
}

export async function runGraphicsLayout(
  model: TextModel | null,
  input: unknown,
): Promise<AgentResult<GraphicsLayoutOutput>> {
  const parsed = parseInput("graphics-layout", graphicsLayoutInputSchema, input);
  const fallback = fallbackLayouts(parsed);
  if (!model)
    return {
      output: fallback,
      meta: { agent: "graphics-layout", model: "deterministic", attempts: 1 },
    };

  const numbers = new Set(parsed.scenes.map((s) => s.scene_number));
  const system = [
    "You design motion-graphics explainer videos for social media.",
    "For each scene, pick ONE layout preset and fill its text slots. Keep every text within its",
    "character limit; short punchy words beat long sentences. Headlines are 1-5 words.",
    "Use the scene's own facts and wording; never invent statistics, names or prices.",
    "Typical flow: hook_headline first, cta_card last, chat_objection followed by chat_reply.",
    "Presets:",
    PRESET_GUIDE,
    BRIEF_IS_DATA,
    'Reply with a single JSON object: {"scenes": [{"scene_number": 1, "layout": {"preset": "...", ...slots}}]}.',
  ].join("\n");
  const user = [
    `Video: ${parsed.brief.title}`,
    `Brief: ${parsed.brief.prompt}`,
    "Scenes:",
    ...parsed.scenes.map(
      (s) =>
        `${s.scene_number}. beat: ${s.beat || "-"} | on-screen: ${s.on_screen_text ?? "-"} | narration: ${s.narration || s.description}`,
    ),
  ].join("\n");

  try {
    const { value, meta } = await runStructured({
      agent: "graphics-layout",
      model,
      system,
      user,
      schema: graphicsLayoutReplySchema,
      maxTokens: 2500,
      check: (r) =>
        r.scenes.some((s) => !numbers.has(s.scene_number))
          ? "a scene_number is not one of the scenes given"
          : null,
    });
    const byNumber = new Map(value.scenes.map((s) => [s.scene_number, s.layout]));
    return {
      output: {
        layouts: fallback.layouts.map((f) => {
          const layout = byNumber.get(f.scene_number);
          return layout ? { scene_number: f.scene_number, layout, source: "model" as const } : f;
        }),
      },
      meta,
    };
  } catch (err) {
    // Off, out of quota, unreachable or unusable output: the deterministic layouts are always
    // valid, so a model problem never fails the run.
    const reason = err instanceof AgentError ? err.kind : "error";
    console.warn(`graphics-layout: using deterministic layouts (${reason})`);
    return {
      output: fallback,
      meta: { agent: "graphics-layout", model: "deterministic", attempts: 1 },
    };
  }
}
