import { KOKORO_VOICES, type KokoroVoiceId } from "@avs/contracts";
import type { RenderManifest } from "@avs/schemas";
import { decodeAudio, mixNarration, samplesToBuffer, type SfxCueAt } from "./audio";
import type { DepthMap } from "./depth";
import { JpegFramesSink, pickWebCodecsConfig, WebCodecsSink, type FrameSink } from "./encoders";
import { assembleMp4, loadFFmpeg } from "./ffmpeg";
import { makeGrain, paintFrame, type FrameContext, type SceneMedia } from "./painter";
import { ParallaxRenderer } from "./parallax";
import { graphicsSfxCues, loadDisplayFont } from "./graphics";
import {
  buildTimeline,
  FPS,
  outputSize,
  TRANSITION_FRAMES,
  type Quality,
  type TimedScene,
} from "./timeline";
import { startModelWorker, type ModelWorker } from "./ml";
import { BACKUP_VOICE, DEFAULT_VOICE, fitSpeed, type Speech } from "./voice";
import { clipTime, loadClip, sfxCues, type VideoClip } from "./video";
import {
  fitDurations,
  loadPicture,
  sceneWords,
  VOICE_TAIL_SECONDS,
  withDurations,
} from "./prepare";
import { browserVoiceCache, speechKey, type VoiceCache } from "./voice-cache";

export type RenderStage = "loading" | "frames" | "audio" | "encoding" | "done";

export interface RenderProgress {
  stage: RenderStage;
  /** 0–1 within the stage. */
  progress: number;
  detail?: string;
}

export interface RenderOptions {
  quality?: Quality;
  /** Force the slower FFmpeg-only path (tests, or browsers with a broken encoder). */
  forceFfmpegEncode?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: RenderProgress) => void;
  fetchImpl?: typeof fetch;
  ffmpegBase?: string;
  /** Kokoro voice for narration (default Heart). */
  voice?: KokoroVoiceId;
  /** "kokoro" (default) voices narration in the browser; "provider" uses the server's audio. */
  narrator?: "kokoro" | "provider";
  /** Soft generated background music under the voice (default on). */
  music?: boolean;
  /** Whooshes and hits on planned transitions (default on). */
  sfx?: boolean;
  /** Where voiced lines are cached (default: this browser's IndexedDB). */
  voiceCache?: VoiceCache;
  /** 3D-depth camera moves (default on; falls back to flat moves if unavailable). */
  depth?: boolean;
  /** Override the on-device model time limits in milliseconds (tests). */
  limits?: Partial<typeof LIMITS>;
  /** Origin the /vendor/ files (display font) are served from (default: this page's). */
  vendorBase?: string;
}

