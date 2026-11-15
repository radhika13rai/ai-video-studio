import {
  ASPECT_RATIOS,
  CAMERA_MOVES,
  LIMITS,
  MUSIC_MOODS,
  SCENE_TRANSITIONS,
  SCENE_VISUAL_TYPES,
  SHOT_SIZES,
} from "@avs/types";
import { z } from "zod";

/**
 * Timeline v1: the editable, persisted description of a video (ADR 043). Clips are kept in order
 * and play back to back (a magnetic, single video track); voice, captions, text overlays and
 * sound effects belong to their clip with times relative to its start, so reordering a clip
 * carries them along. Music is one bed under the whole video. Media is referenced by asset id
 * (bytes live in R2). The same pure functions build a timeline from a production and compile a
 * timeline into the browser renderer's manifest, on the server and in the editor alike.
 */

export const TIMELINE_VERSION = 1 as const;
export const MIN_CLIP_SECONDS = 0.5;
export const MAX_CLIP_SECONDS = 30;
export const MAX_TIMELINE_CLIPS = LIMITS.maxProjectScenes * 2;
/** The longest edited video: twice the longest brief, so scenes can be lengthened to fit voice. */
export const MAX_TIMELINE_SECONDS = LIMITS.maxVideoDurationSeconds * 2;
export const MAX_TIMELINE_BYTES = 256 * 1024;

export const OVERLAY_PRESETS = ["title", "lower_third", "label", "quote"] as const;
export const OVERLAY_ANIMATIONS = ["none", "fade", "pop", "slide_up", "typewriter"] as const;
export const SFX_KINDS = ["whoosh", "hit", "riser", "pop", "boom"] as const;
export const CAPTION_STYLES = ["bold", "minimal", "karaoke"] as const;
export const CAPTION_POSITIONS = ["bottom", "middle", "top"] as const;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "ids are 1–64 letters, digits, - or _");
const assetRef = z.string().min(1).max(64).nullable();
const unit = z.number().min(0).max(1);
const gainDb = z.number().min(-40).max(12);

export const textOverlaySchema = z.object({
  id,
  text: z.string().trim().min(1).max(120),
  /** Seconds from the clip's start. */
  start_s: z.number().min(0).max(MAX_CLIP_SECONDS),
  duration_s: z.number().min(0.2).max(MAX_CLIP_SECONDS),
  preset: z.enum(OVERLAY_PRESETS),
  /** Centre of the text, as a share of the frame (0–1). */
  x: unit,
  y: unit,
  animation: z.enum(OVERLAY_ANIMATIONS),
});
export type TextOverlay = z.infer<typeof textOverlaySchema>;

export const sfxCueSchema = z.object({
  id,
  kind: z.enum(SFX_KINDS),
  /** Seconds from the clip's start. */
  at_s: z.number().min(0).max(MAX_CLIP_SECONDS),
  gain_db: gainDb,
});
export type SfxCue = z.infer<typeof sfxCueSchema>;

export const clipSchema = z.object({
  id,
  /** The storyboard scene this clip came from (regeneration targets it). */
  scene_id: z.string().min(1).max(64),
  /** The scene's description: the caption when it has no narration. */
  description: z.string().max(500),
  visual_type: z.enum(SCENE_VISUAL_TYPES),
  /** The clip's picture; footage plays when present, the image is its fallback. */
  image_asset_id: assetRef,
  video_asset_id: assetRef,
  duration_s: z.number().min(MIN_CLIP_SECONDS).max(MAX_CLIP_SECONDS),
  /** Seconds skipped at the start of the footage. */
  trim_in_s: z.number().min(0).max(120),
  /** Point of the picture kept in frame when cropping (0–1). */
  focal: z.object({ x: unit, y: unit }),
  shot: z.enum(SHOT_SIZES).nullable(),
  camera: z.enum(CAMERA_MOVES).nullable(),
  /** How this clip enters; null lets the renderer choose (the first clip always cuts in). */
  transition_in: z
    .object({ kind: z.enum(SCENE_TRANSITIONS), duration_s: z.number().min(0.1).max(2) })
    .nullable(),
  voice: z.object({
    /** kokoro: voiced in the browser; asset: a stored recording; none: silent. */
    mode: z.enum(["kokoro", "asset", "none"]),
    text: z.string().max(1000),
    asset_id: assetRef,
    /** A Kokoro voice id, or null for the voice chosen at render time. */
    voice_id: z.string().max(40).nullable(),
    speed: z.number().min(0.5).max(1.5).nullable(),
    gain_db: gainDb,
  }),
  /** Caption text; null follows the narration (or the description when silent). */
  caption: z.string().max(300).nullable(),
  /** The Creative Director's short on-screen label. */
  on_screen_text: z.string().max(80).nullable(),
  overlays: z.array(textOverlaySchema).max(8),
  sfx: z.array(sfxCueSchema).max(8),
});
export type Clip = z.infer<typeof clipSchema>;

