/**
 * Motion maths for graphics scenes (ADR 048). Pure functions of the frame number, so a frame
 * looks the same in the export, the live preview and after a seek.
 */

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeInOutCubic = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const easeInCubic = (t: number) => clamp01(t) ** 3;

export interface SpringConfig {
  /** Angular frequency (radians per second); higher is snappier. */
  omega: number;
  /** Damping ratio: below 1 overshoots, 1 settles without overshoot. */
  zeta: number;
}

/** Snappy with a visible overshoot: letters, pops. */
export const POP: SpringConfig = { omega: 16, zeta: 0.45 };
/** Smooth and slightly springy: cards, layout moves. */
export const SOFT: SpringConfig = { omega: 11, zeta: 0.72 };
/** No overshoot: the persistent objects gliding between scenes. */
export const GLIDE: SpringConfig = { omega: 8, zeta: 1 };

/**
 * A damped spring going from 0 to 1, `frames` frames after it started (0 before the start).
 * Closed form, so it is exact and deterministic for any frame.
 */
export function spring(frames: number, fps: number, cfg: SpringConfig = SOFT): number {
  if (frames <= 0) return 0;
  const t = frames / fps;
  const { omega: w, zeta: z } = cfg;
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w * t) * (1 + w * t);
}

/** Opacity of a graphics element: fades out over the last `frames` frames of its scene. */
export const EXIT_FRAMES = 7;
export function exitFade(local: number, durationFrames: number, frames = EXIT_FRAMES): number {
  return clamp01((durationFrames - 1 - local) / frames);
}
