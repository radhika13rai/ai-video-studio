import type { AspectRatio, CameraMove, SceneTransition, ShotSize } from "@avs/types";
import type { RenderManifest } from "@avs/schemas";

/** Pure timing and layout maths. No browser APIs, so it is unit-tested in Node. */

export const FPS = 30;

export type Quality = "720p" | "1080p";

export function outputSize(
  aspect: AspectRatio,
  quality: Quality,
): { width: number; height: number } {
  const short = quality === "1080p" ? 1080 : 720;
  const long = quality === "1080p" ? 1920 : 1280;
  if (aspect === "9:16") return { width: short, height: long };
  if (aspect === "16:9") return { width: long, height: short };
  return { width: short, height: short };
}

export interface TimedScene {
  index: number;
  scene: RenderManifest["scenes"][number];
  startFrame: number;
  frameCount: number;
}

/** Converts scene seconds to whole frames that add up exactly to the total. */
export function buildTimeline(
  manifest: RenderManifest,
  fps = FPS,
): { scenes: TimedScene[]; totalFrames: number } {
  const total = manifest.scenes.reduce((n, s) => n + s.duration_seconds, 0);
  const totalFrames = Math.max(1, Math.round(total * fps));
  let acc = 0;
  let prevFrame = 0;
  const scenes = manifest.scenes.map((scene, index) => {
    acc += scene.duration_seconds;
    const endFrame = index === manifest.scenes.length - 1 ? totalFrames : Math.round(acc * fps);
    const t: TimedScene = {
      index,
      scene,
      startFrame: prevFrame,
      frameCount: Math.max(1, endFrame - prevFrame),
    };
    prevFrame = endFrame;
    return t;
  });
  return { scenes, totalFrames };
}

export function sceneAt(timeline: TimedScene[], frame: number): TimedScene {
  for (const t of timeline) if (frame < t.startFrame + t.frameCount) return t;
  return timeline[timeline.length - 1] as TimedScene;
}

export interface CaptionChunk {
  text: string;
  /** Fractions of the scene (0–1) during which the chunk is shown. */
  from: number;
  to: number;
}

/**
 * Splits narration into short on-screen chunks (about `maxWords` words, preferring sentence and
 * comma breaks), timed in proportion to their length so they follow the voice.
 */
export function captionChunks(text: string, maxWords = 6): CaptionChunk[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    const breakHere =
      /[.!?]$/.test(w) || (/[,;:]$/.test(w) && cur.length >= 3) || cur.length >= maxWords;
    if (breakHere) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) {
    // Avoid a dangling one-word chunk at the end.
    const last = chunks[chunks.length - 1];
    if (cur.length === 1 && last && last.length < maxWords + 2) last.push(...cur);
    else chunks.push(cur);
  }
  const weights = chunks.map((c) => c.join(" ").length + 2);
  const sum = weights.reduce((a, b) => a + b, 0);
  let at = 0;
  return chunks.map((c, i) => {
    const from = at / sum;
    at += weights[i] ?? 0;
    return { text: c.join(" "), from, to: i === chunks.length - 1 ? 1 : at / sum };
  });
}

export function captionAt(chunks: CaptionChunk[], progress: number): string | null {
  for (const c of chunks) if (progress >= c.from && progress < c.to) return c.text;
  return chunks.length > 0 && progress >= 1 ? (chunks[chunks.length - 1]?.text ?? null) : null;
}

export interface Motion {
  /** Scale at the start and end of the shot (1 = image just covers the frame). */
  zoomFrom: number;
  zoomTo: number;
  /** Pan as a fraction of the spare image area (-1…1) at the start and end. */
  panX: [number, number];
  panY: [number, number];
}

/** Ken Burns motion for a whole scene (kept for text cards and the 2D fallback). */
export function motionFor(index: number): Motion {
  const variants: Motion[] = [
    { zoomFrom: 1.0, zoomTo: 1.18, panX: [0, 0], panY: [0, 0] },
    { zoomFrom: 1.2, zoomTo: 1.04, panX: [0.4, -0.4], panY: [0, 0] },
    { zoomFrom: 1.08, zoomTo: 1.24, panX: [-0.5, 0.5], panY: [0.25, -0.25] },
    { zoomFrom: 1.22, zoomTo: 1.06, panX: [0, 0], panY: [-0.5, 0.5] },
  ];
  return variants[index % variants.length] as Motion;
}

/**
 * A shot is a stretch of a scene with its own framing, like an editor cutting between a wide
 * shot and close-ups of the same picture. `camera` is a sideways move (-1…1) that the depth
 * renderer turns into parallax.
 */
export interface Shot extends Motion {
  /** Handheld-style drift strength (1 = normal). */
  drift?: number;
  startFrame: number; // relative to the scene
  frameCount: number;
  camera: [number, number];
}