export interface RenderResult {
  mp4: Uint8Array;
  width: number;
  height: number;
  durationSeconds: number;
  frames: number;
  encoder: "webcodecs" | "ffmpeg";
  missingMedia: string[];
  /** What actually voiced the video and how the camera moved, for the UI and QC. */
  narration: "kokoro" | "provider" | "none";
  /** Scenes with narration text that ended up with audio (for QC). */
  narratedScenes: number;
  /** Scenes that had narration text. */
  narrationScenes: number;
  motion: "depth" | "flat";
  /** Scenes that used stock footage. */
  videoScenes: number;
  notes: string[];
}

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Render cancelled", "AbortError");
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Renders a manifest into an MP4 entirely in the browser. */
export async function renderVideo(
  manifest: RenderManifest,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const quality = opts.quality ?? "720p";
  const report = opts.onProgress ?? (() => undefined);
  const doFetch = opts.fetchImpl ?? fetch;
  const fetchInit = opts.signal ? { signal: opts.signal } : {};
  const { width, height } = outputSize(manifest.project.aspect_ratio, quality);
  const missing: string[] = [];
  const notes: string[] = [];
  const scenes = manifest.scenes;
  const n = scenes.length;
  const lim = { ...LIMITS, ...opts.limits };

  // 1. Download pictures; work out depth; voice the narration.
  report({ stage: "loading", progress: 0, detail: "Downloading pictures" });
  const ffmpegPromise = loadFFmpeg(undefined, opts.ffmpegBase); // in parallel with the rest
  const blobs: (Blob | null)[] = [];
  const images: (ImageBitmap | null)[] = [];
  for (const s of scenes) {
    check(opts.signal);
    let blob: Blob | null = null;
    let image: ImageBitmap | null = null;
    if (s.image_url) {
      try {
        const pic = await loadPicture(s.image_url, doFetch, fetchInit);
        blob = pic?.blob ?? null;
        image = pic?.image ?? null;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        missing.push(`Scene ${s.scene_number} image`);
      }
    }
    blobs.push(blob);
    images.push(image);
  }

  // Stock footage: downloaded now, decoded only while its scene is on screen (phones have
  // little memory). A clip that won't load falls back to the scene's picture, if it has one.
  const footage: Footage[] = [];
  for (const [i, s] of scenes.entries()) {
    check(opts.signal);
    let blob: Blob | null = null;
    if (s.video_url) {
      report({
        stage: "loading",
        progress: 0.02,
        detail: `Downloading footage for scene ${i + 1}`,
      });
      try {
        const res = await doFetch(s.video_url, fetchInit);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blob = await res.blob();
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        missing.push(`Scene ${s.scene_number} footage (${errText(e)})`);
      }
    }
    footage.push({ blob, clip: null, state: blob ? "waiting" : "none", used: false });
  }

  const parallax = images.some(Boolean) ? ParallaxRenderer.create(width, height) : null;
  let motion: RenderResult["motion"] = "flat";
  if (parallax) {
    // Depth runs in its own worker; if it's too slow here, it's stopped and moves stay flat.
    const worker = opts.depth !== false ? startModelWorker() : null;
    let depthReady = false;
    try {
      if (worker) {
        try {
          await ticking(
            worker.loadDepth(lim.loadDepth, (f) =>
              report({
                stage: "loading",
                progress: 0.05 + 0.1 * f,
                detail: "Loading the 3D model",
              }),
            ),
            (sec) =>
              report({
                stage: "loading",
                progress: 0.05,
                detail: `Loading the 3D model · ${sec} s`,
              }),
          );
          depthReady = true;
        } catch (e) {
          notes.push(`3D depth unavailable (${errText(e)}); used flat camera moves.`);
        }
      } else if (opts.depth !== false) {
        notes.push("This browser can't run background workers; used flat camera moves.");
      }
      for (const [i, image] of images.entries()) {
        check(opts.signal);
        if (!image || footage[i]?.blob) continue;
        let depth: DepthMap | null = null;
        const blob = blobs[i];
        if (worker && depthReady && !worker.stopped && blob) {
          const detail = `3D depth for scene ${i + 1} of ${n}`;
          try {
            depth = await ticking(worker.depth(blob, lim.depthPerImage), (sec) =>
              report({
                stage: "loading",
                progress: 0.15 + (0.15 * i) / n,
                detail: `${detail} · ${sec} s`,
              }),
            );
            motion = "depth";
          } catch (e) {
            notes.push(`Scene ${i + 1}: depth skipped (${errText(e)}).`);
          }
        }
        parallax.addScene(i, image, depth);
      }
    } finally {
      worker?.terminate(); // stop it (and free its memory) before the voice model loads
    }
  }

  const voices = await voiceScenes(manifest, opts, doFetch, fetchInit, report, notes, missing);
  check(opts.signal);

  // 2. Fit scene lengths to the narration, so no sentence is cut off.
  const durations = fitDurations(
    scenes,
    voices.buffers.map((b) => b?.duration ?? null),
  );
  const { scenes: timeline, totalFrames } = buildTimeline(withDurations(manifest, durations));

  const media: SceneMedia[] = scenes.map((s, i) => {
    const hasFootage = !!footage[i]?.blob;
    return {
      image: images[i] ?? null, // replaced by the clip's frame while it plays
      words: sceneWords(
        s,
        durations[i] ?? s.duration_seconds,
        voices.buffers[i]?.duration ?? null,
        hasFootage || !!images[i],
      ),
      gpu: !hasFootage && !!parallax?.has(i),
    };
  });

  // Graphics scenes need the display font before their first frame (ADR 048).
  if (scenes.some((s) => s.visual_type === "graphics") && !(await loadDisplayFont(opts.vendorBase)))
    notes.push("The headline font didn't load; graphics headlines used bold Inter.");

  // 3. Paint every frame and encode it.
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d", { alpha: false }) as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("This browser can't draw video frames (no 2D canvas).");
  const fc: FrameContext = {
    width,
    height,
    timeline,
    media,
    totalFrames,
    title: manifest.project.title,
    parallax,
    grain: makeGrain(ctx),
    ...(manifest.captions ? { captions: manifest.captions } : {}),
    ...(manifest.graphics_theme ? { graphicsTheme: manifest.graphics_theme } : {}),
  };
  const config = opts.forceFfmpegEncode ? null : await pickWebCodecsConfig(width, height, FPS);
  const sink: FrameSink = config ? new WebCodecsSink(config, FPS) : new JpegFramesSink();
  try {
    for (let f = 0; f < totalFrames; f++) {
      if (f % 15 === 0) {
        check(opts.signal);
        report({
          stage: "frames",
          progress: f / totalFrames,
          detail: `Frame ${f} of ${totalFrames}`,
        });
      }
      await syncFootage(footage, media, timeline, f, missing, scenes);
      paintFrame(ctx, fc, f);
      await sink.addFrame(canvas, f);
    }
    const videoFiles = await sink.finish();
    report({ stage: "frames", progress: 1 });

    // 4. Mix narration and music.
    check(opts.signal);
    report({ stage: "audio", progress: 0 });
    const durationSeconds = totalFrames / FPS;
    const wav = await mixNarration(
      timeline.map((t, i) => ({
        buffer: voices.buffers[i] ?? null,
        startSeconds: t.startFrame / FPS,
        maxSeconds: t.frameCount / FPS,
        ...(t.scene.voice_gain_db !== undefined ? { gainDb: t.scene.voice_gain_db } : {}),
      })),
      durationSeconds,
      {
        music:
          opts.music === false || manifest.audio?.music === false
            ? false
            : (manifest.music ?? true),
        musicGainDb: manifest.audio?.music_gain_db ?? 0,
        duck: manifest.audio?.duck_under_voice ?? true,
        sfx: mixCues(timeline, opts.sfx !== false && manifest.audio?.transition_sfx !== false),
      },
    );
    report({ stage: "audio", progress: 1 });

    // 5. Assemble the MP4 (AAC audio; H.264 copied, or encoded from frames).
    check(opts.signal);
    report({ stage: "encoding", progress: 0, detail: "Loading FFmpeg" });
    const ff = await ffmpegPromise;
    const mp4 = await assembleMp4(ff, { kind: sink.kind, files: videoFiles }, wav, FPS, (p) =>
      report({ stage: "encoding", progress: p }),
    );
    report({ stage: "done", progress: 1 });
    return {
      mp4,
      width,
      height,
      durationSeconds,
      frames: totalFrames,
      encoder: sink.kind === "webcodecs" ? "webcodecs" : "ffmpeg",
      missingMedia: missing,
      narration: voices.kind,
      narratedScenes: voices.voiced,
      videoScenes: footage.filter((x) => x.used).length,
      narrationScenes: manifest.scenes.filter((s) => s.narration?.trim()).length,
      motion,
      notes,
    };
  } finally {
    sink.close();
    parallax?.dispose();
    for (const m of media) if (m.image && "close" in m.image) m.image.close();
    for (const x of footage) x.clip?.dispose();
  }
}

