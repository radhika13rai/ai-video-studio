import type { KokoroVoiceId } from "@avs/contracts";
import type { RenderManifest } from "@avs/schemas";
import { decodeAudio, mixNarration, samplesToBuffer } from "./audio";
import { startModelWorker } from "./ml";
import { makeGrain, paintFrame, type FrameContext, type SceneMedia } from "./painter";
import { fitDurations, sceneWords, withDurations } from "./prepare";
import { LIMITS, mixCues, speechPlan } from "./render";
import { buildTimeline, FPS, outputSize, type TimedScene } from "./timeline";
import { clipTime } from "./video";
import { DEFAULT_VOICE } from "./voice";
import { browserVoiceCache, speechKey, type VoiceCache } from "./voice-cache";

/**
 * Live preview (ADR 046): the same painter, scene timing and audio mix as the export, played in
 * real time on a small canvas. The audio clock is the master; each animation frame paints the
 * frame for the current time. Footage plays as video (kept within 0.25 s of the clock) instead
 * of the export's frame-by-frame seeking, and pictures move without 3D depth, so phones keep up.
 * Narration plays when it is cached (voiced earlier) or stored; `voice()` voices the rest with
 * Kokoro on request and caches it, which also speeds up the export.
 */

export interface PreviewOptions {
  fetchImpl?: typeof fetch;
  voice?: KokoroVoiceId;
  voiceCache?: VoiceCache;
  /** Output height in pixels (default 640, i.e. 360×640 for 9:16). */
  height?: number;
}

export interface PreviewState {
  seconds: number;
  duration: number;
  playing: boolean;
  /** Narrated scenes that have audio in the preview / that have narration text. */
  voiced: number;
  narrated: number;
}

export interface PreviewController {
  readonly state: PreviewState;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  /** Start time (in the preview, after fitting to narration) of a scene by index. */
  sceneStart(index: number): number;
  /** Rebuild for an edited manifest, keeping media already loaded. */
  update(manifest: RenderManifest): Promise<void>;
  /** Voice uncached narration with Kokoro (slow on phones); resolves when done. */
  voice(onProgress?: (done: number, total: number) => void): Promise<void>;
  destroy(): void;
}

interface Built {
  manifest: RenderManifest;
  fc: FrameContext;
  timeline: TimedScene[];
  totalFrames: number;
  audio: AudioBuffer | null;
  voiced: number;
  narrated: number;
}