/** Target shot length; scenes are split into shots of roughly this many seconds. */
export const SHOT_SECONDS = 2.6;

/** Deterministic pseudo-random number in [0, 1) from integers (no Math.random: renders repeat). */
export function hash01(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= v + 0x9e3779b9;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** How much of the picture each shot size shows (1 = whole picture). */
const SHOT_ZOOM: Record<ShotSize, number> = {
  wide: 1.02,
  medium: 1.15,
  close: 1.32,
  extreme_close: 1.55,
  overhead: 1.12,
  pov: 1.2,
};

/** A planned camera move turned into zoom, pan and parallax for one shot. */
export function cameraMotion(
  camera: CameraMove,
  base: number,
  focus: { x: number; y: number } = { x: 0, y: 0 },
): Omit<Shot, "startFrame" | "frameCount"> {
  const at = (
    zoomFrom: number,
    zoomTo: number,
    panX: [number, number],
    panY: [number, number],
    cam: [number, number],
    drift = 1,
  ) => ({
    zoomFrom,
    zoomTo,
    panX: [panX[0] + focus.x, panX[1] + focus.x] as [number, number],
    panY: [panY[0] + focus.y, panY[1] + focus.y] as [number, number],
    camera: cam,
    drift,
  });
  switch (camera) {
    case "static":
      return at(base, base, [0, 0], [0, 0], [0, 0], 0.35);
    case "push_in":
      return at(base, base + 0.2, [0, 0], [0.05, -0.05], [-0.3, 0.3]);
    case "pull_out":
      return at(base + 0.2, base, [0, 0], [-0.05, 0.05], [0.3, -0.3]);
    case "pan_left":
      return at(base + 0.1, base + 0.1, [0.55, -0.55], [0, 0], [1, -1]);
    case "pan_right":
      return at(base + 0.1, base + 0.1, [-0.55, 0.55], [0, 0], [-1, 1]);
    case "tilt_up":
      return at(base + 0.1, base + 0.12, [0, 0], [0.55, -0.55], [0, 0]);
    case "tilt_down":
      return at(base + 0.1, base + 0.12, [0, 0], [-0.55, 0.55], [0, 0]);
    case "orbit":
      return at(base + 0.06, base + 0.14, [-0.4, 0.4], [0.05, -0.05], [-1.4, 1.4]);
    case "handheld":
      return at(base + 0.04, base + 0.1, [-0.1, 0.1], [0, 0], [-0.4, 0.4], 2.2);
  }
}

export function shotsFor(
  sceneIndex: number,
  frameCount: number,
  fps = FPS,
  direction: { shot?: ShotSize | undefined; camera?: CameraMove | undefined } = {},
): Shot[] {
  const count = Math.max(1, Math.min(4, Math.round(frameCount / (SHOT_SECONDS * fps))));
  const shots: Shot[] = [];
  let start = 0;
  for (let k = 0; k < count; k++) {
    const end = k === count - 1 ? frameCount : Math.round(((k + 1) * frameCount) / count);
    const r = (i: number) => hash01(sceneIndex, k, i);
    const frames = { startFrame: start, frameCount: Math.max(1, end - start) };
    start = end;
    if (direction.camera) {
      // Planned direction: the first shot uses the planned size; later shots punch in closer
      // on another part of the picture, all with the planned camera move.
      const base = SHOT_ZOOM[direction.shot ?? "medium"] + (k > 0 ? 0.2 + r(1) * 0.15 : 0);
      const focus = k > 0 ? { x: (r(3) - 0.5) * 1.2, y: (r(4) - 0.5) * 0.8 } : { x: 0, y: 0 };
      shots.push({ ...frames, ...cameraMotion(direction.camera, base, focus) });
      continue;
    }
    const dir = (sceneIndex + k) % 2 === 0 ? 1 : -1;
    // First shot of a scene is the wide establishing shot; later ones punch in on a region.
    const close = k > 0;
    const zoomBase = close ? 1.3 + r(1) * 0.25 : 1.04;
    const push = 0.1 + r(2) * 0.08;
    const focusX = close ? (r(3) - 0.5) * 1.4 : 0;
    const focusY = close ? (r(4) - 0.5) * 0.9 : 0;
    const zoomIn = (sceneIndex + k) % 3 !== 2;
    shots.push({
      ...frames,
      zoomFrom: zoomIn ? zoomBase : zoomBase + push,
      zoomTo: zoomIn ? zoomBase + push : zoomBase,
      panX: [focusX - 0.25 * dir, focusX + 0.25 * dir],
      panY: [focusY + 0.1, focusY - 0.1],
      camera: [-dir, dir],
    });
  }
  return shots;
}

export function shotAt(shots: Shot[], localFrame: number): { shot: Shot; index: number } {
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i] as Shot;
    if (localFrame < s.startFrame + s.frameCount) return { shot: s, index: i };
  }
  return { shot: shots[shots.length - 1] as Shot, index: shots.length - 1 };
}