export const timelineSchema = z
  .object({
    version: z.literal(TIMELINE_VERSION),
    aspect_ratio: z.enum(ASPECT_RATIOS),
    clips: z.array(clipSchema).min(1).max(MAX_TIMELINE_CLIPS),
    captions: z.object({
      enabled: z.boolean(),
      style: z.enum(CAPTION_STYLES),
      position: z.enum(CAPTION_POSITIONS),
    }),
    music: z.object({
      mode: z.enum(["generated", "none"]),
      /** Null: the renderer's default track. */
      mood: z.enum(MUSIC_MOODS).nullable(),
      tempo_bpm: z.number().int().min(60).max(140).nullable(),
      gain_db: gainDb,
      duck_under_voice: z.boolean(),
    }),
    /** Whooshes and hits on planned transitions. */
    auto_transition_sfx: z.boolean(),
  })
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const c of t.clips) {
      for (const x of [c.id, ...c.overlays.map((o) => o.id), ...c.sfx.map((s) => s.id)]) {
        if (ids.has(x)) ctx.addIssue({ code: "custom", message: `duplicate id "${x}"` });
        ids.add(x);
      }
      for (const o of c.overlays)
        if (o.start_s >= c.duration_s)
          ctx.addIssue({ code: "custom", message: `overlay "${o.id}" starts after its clip ends` });
      for (const s of c.sfx)
        if (s.at_s >= c.duration_s)
          ctx.addIssue({ code: "custom", message: `sound "${s.id}" is after its clip ends` });
    }
    const total = t.clips.reduce((n, c) => n + c.duration_s, 0);
    if (total > MAX_TIMELINE_SECONDS)
      ctx.addIssue({
        code: "custom",
        message: `the video is ${Math.round(total)} s; the most is ${MAX_TIMELINE_SECONDS} s`,
      });
  });
export type Timeline = z.infer<typeof timelineSchema>;

/** The stored timeline as the API returns it. */
export const storedTimelineSchema = z.object({
  project_id: z.string(),
  /** 0 when nothing has been saved yet (the timeline was built from the production). */
  revision: z.number().int().min(0),
  timeline: timelineSchema,
  updated_at: z.string().nullable(),
});
export type StoredTimeline = z.infer<typeof storedTimelineSchema>;

/** PUT /projects/:id/timeline */
export const saveTimelineRequestSchema = z.object({
  /** The revision this edit started from; the save is refused if the server has moved on. */
  base_revision: z.number().int().min(0),
  timeline: z.unknown(),
});

export const timelineRevisionSchema = z.object({
  revision: z.number().int().min(1),
  reason: z.string(),
  created_at: z.string(),
});
export type TimelineRevision = z.infer<typeof timelineRevisionSchema>;

/* ---------------------------------- building ---------------------------------- */

export interface ProductionScene {
  id: string;
  scene_number: number;
  description: string;
  voiceover: string | null;
  duration_seconds: number;
  visual_type: (typeof SCENE_VISUAL_TYPES)[number];
}
export interface ProductionAsset {
  id: string;
  scene_id: string | null;
  asset_type: string;
}
export interface SceneDirection {
  scene_number: number;
  shot?: (typeof SHOT_SIZES)[number];
  camera?: (typeof CAMERA_MOVES)[number];
  transition_in?: (typeof SCENE_TRANSITIONS)[number];
  on_screen_text?: string | null;
}

