import type { RenderManifest } from "@avs/schemas";
import { wordGroups, wordTimings, type TimedWord } from "./timeline";

/**
 * Stages shared by the export renderer and the live preview (ADR 046), so both time scenes and
 * captions exactly the same way.
 */

type Scene = RenderManifest["scenes"][number];

/** Seconds of silence kept after a scene's narration. */
export const VOICE_TAIL_SECONDS = 0.35;

/** Each scene lasts at least as long as its narration, so no sentence is cut off. */
export function fitDurations(
  scenes: Scene[],
  voiceSeconds: (number | null | undefined)[],
): number[] {
  return scenes.map((s, i) => {
    const v = voiceSeconds[i];
    return v ? Math.max(s.duration_seconds, v + VOICE_TAIL_SECONDS) : s.duration_seconds;
  });
}

/** The manifest with the fitted scene lengths (start times follow from them). */
export function withDurations(manifest: RenderManifest, durations: number[]): RenderManifest {
  return {
    ...manifest,
    scenes: manifest.scenes.map((s, i) => ({
      ...s,
      duration_seconds: durations[i] ?? s.duration_seconds,
    })),
  };
}

/**
 * Caption word groups for a scene: spread over the narration when there is a voice, otherwise
 * over the scene. Picture scenes show four words at a time; text cards six.
 */
export function sceneWords(
  scene: Scene,
  durationSeconds: number,
  voiceSeconds: number | null,
  hasPicture: boolean,
): TimedWord[][] {
  const text = scene.narration?.trim() || scene.caption;
  const words = voiceSeconds
    ? wordTimings(text, 0.05, Math.min(voiceSeconds, durationSeconds - 0.05))
    : wordTimings(text, 0.2, Math.max(0.5, durationSeconds - 0.5));
  return wordGroups(words, hasPicture ? 4 : 6);
}

/** Downloads a picture; null (and nothing thrown) when it can't be loaded. */
export async function loadPicture(
  url: string,
  doFetch: typeof fetch,
  init: RequestInit,
): Promise<{ blob: Blob; image: ImageBitmap } | null> {
  const res = await doFetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return { blob, image: await createImageBitmap(blob) };
}