export type TransitionKind = "crossfade" | "zoom" | "slide" | "flash" | "whip";
const TRANSITIONS: TransitionKind[] = ["zoom", "slide", "crossfade", "whip", "flash"];
/** Length of a scene-to-scene transition, centred on the cut. */
export const TRANSITION_FRAMES = 14;

export interface Transition {
  from: TimedScene;
  to: TimedScene;
  /** 0 → 1 across the transition. */
  progress: number;
  kind: TransitionKind;
}

/** The transition happening at `frame`, if the frame is close to a cut between two scenes. */
export function transitionAt(timeline: TimedScene[], frame: number): Transition | null {
  const half = TRANSITION_FRAMES / 2;
  for (let i = 1; i < timeline.length; i++) {
    const to = timeline[i] as TimedScene;
    const from = timeline[i - 1] as TimedScene;
    const planned: SceneTransition | undefined = to.scene.transition_in;
    if (planned === "cut") continue; // a planned hard cut: no blend
    const want = to.scene.transition_seconds ? (to.scene.transition_seconds * FPS) / 2 : half;
    const span = Math.max(1, Math.min(want, from.frameCount / 3, to.frameCount / 3));
    if (frame >= to.startFrame - span && frame < to.startFrame + span) {
      return {
        from,
        to,
        progress: (frame - (to.startFrame - span)) / (2 * span),
        kind: planned ?? (TRANSITIONS[(i - 1) % TRANSITIONS.length] as TransitionKind),
      };
    }
  }
  return null;
}

export interface TimedWord {
  text: string;
  /** Seconds from the start of the scene. */
  start: number;
  end: number;
}

/**
 * Spreads narration words across the time the voice actually speaks, weighted by length and
 * with small pauses after punctuation, so captions highlight the word being said.
 */
export function wordTimings(text: string, voiceStart: number, voiceSeconds: number): TimedWord[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || voiceSeconds <= 0) return [];
  const weight = (w: string) =>
    w.replace(/[^\p{L}\p{N}]/gu, "").length + 2 + (/[.!?]$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0);
  const weights = words.map(weight);
  const sum = weights.reduce((a, b) => a + b, 0);
  let at = voiceStart;
  return words.map((w, i) => {
    const d = ((weights[i] ?? 0) / sum) * voiceSeconds;
    const t = { text: w, start: at, end: at + d };
    at += d;
    return t;
  });
}

/** Groups timed words into short caption lines (Reels style: a few words at a time). */
export function wordGroups(words: TimedWord[], maxWords = 4): TimedWord[][] {
  const groups: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords || /[.!?,;:]$/.test(w.text)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** The caption group on screen at `seconds` and which word in it is being spoken. */
export function activeWords(
  groups: TimedWord[][],
  seconds: number,
): { group: TimedWord[]; active: number } | null {
  for (const g of groups) {
    const first = g[0] as TimedWord;
    const last = g[g.length - 1] as TimedWord;
    if (seconds >= first.start && seconds < last.end + 0.15) {
      let active = g.findIndex((w) => seconds >= w.start && seconds < w.end);
      if (active < 0) active = g.length - 1;
      return { group: g, active };
    }
  }
  return null;
}

/** Smooth ease in-out (0–1 → 0–1). */
export const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Source rectangle that covers a `dw`×`dh` frame with an `sw`×`sh` image at the given zoom and
 * pan (centre-crop, so square images fill vertical and horizontal frames).
 */
export function coverRect(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  zoom: number,
  panX: number,
  panY: number,
) {
  const scale = Math.max(dw / sw, dh / sh) * zoom;
  const w = dw / scale;
  const h = dh / scale;
  const x = (sw - w) / 2 + ((sw - w) / 2) * panX;
  const y = (sh - h) / 2 + ((sh - h) / 2) * panY;
  return { x, y, w, h };
}

/** Wraps text into lines that fit `maxWidth` using a measuring function. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.length === 2 ? balanceTwo(words, maxWidth, measure) : lines;
}

/** Splits two-line captions near the middle, so a short word is never left alone on a line. */
function balanceTwo(words: string[], maxWidth: number, measure: (s: string) => number): string[] {
  let best: string[] = [];
  let bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const wa = measure(a);
    const wb = measure(b);
    const widest = Math.max(wa, wb);
    if (wa <= maxWidth && wb <= maxWidth && widest < bestWidth) {
      best = [a, b];
      bestWidth = widest;
    }
  }
  return best.length ? best : [words.join(" ")];
}
