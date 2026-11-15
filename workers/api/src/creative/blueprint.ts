import {
  ASPECT_RATIOS,
  CAMERA_MOVES,
  LIMITS,
  MUSIC_MOODS,
  NARRATIVE_STRUCTURES,
  PROVIDER_CAPABILITIES,
  SCENE_TRANSITIONS,
  SCENE_VISUAL_TYPES,
  SHOT_SIZES,
  VIDEO_TYPES,
} from "@avs/types";
import { KOKORO_VOICES } from "@avs/contracts";
import { z } from "zod";

/**
 * ProductionBlueprint v1: the validated creative plan for one video. Built deterministically from
 * the director's plan, the model's interpretation, the script and the storyboard (compose.ts),
 * then checked and repaired (validate.ts). Stored in production_config.blueprint.
 */

export const BLUEPRINT_VERSION = 1 as const;

const id = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "lowercase id");
const shortText = (max: number) => z.string().trim().max(max);

export const characterSchema = z.object({
  id,
  name: shortText(60).min(1),
  role: shortText(80).min(1),
  appearance: shortText(240).min(1),
  wardrobe: shortText(160),
  /** Fixed description repeated word-for-word in every scene the character appears in. */
  consistency_tag: shortText(400).min(1),
  voice: z.enum(KOKORO_VOICES.map((v) => v.id) as [string, ...string[]]).nullable(),
});
export type Character = z.infer<typeof characterSchema>;

export const beatSchema = z.object({
  id,
  name: shortText(40).min(1),
  purpose: shortText(160),
  start_s: z.number().min(0),
  end_s: z.number().positive(),
});
export type Beat = z.infer<typeof beatSchema>;

export const assetRequirementSchema = z.object({
  kind: z.enum(["image", "voice", "music", "sfx"]),
  capability: z.enum(PROVIDER_CAPABILITIES),
  required: z.boolean(),
  /** What the video uses when no provider can produce the asset. */
  fallback: z.enum(["text_card", "server_voice", "captions", "silence", "generated_music", "none"]),
});
export type AssetRequirement = z.infer<typeof assetRequirementSchema>;

export const blueprintSceneSchema = z.object({
  scene_number: z.number().int().min(1).max(LIMITS.maxProjectScenes),
  beat_id: id,
  description: shortText(500).min(1),
  visual_prompt: shortText(1000),
  shot: z.enum(SHOT_SIZES),
  camera: z.enum(CAMERA_MOVES),
  transition_in: z.enum(SCENE_TRANSITIONS),
  characters: z.array(id).max(4),
  narration: z.object({ speaker: z.string(), text: shortText(1000) }).nullable(),
  dialogue: z.array(z.object({ speaker: id, text: shortText(300) })).max(6),
  on_screen_text: shortText(80).nullable(),
  sfx: z.array(shortText(40)).max(4),
  duration_seconds: z.number().positive().max(LIMITS.maxVideoDurationSeconds),
  visual_type: z.enum(SCENE_VISUAL_TYPES),
  assets: z.array(assetRequirementSchema).max(6),
});
export type BlueprintScene = z.infer<typeof blueprintSceneSchema>;

export const blueprintIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["repaired", "warning"]),
  detail: z.string(),
});
export type BlueprintIssue = z.infer<typeof blueprintIssueSchema>;

export const productionBlueprintSchema = z.object({
  blueprint_version: z.literal(BLUEPRINT_VERSION),
  video_type: z.enum(VIDEO_TYPES).exclude(["auto"]),
  aspect_ratio: z.enum(ASPECT_RATIOS),
  duration_seconds: z.number().positive().max(LIMITS.maxVideoDurationSeconds),
  source: z.object({
    interpretation: z.enum(["model", "rules"]),
    storyboard_fields: z.enum(["model", "defaults", "mixed"]),
  }),
  narrative: z.object({
    structure: z.enum(NARRATIVE_STRUCTURES),
    beats: z.array(beatSchema).min(1).max(8),
  }),
  style: z.object({
    look: shortText(120),
    palette: shortText(120),
    lighting: shortText(120),
    lens: shortText(80),
    texture: shortText(80),
    /** Appended to every visual prompt so all scenes share one look. */
    style_suffix: shortText(300),
    avoid: z.array(shortText(60)).max(8),
  }),
  characters: z.array(characterSchema).max(4),
  music: z.object({
    mood: z.enum(MUSIC_MOODS),
    tempo_bpm: z.number().int().min(60).max(140),
    /** Relative energy (0–1) per beat, same order as narrative.beats. */
    energy_curve: z.array(z.number().min(0).max(1)).max(8),
    duck_under_voice: z.boolean(),
  }),
  pacing: z.object({
    avg_shot_seconds: z.number().positive().max(10),
    words_per_second_target: z.number().positive().max(4),
    cut_rhythm: z.enum(["calm", "medium", "fast"]),
  }),
  scenes: z.array(blueprintSceneSchema).min(1).max(LIMITS.maxProjectScenes),
  assumptions: z.array(z.string().max(300)).max(12),
  issues: z.array(blueprintIssueSchema).max(60),
});
export type ProductionBlueprint = z.infer<typeof productionBlueprintSchema>;