/** Time limits for the on-device models (generous: phones are slow, downloads can be too). */
export const LIMITS = {
  loadDepth: 180_000,
  depthPerImage: 60_000,
  loadVoice: 300_000,
  firstSpeech: 120_000,
  speech: 60_000,
};

/** Awaits `p`, calling `tick` with the elapsed seconds once a second so the UI shows progress. */
async function ticking<T>(p: Promise<T>, tick: (seconds: number) => void): Promise<T> {
  const started = Date.now();
  const timer = setInterval(() => tick(Math.round((Date.now() - started) / 1000)), 1000);
  try {
    return await p;
  } finally {
    clearInterval(timer);
  }
}

/** Typical Kokoro pace at speed 1, used to pick a speed before speaking (no second pass). */
const WORDS_PER_SECOND = 2.6;

/**
 * Narration for every scene: Kokoro in a background worker (chosen voice, then the backup
 * voice), and the server's provider audio for any scene Kokoro couldn't voice in time.
 */
async function voiceScenes(
  manifest: RenderManifest,
  opts: RenderOptions,
  doFetch: typeof fetch,
  fetchInit: RequestInit,
  report: (p: RenderProgress) => void,
  notes: string[],
  missing: string[],
): Promise<{
  buffers: (AudioBuffer | null)[];
  kind: RenderResult["narration"];
  voiced: number;
}> {
  const scenes = manifest.scenes;
  const buffers: (AudioBuffer | null)[] = scenes.map(() => null);
  let usedKokoro = false;
  let usedProvider = false;

  const lim = { ...LIMITS, ...opts.limits };
  const cache = opts.voiceCache ?? browserVoiceCache();
  const useKokoro = opts.narrator !== "provider";
  // Lines voiced before (in the preview or an earlier render) come from the cache.
  const cached = await Promise.all(
    scenes.map(async (s) => {
      const plan = useKokoro ? speechPlan(s, opts.voice ?? DEFAULT_VOICE) : null;
      if (!plan) return null;
      const hit = await cache.get(await speechKey(plan.text, plan.voice, plan.speed));
      return hit ? samplesToBuffer(hit.samples, hit.sampleRate) : null;
    }),
  );
  const wantKokoro = useKokoro && scenes.some((s, i) => s.narration?.trim() && !cached[i]);
  let worker: ModelWorker | null = null;
  if (wantKokoro) {
    worker = startModelWorker();
    if (!worker)
      notes.push("This browser can't run background workers, so the Kokoro voice can't run.");
    else {
      try {
        await ticking(
          worker.loadVoice(lim.loadVoice, (f) =>
            report({
              stage: "loading",
              progress: 0.3 + 0.3 * f,
              detail: "Loading the Kokoro voice",
            }),
          ),
          (sec) =>
            report({
              stage: "loading",
              progress: 0.3,
              detail: `Loading the Kokoro voice · ${sec} s`,
            }),
        );
      } catch (e) {
        notes.push(`Kokoro voice unavailable (${errText(e)}).`);
        worker.terminate();
        worker = null;
      }
    }
  }

  let voice = opts.voice ?? DEFAULT_VOICE;
  let first = true;
  try {
    for (const [i, s] of scenes.entries()) {
      check(opts.signal);
      const text = s.narration?.trim();
      const hit = cached[i];
      if (hit) {
        buffers[i] = hit;
        usedKokoro = true;
        continue;
      }
      if (worker && !worker.stopped && text) {
        const detail = `Voicing scene ${i + 1} of ${scenes.length}`;
        const { speed, voice: planned } = speechPlan(s, voice) ?? { speed: 1, voice };
        const sceneVoice = s.voice_id && planned !== voice ? planned : null;
        const limit = first ? lim.firstSpeech : lim.speech;
        const say = (v: KokoroVoiceId) =>
          ticking(worker!.speak(text, v, speed, limit), (sec) =>
            report({
              stage: "loading",
              progress: 0.6 + (0.4 * i) / scenes.length,
              detail: `${detail} · ${sec} s`,
            }),
          );
        try {
          let speech: Speech;
          try {
            speech = await say(sceneVoice ?? voice);
          } catch (e) {
            if (voice === BACKUP_VOICE || worker.stopped) throw e;
            notes.push(`Voice ${voice} failed (${errText(e)}); switched to ${BACKUP_VOICE}.`);
            voice = BACKUP_VOICE;
            speech = await say(voice);
          }
          first = false;
          buffers[i] = samplesToBuffer(speech.samples, speech.sampleRate);
          usedKokoro = true;
          void cache.put(await speechKey(text, sceneVoice ?? voice, speed), speech);
          continue;
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          notes.push(`Scene ${s.scene_number}: Kokoro failed (${errText(e)}).`);
        }
      }
      if (s.voice_url) {
        try {
          const res = await doFetch(s.voice_url, fetchInit);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          buffers[i] = await decodeAudio(await res.arrayBuffer());
          if (buffers[i]) usedProvider = true;
          else missing.push(`Scene ${s.scene_number} narration (couldn't decode)`);
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          missing.push(`Scene ${s.scene_number} narration`);
        }
      } else if (text) missing.push(`Scene ${s.scene_number} narration`);
    }
  } finally {
    worker?.terminate();
  }
  return {
    buffers,
    voiced: scenes.filter((s, i) => s.narration?.trim() && buffers[i]).length,
    kind: usedKokoro ? "kokoro" : usedProvider ? "provider" : "none",
  };
}

