import type { AspectRatio } from "@avs/types";
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
  /** Scale at the start and end of the scene (1 = image just covers the frame). */
  zoomFrom: number;
  zoomTo: number;
  /** Pan as a fraction of the spare image area (-1…1) at the start and end. */
  panX: [number, number];
  panY: [number, number];
}

/** Gentle Ken Burns motion, varied by scene but fully deterministic. */
export function motionFor(index: number): Motion {
  const variants: Motion[] = [
    { zoomFrom: 1.0, zoomTo: 1.12, panX: [0, 0], panY: [0, 0] },
    { zoomFrom: 1.12, zoomTo: 1.0, panX: [0.3, -0.3], panY: [0, 0] },
    { zoomFrom: 1.05, zoomTo: 1.15, panX: [-0.4, 0.4], panY: [0.2, -0.2] },
    { zoomFrom: 1.15, zoomTo: 1.04, panX: [0, 0], panY: [-0.4, 0.4] },
  ];
  return variants[index % variants.length] as Motion;
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