/** The default transition length, matching the renderer's blend (14 frames at 30 fps). */
export const DEFAULT_TRANSITION_SECONDS = 14 / 30;

/**
 * The timeline a production implies before any edit: one clip per scene in scene order, with the
 * scene's newest media, narration and the blueprint's direction. Rendering it gives exactly the
 * video the pre-editor renderer made.
 */
export function timelineFromProduction(input: {
  aspect_ratio: (typeof ASPECT_RATIOS)[number];
  scenes: ProductionScene[];
  assets: ProductionAsset[];
  directions?: SceneDirection[];
  music?: { mood: (typeof MUSIC_MOODS)[number]; tempo_bpm: number } | null;
}): Timeline {
  const dir = new Map((input.directions ?? []).map((d) => [d.scene_number, d]));
  const newest = (sceneId: string, type: string) =>
    input.assets.filter((a) => a.scene_id === sceneId && a.asset_type === type).at(-1)?.id ?? null;
  const scenes = [...input.scenes].sort((a, b) => a.scene_number - b.scene_number);
  return {
    version: TIMELINE_VERSION,
    aspect_ratio: input.aspect_ratio,
    clips: scenes.map((s) => {
      const d = dir.get(s.scene_number);
      const text = (s.voiceover ?? "").trim();
      const voiceAsset = newest(s.id, "voiceover");
      return {
        id: `c_${s.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`,
        scene_id: s.id,
        description: s.description.slice(0, 500),
        visual_type: s.visual_type,
        image_asset_id: newest(s.id, "image"),
        video_asset_id: newest(s.id, "video"),
        duration_s: Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, s.duration_seconds)),
        trim_in_s: 0,
        focal: { x: 0.5, y: 0.5 },
        shot: d?.shot ?? null,
        camera: d?.camera ?? null,
        transition_in: d?.transition_in
          ? { kind: d.transition_in, duration_s: DEFAULT_TRANSITION_SECONDS }
          : null,
        voice: {
          mode: !text ? "none" : voiceAsset ? "asset" : "kokoro",
          text: text.slice(0, 1000),
          asset_id: voiceAsset,
          voice_id: null,
          speed: null,
          gain_db: 0,
        },
        caption: null,
        on_screen_text: d?.on_screen_text ?? null,
        overlays: [],
        sfx: [],
      };
    }),
    captions: { enabled: true, style: "bold", position: "bottom" },
    music: {
      mode: "generated",
      mood: input.music?.mood ?? null,
      tempo_bpm: input.music?.tempo_bpm ?? null,
      gain_db: 0,
      duck_under_voice: true,
    },
    auto_transition_sfx: true,
  };
}

/* --------------------------------- compiling --------------------------------- */

/** One scene of the render manifest (the shape renderManifestSchema accepts). */
export interface CompiledScene {
  scene_number: number;
  start_seconds: number;
  duration_seconds: number;
  visual_type: (typeof SCENE_VISUAL_TYPES)[number];
  caption: string;
  narration: string | null;
  image_url: string | null;
  voice_url: string | null;
  shot?: (typeof SHOT_SIZES)[number];
  camera?: (typeof CAMERA_MOVES)[number];
  transition_in?: (typeof SCENE_TRANSITIONS)[number];
  on_screen_text?: string | null;
  video_url?: string | null;
  credit?: string | null;
  overlays?: Omit<TextOverlay, "id">[];
  sfx?: Omit<SfxCue, "id">[];
  voice_id?: string;
  voice_speed?: number;
  voice_gain_db?: number;
  transition_seconds?: number;
  focal?: { x: number; y: number };
  trim_in_seconds?: number;
}

export interface CompiledTimeline {
  aspect_ratio: (typeof ASPECT_RATIOS)[number];
  duration_seconds: number;
  scenes: CompiledScene[];
  music?: { mood: (typeof MUSIC_MOODS)[number]; tempo_bpm: number };
  captions?: Timeline["captions"];
  audio?: {
    music: boolean;
    music_gain_db: number;
    duck_under_voice: boolean;
    transition_sfx: boolean;
  };
}

