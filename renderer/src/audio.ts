import { encodeWav } from "./wav";

export const SAMPLE_RATE = 48000;

export interface NarrationClip {
  buffer: AudioBuffer | null;
  startSeconds: number;
  maxSeconds: number;
}

/**
 * Mixes each scene's narration at its start time into one stereo track with the Web Audio API
 * (OfflineAudioContext), trimming clips that overrun their scene and adding short fades.
 * With `music`, a soft generated backing track plays underneath and dips while someone speaks.
 */
export async function mixNarration(
  clips: NarrationClip[],
  totalSeconds: number,
  opts: { music?: boolean } = {},
): Promise<Uint8Array> {
  const length = Math.max(1, Math.ceil(totalSeconds * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const spoken: [number, number][] = [];
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
    spoken.push([start, start + dur]);
  }
  if (opts.music) addBackingTrack(ctx, totalSeconds, spoken);
  const rendered = await ctx.startRendering();
  return encodeWav([rendered.getChannelData(0), rendered.getChannelData(1)], SAMPLE_RATE);
}

// A calm four-chord loop (C – G – Am – F), one chord every 2 bars at 90 bpm.
const CHORDS = [
  [261.63, 329.63, 392.0],
  [196.0, 246.94, 293.66],
  [220.0, 261.63, 329.63],
  [174.61, 220.0, 261.63],
];
const BEAT = 60 / 90;

/** Generated backing music: a warm pad, a soft bass and a light plucked pattern. */
function addBackingTrack(ctx: OfflineAudioContext, total: number, spoken: [number, number][]) {
  const bus = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1800;
  bus.connect(filter).connect(ctx.destination);
  // Ducking: music at 0.16 normally, 0.06 under narration, with short ramps.
  const LOUD = 0.16;
  const QUIET = 0.06;
  bus.gain.setValueAtTime(0, 0);
  bus.gain.linearRampToValueAtTime(LOUD, 1.2);
  for (const [a, b] of spoken) {
    bus.gain.setTargetAtTime(QUIET, Math.max(0, a - 0.25), 0.08);
    bus.gain.setTargetAtTime(LOUD, b + 0.1, 0.3);
  }
  bus.gain.setTargetAtTime(0, Math.max(0, total - 1.5), 0.4);

  const chordSeconds = BEAT * 8;
  for (let t = 0, k = 0; t < total; t += chordSeconds, k++) {
    const chord = CHORDS[k % CHORDS.length] as number[];
    const end = Math.min(total, t + chordSeconds);
    for (const f of chord) tone(ctx, bus, f, "triangle", t, end, 0.05, 0.6, 0.8);
    tone(ctx, bus, (chord[0] as number) / 2, "sine", t, end, 0.09, 0.3, 0.5);
    // Plucked arpeggio on eighth notes.
    for (let n = 0; n < 16 && t + (n * BEAT) / 2 < end; n++) {
      const at = t + (n * BEAT) / 2;
      const f = (chord[n % 3] as number) * (n % 4 === 3 ? 2 : 1);
      tone(ctx, bus, f, "sine", at, Math.min(end, at + 0.45), 0.035, 0.005, 0.35);
    }
  }
}

function tone(
  ctx: OfflineAudioContext,
  out: AudioNode,
  freq: number,
  type: OscillatorType,
  start: number,
  end: number,
  level: number,
  attack: number,
  release: number,
) {
  if (end - start < 0.05) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ctx.createGain();
  const a = Math.min(attack, (end - start) / 2);
  const r = Math.min(release, (end - start) / 2);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(level, start + a);
  g.gain.setValueAtTime(level, Math.max(start + a, end - r));
  g.gain.linearRampToValueAtTime(0, end);
  osc.connect(g).connect(out);
  osc.start(start);
  osc.stop(end + 0.01);
}

/** Wraps raw mono samples (e.g. Kokoro output) as an AudioBuffer for the mixer. */
export function samplesToBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({
    length: Math.max(1, samples.length),
    sampleRate,
    numberOfChannels: 1,
  });
  buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buf;
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
