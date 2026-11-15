import type {
  CameraMove,
  MusicMood,
  NarrativeStructure,
  SceneTransition,
  ShotSize,
} from "@avs/types";
import type { ConcreteVideoType } from "../agents/director";

/**
 * Deterministic creative defaults per video type: story structure, pacing, camera vocabulary,
 * transitions, music and look. Every blueprint field can come from here, so a complete blueprint
 * exists even when no model is available (CLAUDE.md rule 15).
 */

export interface BeatTemplate {
  id: string;
  name: string;
  purpose: string;
  /** Share of the total duration. Shares in a template sum to 1. */
  share: number;
  energy: number;
}

export interface CreativeTemplate {
  structure: NarrativeStructure;
  beats: BeatTemplate[];
  avg_shot_seconds: number;
  cut_rhythm: "calm" | "medium" | "fast";
  words_per_second: number;
  cameras: CameraMove[];
  shots: ShotSize[];
  transitions: Exclude<SceneTransition, "cut">[];
  music: { mood: MusicMood; tempo_bpm: number };
  look: { look: string; palette: string; lighting: string; lens: string; texture: string };
}

export const TEMPLATES: Record<ConcreteVideoType, CreativeTemplate> = {
  advertisement: {
    structure: "aida",
    beats: [
      { id: "hook", name: "Hook", purpose: "Stop the scroll", share: 0.15, energy: 0.8 },
      { id: "problem", name: "Problem", purpose: "Name the need", share: 0.2, energy: 0.5 },
      { id: "solution", name: "Solution", purpose: "Show the product", share: 0.3, energy: 0.8 },
      { id: "proof", name: "Proof", purpose: "Why it works", share: 0.2, energy: 0.7 },
      {
        id: "cta",
        name: "Call to action",
        purpose: "Tell them what to do",
        share: 0.15,
        energy: 1,
      },
    ],
    avg_shot_seconds: 2,
    cut_rhythm: "fast",
    words_per_second: 2.6,
    cameras: ["push_in", "orbit", "pan_right", "pull_out"],
    shots: ["close", "medium", "extreme_close", "wide"],
    transitions: ["whip", "flash", "zoom"],
    music: { mood: "upbeat", tempo_bpm: 116 },
    look: {
      look: "premium product commercial",
      palette: "clean high-contrast colours",
      lighting: "bright studio key light with soft rim light",
      lens: "50mm, shallow depth of field",
      texture: "crisp, polished",
    },
  },
  explainer: {
    structure: "tutorial",
    beats: [
      { id: "hook", name: "Hook", purpose: "Pose the question", share: 0.15, energy: 0.7 },
      { id: "context", name: "Context", purpose: "Why it matters", share: 0.2, energy: 0.5 },
      { id: "steps", name: "Steps", purpose: "Explain clearly", share: 0.5, energy: 0.6 },
      { id: "recap", name: "Recap", purpose: "Sum it up", share: 0.15, energy: 0.7 },
    ],
    avg_shot_seconds: 3,
    cut_rhythm: "medium",
    words_per_second: 2.5,
    cameras: ["static", "push_in", "pan_right", "tilt_up"],
    shots: ["medium", "wide", "close", "overhead"],
    transitions: ["slide", "crossfade", "zoom"],
    music: { mood: "light", tempo_bpm: 92 },
    look: {
      look: "clean informative illustration-like photography",
      palette: "friendly bright colours",
      lighting: "even soft daylight",
      lens: "35mm, deep focus",
      texture: "clean",
    },
  },
  cinematic: {
    structure: "three_act",
    beats: [
      { id: "setup", name: "Setup", purpose: "Establish the world", share: 0.25, energy: 0.4 },
      { id: "rising", name: "Rising action", purpose: "Build tension", share: 0.45, energy: 0.7 },
      { id: "climax", name: "Climax", purpose: "The big moment", share: 0.2, energy: 1 },
      { id: "resolve", name: "Resolution", purpose: "Land the feeling", share: 0.1, energy: 0.5 },
    ],
    avg_shot_seconds: 3.2,
    cut_rhythm: "calm",
    words_per_second: 2.2,
    cameras: ["pull_out", "pan_left", "tilt_up", "push_in", "orbit"],
    shots: ["wide", "medium", "close", "extreme_close"],
    transitions: ["crossfade", "zoom", "whip"],
    music: { mood: "ambient", tempo_bpm: 76 },
    look: {
      look: "cinematic film still",
      palette: "teal and amber grade",
      lighting: "dramatic low-key light with volumetric haze",
      lens: "anamorphic 35mm, shallow depth of field",
      texture: "subtle film grain",
    },
  },
  animation: {
    structure: "story",
    beats: [
      { id: "intro", name: "Introduction", purpose: "Meet the world", share: 0.2, energy: 0.5 },
      { id: "character", name: "Character", purpose: "Meet the hero", share: 0.25, energy: 0.6 },
      {
        id: "conflict",
        name: "Conflict",
        purpose: "Something goes wrong",
        share: 0.35,
        energy: 0.9,
      },
      { id: "resolution", name: "Resolution", purpose: "Happy ending", share: 0.2, energy: 0.7 },
    ],
    avg_shot_seconds: 2.8,
    cut_rhythm: "medium",
    words_per_second: 2.4,
    cameras: ["orbit", "pan_right", "push_in", "tilt_down"],
    shots: ["wide", "medium", "close"],
    transitions: ["zoom", "slide", "crossfade"],
    music: { mood: "playful", tempo_bpm: 100 },
    look: {
      look: "3D animated feature film style",
      palette: "vibrant saturated colours",
      lighting: "soft warm global illumination",
      lens: "wide friendly framing",
      texture: "smooth stylised surfaces",
    },
  },
  faceless: {
    structure: "listicle",
    beats: [
      { id: "hook", name: "Hook", purpose: "Promise the payoff", share: 0.15, energy: 0.8 },
      { id: "items", name: "Main points", purpose: "Deliver each point", share: 0.7, energy: 0.7 },
      { id: "payoff", name: "Payoff", purpose: "Close strong", share: 0.15, energy: 0.9 },
    ],
    avg_shot_seconds: 2.4,
    cut_rhythm: "fast",
    words_per_second: 2.6,
    cameras: ["push_in", "handheld", "pan_left", "pull_out"],
    shots: ["close", "medium", "wide", "extreme_close"],
    transitions: ["whip", "zoom", "slide"],
    music: { mood: "driving", tempo_bpm: 104 },
    look: {
      look: "striking documentary photography",
      palette: "rich natural colours",
      lighting: "dramatic natural light",
      lens: "35mm",
      texture: "sharp detail",
    },
  },
  presenter: {
    structure: "direct_address",
    beats: [
      { id: "hello", name: "Opening", purpose: "Greet and hook", share: 0.2, energy: 0.7 },
      { id: "body", name: "Main message", purpose: "Deliver the message", share: 0.6, energy: 0.6 },
      { id: "close", name: "Close", purpose: "Sign off", share: 0.2, energy: 0.8 },
    ],
    avg_shot_seconds: 3.5,
    cut_rhythm: "calm",
    words_per_second: 2.5,
    cameras: ["static", "push_in", "pan_right"],
    shots: ["medium", "close", "wide"],
    transitions: ["crossfade", "slide"],
    music: { mood: "warm", tempo_bpm: 88 },
    look: {
      look: "bright modern studio",
      palette: "warm neutral tones",
      lighting: "soft three-point lighting",
      lens: "50mm",
      texture: "clean",
    },
  },
};

/** Beat time ranges for a duration, rounded to 0.1 s, ending exactly at the duration. */
export function beatsFor(
  template: CreativeTemplate,
  duration: number,
): { id: string; name: string; purpose: string; start_s: number; end_s: number }[] {
  let at = 0;
  return template.beats.map((b, i) => {
    const end =
      i === template.beats.length - 1 ? duration : Math.round((at + b.share * duration) * 10) / 10;
    const beat = { id: b.id, name: b.name, purpose: b.purpose, start_s: at, end_s: end };
    at = end;
    return beat;
  });
}