/**
 * Turns a timeline into the renderer's manifest scenes. `media` resolves an asset id to its URL
 * (and footage credit); an id it doesn't know (a deleted asset) is treated as missing, so the
 * clip falls back to its other media or a text card instead of failing the render.
 */
export function compileTimeline(
  timeline: Timeline,
  media: (assetId: string) => { url: string; credit?: string | null } | null,
): CompiledTimeline {
  let start = 0;
  const scenes = timeline.clips.map((c, i): CompiledScene => {
    const image = c.image_asset_id ? media(c.image_asset_id) : null;
    const video = c.video_asset_id ? media(c.video_asset_id) : null;
    const voice = c.voice.mode === "asset" && c.voice.asset_id ? media(c.voice.asset_id) : null;
    const narration = c.voice.mode === "none" ? null : c.voice.text.trim() || null;
    const scene: CompiledScene = {
      scene_number: i + 1,
      start_seconds: Math.round(start * 1000) / 1000,
      duration_seconds: c.duration_s,
      visual_type: c.visual_type,
      caption: c.caption ?? (narration || c.description),
      narration,
      image_url: image?.url ?? null,
      voice_url: voice?.url ?? null,
      ...(c.shot ? { shot: c.shot } : {}),
      ...(c.camera ? { camera: c.camera } : {}),
      ...(c.transition_in ? { transition_in: c.transition_in.kind } : {}),
      ...(c.on_screen_text !== null || c.shot || c.camera || c.transition_in
        ? { on_screen_text: c.on_screen_text }
        : {}),
      ...(video ? { video_url: video.url, credit: video.credit ?? null } : {}),
      // Editor fields, only when they differ from the defaults (so unedited plans don't change).
      ...(c.overlays.length ? { overlays: c.overlays.map(({ id: _id, ...o }) => o) } : {}),
      ...(c.sfx.length ? { sfx: c.sfx.map(({ id: _id, ...s }) => s) } : {}),
      ...(c.voice.voice_id ? { voice_id: c.voice.voice_id } : {}),
      ...(c.voice.speed !== null ? { voice_speed: c.voice.speed } : {}),
      ...(c.voice.gain_db !== 0 ? { voice_gain_db: c.voice.gain_db } : {}),
      ...(c.transition_in &&
      Math.abs(c.transition_in.duration_s - DEFAULT_TRANSITION_SECONDS) > 0.001
        ? { transition_seconds: c.transition_in.duration_s }
        : {}),
      ...(c.focal.x !== 0.5 || c.focal.y !== 0.5 ? { focal: c.focal } : {}),
      ...(c.trim_in_s > 0 ? { trim_in_seconds: c.trim_in_s } : {}),
    };
    start += c.duration_s;
    return scene;
  });
  const m = timeline.music;
  const cap = timeline.captions;
  const defaultMix =
    m.mode === "generated" && m.gain_db === 0 && m.duck_under_voice && timeline.auto_transition_sfx;
  return {
    aspect_ratio: timeline.aspect_ratio,
    duration_seconds: start,
    scenes,
    ...(m.mode === "generated" && m.mood && m.tempo_bpm
      ? { music: { mood: m.mood, tempo_bpm: m.tempo_bpm } }
      : {}),
    ...(cap.enabled && cap.style === "bold" && cap.position === "bottom" ? {} : { captions: cap }),
    ...(defaultMix
      ? {}
      : {
          audio: {
            music: m.mode === "generated",
            music_gain_db: m.gain_db,
            duck_under_voice: m.duck_under_voice,
            transition_sfx: timeline.auto_transition_sfx,
          },
        }),
  };
}

/** Every asset id a timeline refers to (for ownership checks and cleanup). */
export function timelineAssetIds(t: Timeline): string[] {
  const ids = new Set<string>();
  for (const c of t.clips)
    for (const a of [c.image_asset_id, c.video_asset_id, c.voice.asset_id]) if (a) ids.add(a);
  return [...ids];
}
