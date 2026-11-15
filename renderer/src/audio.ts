import type { MusicMood } from "@avs/types";
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
  opts: {
    music?: boolean | { mood: MusicMood; tempo_bpm: number };
    /** Transition effects, synthesized here (no files, no licences). */
    sfx?: { at: number; kind: "whoosh" | "hit" }[];
  } = {},
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
  if (opts.music)
    addBackingTrack(
      ctx,
      totalSeconds,
      spoken,
      musicPlan(
        opts.music === true ? undefined : opts.music.mood,
        opts.music === true ? undefined : opts.music.tempo_bpm,
      ),
    );
  for (const cue of opts.sfx ?? [])
    if (cue.at < totalSeconds - 0.1) (cue.kind === "whoosh" ? addWhoosh : addHit)(ctx, cue.at);
  const rendered = await ctx.startRendering();
  return encodeWav([rendered.getChannelData(0), rendered.getChannelData(1)], SAMPLE_RATE);
}

// Note frequencies (Hz) for the chords below.
const N = {
  F3: 174.61,
  G3: 196.0,
  A3: 220.0,
  Bb3: 233.08,
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  A4: 440.0,
} as const;
const C = [N.C4, N.E4, N.G4];
const G = [N.G3, 246.94, N.D4];
const Am = [N.A3, N.C4, N.E4];
const F = [N.F3, N.A3, N.C4];
const Dm = [N.D4, N.F4, N.A4];
const Bb = [N.Bb3, N.D4, N.F4];

export interface MusicPlan {
  chords: number[][];
  tempo_bpm: number;
  /** Plucked eighth-note arpeggio on top. */
  arpeggio: boolean;
  /** Pulsing eighth-note bass instead of a held one. */
  pulse: boolean;
  /** Low-pass cut-off: darker (lower) for ambient moods. */
  brightness: number;
}

/** Chords, tempo and texture for a mood (the default when the plan has no music direction). */
export function musicPlan(mood?: MusicMood, tempo?: number): MusicPlan {
  const plans: Record<MusicMood, Omit<MusicPlan, "tempo_bpm"> & { tempo_bpm: number }> = {
    upbeat: {
      chords: [C, G, Am, F],
      tempo_bpm: 116,
      arpeggio: true,
      pulse: true,
      brightness: 2600,
    },
    light: {
      chords: [F, C, Dm, Bb],
      tempo_bpm: 92,
      arpeggio: true,
      pulse: false,
      brightness: 2000,
    },
    ambient: {
      chords: [Am, F, C, G],
      tempo_bpm: 76,
      arpeggio: false,
      pulse: false,
      brightness: 1100,
    },
    playful: {
      chords: [C, F, G, C],
      tempo_bpm: 100,
      arpeggio: true,
      pulse: false,
      brightness: 2400,
    },
    driving: {
      chords: [Am, F, C, G],
      tempo_bpm: 104,
      arpeggio: true,
      pulse: true,
      brightness: 2000,
    },
    warm: {
      chords: [F, Am, Bb, C],
      tempo_bpm: 88,
      arpeggio: false,
      pulse: false,
      brightness: 1500,
    },
  };
  const p = plans[mood ?? "light"];
  return { ...p, tempo_bpm: Math.min(140, Math.max(60, Math.round(tempo ?? p.tempo_bpm))) };
}

/** Generated backing music: a warm pad, a soft bass and a light plucked pattern. */
function addBackingTrack(
  ctx: OfflineAudioContext,
  total: number,
  spoken: [number, number][],
  plan: MusicPlan,
) {
  const BEAT = 60 / plan.tempo_bpm;
  const bus = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = plan.brightness;
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
    const chord = plan.chords[k % plan.chords.length] as number[];
    const end = Math.min(total, t + chordSeconds);
    for (const f of chord) tone(ctx, bus, f, "triangle", t, end, 0.05, 0.6, 0.8);
    const root = (chord[0] as number) / 2;
    if (plan.pulse)
      for (let n = 0; t + (n * BEAT) / 2 < end; n++) {
        const at = t + (n * BEAT) / 2;
        tone(ctx, bus, root, "sine", at, Math.min(end, at + BEAT * 0.4), 0.08, 0.005, 0.15);
      }
    else tone(ctx, bus, root, "sine", t, end, 0.09, 0.3, 0.5);
    // Plucked arpeggio on eighth notes.
    for (let n = 0; plan.arpeggio && n < 16 && t + (n * BEAT) / 2 < end; n++) {
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

/** Filtered noise sweeping upwards: an air "whoosh" for whip, slide and zoom transitions. */
function addWhoosh(ctx: OfflineAudioContext, at: number): void {
  const seconds = 0.5;
  const noise = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = noise.getChannelData(0);
  let seed = 1234567 + Math.round(at * 1000);
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // deterministic, so renders are repeatable
    data[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.8;
  band.frequency.setValueAtTime(350, at);
  band.frequency.exponentialRampToValueAtTime(3200, at + seconds);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  // Band-passed noise keeps only a slice of its energy, so the peak gain is high (≈ −16 dB out).
  gain.gain.exponentialRampToValueAtTime(0.9, at + seconds * 0.55);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  src.connect(band).connect(gain).connect(ctx.destination);
  src.start(at);
  src.stop(at + seconds);
}

/** A soft low thump for flash transitions. */
function addHit(ctx: OfflineAudioContext, at: number): void {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(110, at);
  osc.frequency.exponentialRampToValueAtTime(45, at + 0.25);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.22, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.32);
}
