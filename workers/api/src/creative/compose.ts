import {
  CAMERA_MOVES,
  SCENE_TRANSITIONS,
  SHOT_SIZES,
  type CameraMove,
  type SceneTransition,
  type SceneVisualType,
  type ShotSize,
} from "@avs/types";
import { z } from "zod";
import type { ProductionPlan } from "../agents/director";
import type { Brief } from "../agents/types";
import {
  BLUEPRINT_VERSION,
  type AssetRequirement,
  type BlueprintIssue,
  type BlueprintScene,
  type Character,
  type ProductionBlueprint,
} from "./blueprint";
import type { Interpretation } from "./interpret";
import { beatsFor, TEMPLATES } from "./templates";

/**
 * Deterministic composition of the production blueprint. Model proposals (interpretation and the
 * storyboard's optional per-scene fields) are accepted only when they fit the vocabulary;
 * anything missing or invalid comes from the video type's template, and each substitution is
 * recorded as an issue.
 */

/** Optional creative fields the storyboard model may add per scene (any may be missing). */
export const storyboardCreativeSchema = z.object({
  shot: z.string().max(40).optional(),
  camera: z.string().max(40).optional(),
  transition_in: z.string().max(40).optional(),
  characters: z.array(z.string().max(60)).max(6).optional(),
  sfx: z.array(z.string().max(60)).max(6).optional(),
  on_screen_text: z.string().max(200).nullish(),
});
export type StoryboardCreative = z.infer<typeof storyboardCreativeSchema>;

