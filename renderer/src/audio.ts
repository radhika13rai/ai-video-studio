import { encodeWav } from "./wav";

export const SAMPLE_RATE = 48000;

/**
 * Mixes each scene's narration at its start time into one stereo track with the Web Audio API
 * (OfflineAudioContext), trimming clips that overrun their scene and adding short fades.
 */
export async function mixNarration(
  clips: { buffer: AudioBuffer | null; startSeconds: number; maxSeconds: number }[],
  totalSeconds: number,
): Promise<Uint8Array> {
  const length = Math.max(1, Math.ceil(totalSeconds * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  for (const clip of clips) {
    if (!clip.buffer) continue;
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    const gain = ctx.createGain();
    const dur = Math.min(clip.buffer.duration, clip.maxSeconds);
    const start = clip.startSeconds + 0.05; // tiny lead-in after the cut
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(1, start + 0.02);
    gain.gain.setValueAtTime(1, Math.max(start + 0.02, start + dur - 0.08));
    gain.gain.linearRampToValueAtTime(0, start + dur);
    src.connect(gain).connect(ctx.destination);
    src.start(start, 0, dur);
  }
  const rendered = await ctx.startRendering();
  return encodeWav([rendered.getChannelData(0), rendered.getChannelData(1)], SAMPLE_RATE);
}

/** Decodes an audio file; returns null instead of failing the render when a clip is broken. */
export async function decodeAudio(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    return await ctx.decodeAudioData(bytes);
  } catch {
    return null;
  }
}