interface Footage {
  blob: Blob | null;
  clip: VideoClip | null;
  state: "none" | "waiting" | "playing" | "done" | "failed";
  used: boolean;
}

/**
 * Before painting `frame`: opens the clip of every scene on screen (its own frames, or a
 * transition into or out of it), seeks it to the right time and points the scene's picture at
 * it; closes clips whose scene is over (frames only move forward).
 */
async function syncFootage(
  footage: Footage[],
  media: SceneMedia[],
  timeline: { startFrame: number; frameCount: number }[],
  frame: number,
  missing: string[],
  scenes: RenderManifest["scenes"],
): Promise<void> {
  for (const [i, x] of footage.entries()) {
    const t = timeline[i];
    const m = media[i];
    if (!t || !m || x.state === "none" || x.state === "done" || x.state === "failed") continue;
    const end = t.startFrame + t.frameCount + TRANSITION_FRAMES;
    if (frame >= end) {
      x.clip?.dispose();
      x.clip = null;
      x.state = "done";
      continue;
    }
    if (frame < t.startFrame - TRANSITION_FRAMES) continue;
    if (!x.clip) {
      try {
        x.clip = await loadClip(x.blob as Blob);
        x.state = "playing";
        x.used = true;
        m.image = x.clip.frame;
      } catch (e) {
        x.state = "failed";
        missing.push(`Scene ${scenes[i]?.scene_number ?? i + 1} footage (${errText(e)})`);
        continue;
      }
    }
    const local = Math.max(0, frame - t.startFrame) / FPS;
    const trim = Math.min(scenes[i]?.trim_in_seconds ?? 0, Math.max(0, x.clip.duration - 0.5));
    await x.clip.seek(trim + clipTime(local, t.frameCount / FPS, x.clip.duration - trim));
  }
}