export async function createPreview(
  canvas: HTMLCanvasElement,
  manifest: RenderManifest,
  opts: PreviewOptions = {},
  onState?: (s: PreviewState) => void,
): Promise<PreviewController> {
  const doFetch = opts.fetchImpl ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
  const voiceId = opts.voice ?? DEFAULT_VOICE;
  const cache = opts.voiceCache ?? browserVoiceCache();
  const ctx2d = canvas.getContext("2d", { alpha: false });
  if (!ctx2d) throw new Error("This browser can't draw the preview (no 2D canvas).");
  const audioCtx = new AudioContext();
  const images = new Map<string, Promise<ImageBitmap | null>>();
  const recordings = new Map<string, Promise<AudioBuffer | null>>();
  const videos = new Map<string, { el: HTMLVideoElement; frame: HTMLCanvasElement; url: string }>();
  const grain = makeGrain(ctx2d);

  const image = (url: string) => {
    let p = images.get(url);
    if (!p) {
      p = doFetch(url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => createImageBitmap(b))
        .catch(() => null);
      images.set(url, p);
    }
    return p;
  };
  const recording = (url: string) => {
    let p = recordings.get(url);
    if (!p) {
      p = doFetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => decodeAudio(b))
        .catch(() => null);
      recordings.set(url, p);
    }
    return p;
  };
  const video = async (url: string) => {
    const have = videos.get(url);
    if (have) return have;
    const res = await doFetch(url);
    if (!res.ok) return null;
    const src = URL.createObjectURL(await res.blob());
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.src = src;
    await new Promise<void>((resolve) => {
      el.addEventListener("loadeddata", () => resolve(), { once: true });
      el.addEventListener("error", () => resolve(), { once: true });
    });
    if (!el.videoWidth) {
      URL.revokeObjectURL(src);
      return null;
    }
    const frame = document.createElement("canvas");
    const k = Math.min(1, 720 / Math.max(el.videoWidth, el.videoHeight));
    frame.width = Math.round(el.videoWidth * k);
    frame.height = Math.round(el.videoHeight * k);
    const entry = { el, frame, url: src };
    videos.set(url, entry);
    return entry;
  };

  async function voiceBuffer(s: RenderManifest["scenes"][number]): Promise<AudioBuffer | null> {
    const plan = speechPlan(s, voiceId);
    if (plan) {
      const hit = await cache.get(await speechKey(plan.text, plan.voice, plan.speed));
      if (hit) return samplesToBuffer(hit.samples, hit.sampleRate);
    }
    return s.voice_url ? recording(s.voice_url) : null;
  }

  async function build(m: RenderManifest): Promise<Built> {
    const base = outputSize(m.project.aspect_ratio, "720p");
    const h = opts.height ?? 640;
    const scale = h / base.height;
    const width = Math.round((base.width * scale) / 2) * 2;
    const height = Math.round(h / 2) * 2;
    canvas.width = width;
    canvas.height = height;
    const pictures = await Promise.all(
      m.scenes.map((s) => (s.image_url ? image(s.image_url) : null)),
    );
    const clips = await Promise.all(m.scenes.map((s) => (s.video_url ? video(s.video_url) : null)));
    const voices = await Promise.all(m.scenes.map(voiceBuffer));
    const durations = fitDurations(
      m.scenes,
      voices.map((v) => v?.duration ?? null),
    );
    const { scenes: timeline, totalFrames } = buildTimeline(withDurations(m, durations));
    const media: SceneMedia[] = m.scenes.map((s, i) => {
      const clip = clips[i];
      const picture = clip ? clip.frame : (pictures[i] ?? null);
      return {
        image: picture,
        words: sceneWords(
          s,
          durations[i] ?? s.duration_seconds,
          voices[i]?.duration ?? null,
          !!picture,
        ),
        gpu: false,
      };
    });
    const total = totalFrames / FPS;
    const wav = await mixNarration(
      timeline.map((t, i) => ({
        buffer: voices[i] ?? null,
        startSeconds: t.startFrame / FPS,
        maxSeconds: t.frameCount / FPS,
        ...(t.scene.voice_gain_db !== undefined ? { gainDb: t.scene.voice_gain_db } : {}),
      })),
      total,
      {
        music: m.audio?.music === false ? false : (m.music ?? true),
        musicGainDb: m.audio?.music_gain_db ?? 0,
        duck: m.audio?.duck_under_voice ?? true,
        sfx: mixCues(timeline, m.audio?.transition_sfx !== false),
      },
    );
    const audio = await audioCtx
      .decodeAudioData(wav.buffer.slice(0) as ArrayBuffer)
      .catch(() => null);
    return {
      manifest: m,
      timeline,
      totalFrames,
      audio,
      voiced: m.scenes.filter((s, i) => s.narration?.trim() && voices[i]).length,
      narrated: m.scenes.filter((s) => s.narration?.trim()).length,
      fc: {
        width,
        height,
        timeline,
        media,
        totalFrames,
        title: m.project.title,
        parallax: null,
        grain,
        ...(m.captions ? { captions: m.captions } : {}),
      },
    };
  }

  let built = await build(manifest);
  let playing = false;
  let offset = 0; // seconds into the video when (re)started or paused
  let startedAt = 0; // audioCtx time of the last start
  let source: AudioBufferSourceNode | null = null;
  let raf = 0;
  let destroyed = false;

  const duration = () => built.totalFrames / FPS;
  const now = () => (playing ? offset + (audioCtx.currentTime - startedAt) : offset);
  const state = (): PreviewState => ({
    seconds: Math.min(now(), duration()),
    duration: duration(),
    playing,
    voiced: built.voiced,
    narrated: built.narrated,
  });

  function stopAudio() {
    if (!source) return;
    try {
      source.stop();
    } catch {
      // already stopped
    }
    source.disconnect();
    source = null;
  }

  function startAudio(at: number) {
    stopAudio();
    if (!built.audio) return;
    source = audioCtx.createBufferSource();
    source.buffer = built.audio;
    source.connect(audioCtx.destination);
    source.start(0, Math.min(at, built.audio.duration));
  }

  /** Keeps visible clips playing in step with the clock; copies their current frame. */
  function syncVideos(frame: number) {
    built.timeline.forEach((t, i) => {
      const url = built.manifest.scenes[i]?.video_url;
      const v = url ? videos.get(url) : undefined;
      if (!v) return;
      const visible = frame >= t.startFrame - 14 && frame < t.startFrame + t.frameCount + 14;
      if (!visible) {
        if (!v.el.paused) v.el.pause();
        return;
      }
      const sceneSeconds = t.frameCount / FPS;
      const trim = Math.min(t.scene.trim_in_seconds ?? 0, Math.max(0, v.el.duration - 0.5));
      const local = Math.max(0, frame - t.startFrame) / FPS;
      const target = trim + clipTime(local, sceneSeconds, (v.el.duration || 0) - trim);
      const rate = v.el.duration - trim >= sceneSeconds ? 1 : (v.el.duration - trim) / sceneSeconds;
      if (Math.abs(v.el.currentTime - target) > 0.25) v.el.currentTime = target;
      v.el.playbackRate = Math.max(0.25, Math.min(1, rate || 1));
      if (playing && v.el.paused) void v.el.play().catch(() => undefined);
      if (!playing && !v.el.paused) v.el.pause();
      const c = v.frame.getContext("2d");
      if (c && v.el.readyState >= 2) c.drawImage(v.el, 0, 0, v.frame.width, v.frame.height);
    });
  }

  function paint() {
    const frame = Math.min(built.totalFrames - 1, Math.max(0, Math.floor(now() * FPS)));
    syncVideos(frame);
    paintFrame(ctx2d!, built.fc, frame);
  }

  function tick() {
    if (destroyed) return;
    if (playing && now() >= duration()) {
      playing = false;
      offset = duration();
      stopAudio();
    }
    paint();
    onState?.(state());
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  paint();

  const controller: PreviewController = {
    get state() {
      return state();
    },
    async play() {
      if (playing) return;
      if (offset >= duration() - 0.05) offset = 0;
      await audioCtx.resume().catch(() => undefined);
      startedAt = audioCtx.currentTime;
      playing = true;
      startAudio(offset);
    },
    pause() {
      if (!playing) return;
      offset = now();
      playing = false;
      stopAudio();
      for (const v of videos.values()) v.el.pause();
      paint();
    },
    seek(seconds) {
      offset = Math.max(0, Math.min(seconds, duration()));
      if (playing) {
        startedAt = audioCtx.currentTime;
        startAudio(offset);
      }
      paint();
      onState?.(state());
    },
    sceneStart(index) {
      return (built.timeline[index]?.startFrame ?? 0) / FPS;
    },
    async update(m) {
      const at = now();
      const wasPlaying = playing;
      if (wasPlaying) controller.pause();
      built = await build(m);
      offset = Math.min(at, duration());
      if (wasPlaying) await controller.play();
      paint();
      onState?.(state());
    },
    async voice(onProgress) {
      const todo: { text: string; voice: KokoroVoiceId; speed: number }[] = [];
      for (const s of built.manifest.scenes) {
        const plan = speechPlan(s, voiceId);
        if (plan && !(await cache.get(await speechKey(plan.text, plan.voice, plan.speed))))
          todo.push(plan);
      }
      if (!todo.length) return;
      const worker = startModelWorker();
      if (!worker) throw new Error("This browser can't run the Kokoro voice.");
      try {
        await worker.loadVoice(LIMITS.loadVoice);
        for (const [k, plan] of todo.entries()) {
          onProgress?.(k, todo.length);
          const speech = await worker.speak(plan.text, plan.voice, plan.speed, LIMITS.speech * 2);
          await cache.put(await speechKey(plan.text, plan.voice, plan.speed), speech);
        }
        onProgress?.(todo.length, todo.length);
      } finally {
        worker.terminate();
      }
      await controller.update(built.manifest);
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      stopAudio();
      for (const v of videos.values()) {
        v.el.pause();
        v.el.removeAttribute("src");
        URL.revokeObjectURL(v.url);
      }
      void audioCtx.close().catch(() => undefined);
    },
  };
  return controller;
}