export interface SceneForBlueprint {
  scene_number: number;
  description: string;
  visual_prompt: string | null;
  voiceover: string | null;
  duration_seconds: number;
  visual_type: SceneVisualType;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  if (!value) return null;
  const v = norm(value);
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function slugId(text: string, taken: Set<string>): string {
  let base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 24) || "character";
  if (!/^[a-z]/.test(base)) base = `c_${base}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

export function compose(input: {
  brief: Brief;
  plan: ProductionPlan;
  interpretation: Interpretation;
  scenes: SceneForBlueprint[];
  creative: (StoryboardCreative | null | undefined)[];
}): ProductionBlueprint {
  const { brief, plan, interpretation: interp, scenes } = input;
  const t = TEMPLATES[plan.video_type];
  const issues: BlueprintIssue[] = [...interp.analysis.issues];
  const beats = beatsFor(t, brief.duration_seconds);

  // Characters: appearance-only consistency tags (names never go into image prompts).
  const taken = new Set<string>();
  const characters: Character[] = interp.characters.slice(0, 4).map((c) => ({
    id: slugId(c.name || c.role, taken),
    name: c.name,
    role: c.role,
    appearance: c.appearance,
    wardrobe: c.wardrobe,
    consistency_tag: [c.appearance, c.wardrobe ? `wearing ${c.wardrobe}` : ""]
      .filter(Boolean)
      .join(", ")
      .slice(0, 400),
    voice: null,
  }));

  const keywords = [...interp.style_keywords, ...(brief.style ? [brief.style] : [])];
  const style = {
    ...t.look,
    style_suffix: [...new Set(keywords), t.look.look, t.look.lighting, t.look.palette, t.look.lens]
      .filter(Boolean)
      .join(", ")
      .slice(0, 300),
    avoid: interp.must_avoid.slice(0, 8),
  };

  let fromModel = 0;
  let at = 0;
  const bpScenes: BlueprintScene[] = scenes.map((s, i) => {
    const c = input.creative[i] ?? {};
    const mid = at + s.duration_seconds / 2;
    at += s.duration_seconds;
    const beat = beats.find((b) => mid >= b.start_s && mid < b.end_s) ?? beats[beats.length - 1]!;

    const shot = pick<ShotSize>(c.shot, SHOT_SIZES);
    const camera = pick<CameraMove>(c.camera, CAMERA_MOVES);
    const transition = pick<SceneTransition>(c.transition_in, SCENE_TRANSITIONS);
    if (shot || camera || transition) fromModel++;
    for (const [field, raw, ok] of [
      ["shot", c.shot, shot],
      ["camera", c.camera, camera],
      ["transition_in", c.transition_in, transition],
    ] as const)
      if (raw && !ok)
        issues.push({
          code: "unknown_value",
          severity: "repaired",
          detail: `Scene ${s.scene_number}: ${field} "${raw.slice(0, 30)}" isn't supported; used the template's choice.`,
        });

    // Characters in the scene: those the storyboard named, plus any whose name or role the
    // scene text mentions.
    const sceneText = `${s.description} ${s.visual_prompt ?? ""}`.toLowerCase();
    const named = new Set((c.characters ?? []).map((n) => n.toLowerCase().trim()));
    const inScene = characters.filter(
      (ch) =>
        named.has(ch.name.toLowerCase()) ||
        named.has(ch.id) ||
        sceneText.includes(ch.name.toLowerCase()) ||
        (ch.role.length > 3 && sceneText.includes(ch.role.toLowerCase())),
    );

    const base = (s.visual_prompt ?? s.description).trim();
    const tags = inScene.map((ch) => ch.consistency_tag);
    const tail = [
      tags.length ? tags.join("; ") : "",
      `Style: ${style.style_suffix}`,
      style.avoid.length ? `Avoid: ${style.avoid.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(". ");
    const room = Math.max(120, 1000 - tail.length - 2);
    const visual_prompt =
      s.visual_type === "text" ? "" : `${base.slice(0, room)}. ${tail}`.slice(0, 1000);

    const assets: AssetRequirement[] = [];
    if (s.visual_type !== "text")
      assets.push({ kind: "image", capability: "image", required: true, fallback: "text_card" });
    if (s.voiceover)
      // Voiced by Kokoro in the browser; captions carry the script if that fails.
      assets.push({ kind: "voice", capability: "voice", required: true, fallback: "captions" });
    if (i === 0)
      assets.push({
        kind: "music",
        capability: "music",
        required: false,
        fallback: "generated_music",
      });

    return {
      scene_number: s.scene_number,
      beat_id: beat.id,
      description: s.description.slice(0, 500),
      visual_prompt,
      shot: shot ?? t.shots[i % t.shots.length]!,
      camera: camera ?? t.cameras[i % t.cameras.length]!,
      transition_in: i === 0 ? "cut" : (transition ?? t.transitions[i % t.transitions.length]!),
      characters: inScene.map((ch) => ch.id),
      narration: s.voiceover ? { speaker: "narrator", text: s.voiceover.slice(0, 1000) } : null,
      dialogue: [],
      on_screen_text: c.on_screen_text ? c.on_screen_text.trim().slice(0, 80) || null : null,
      sfx: (c.sfx ?? [])
        .map((x) => x.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 4),
      duration_seconds: s.duration_seconds,
      visual_type: s.visual_type,
      assets,
    };
  });

  const assumptions = [
    ...interp.analysis.assumptions,
    ...interp.ambiguities.map((a) => `Unclear in the request: ${a}`),
    ...(interp.source === "rules"
      ? ["The plan was made from templates because the AI interpretation wasn't available."]
      : []),
  ].slice(0, 12);

  return {
    blueprint_version: BLUEPRINT_VERSION,
    video_type: plan.video_type,
    aspect_ratio: brief.aspect_ratio,
    duration_seconds: brief.duration_seconds,
    source: {
      interpretation: interp.source,
      storyboard_fields:
        fromModel === 0 ? "defaults" : fromModel === scenes.length ? "model" : "mixed",
    },
    narrative: { structure: t.structure, beats },
    style,
    characters,
    music: {
      mood: t.music.mood,
      tempo_bpm: t.music.tempo_bpm,
      energy_curve: t.beats.map((b) => b.energy),
      duck_under_voice: true,
    },
    pacing: {
      avg_shot_seconds: t.avg_shot_seconds,
      words_per_second_target: t.words_per_second,
      cut_rhythm: t.cut_rhythm,
    },
    scenes: bpScenes,
    assumptions,
    issues: issues.slice(0, 60),
  };
}