/** Transition effects (when on) plus every scene's placed sound effects, in seconds. */
export function mixCues(timeline: TimedScene[], transitions: boolean): SfxCueAt[] {
  const cues: SfxCueAt[] = transitions
    ? sfxCues(
        timeline.slice(1).flatMap((t, i) =>
          // Boundaries touching a graphics scene only crossfade (no whoosh or hit).
          t.scene.visual_type === "graphics" || timeline[i]?.scene.visual_type === "graphics"
            ? []
            : [{ seconds: t.startFrame / FPS, transition: t.scene.transition_in }],
        ),
      )
    : [];
  // Graphics scenes: a sound on every element's entrance, from the same cues the painter uses.
  cues.push(...graphicsSfxCues(timeline));
  for (const t of timeline)
    for (const s of t.scene.sfx ?? [])
      cues.push({ at: t.startFrame / FPS + s.at_s, kind: s.kind, gainDb: s.gain_db });
  return cues.sort((a, b) => a.at - b.at);
}

/**
 * What Kokoro should say for a scene and how: the text, the scene's own voice (or `fallback`),
 * and its speed (set by the editor, or fitted so the line fits the scene). Null when silent.
 * Shared with the live preview so both produce (and cache) the same line.
 */
export function speechPlan(
  s: RenderManifest["scenes"][number],
  fallback: KokoroVoiceId,
): { text: string; voice: KokoroVoiceId; speed: number } | null {
  const text = s.narration?.trim();
  if (!text) return null;
  const words = text.split(/\s+/).length;
  const speed =
    s.voice_speed ?? fitSpeed(words / WORDS_PER_SECOND, s.duration_seconds - VOICE_TAIL_SECONDS);
  // The editor can give a scene its own voice; unknown ids fall back to the chosen one.
  const voice = KOKORO_VOICES.some((v) => v.id === s.voice_id)
    ? (s.voice_id as KokoroVoiceId)
    : fallback;
  return { text, voice, speed };
}
