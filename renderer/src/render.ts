import type { KokoroVoiceId } from "@avs/contracts";
import type { RenderManifest } from "@avs/schemas";
import { decodeAudio, mixNarration, samplesToBuffer } from "./audio";
import { loadDepthEstimator, type DepthMap } from "./depth";
import { JpegFramesSink, pickWebCodecsConfig, WebCodecsSink, type FrameSink } from "./encoders";
import { assembleMp4, loadFFmpeg } from "./ffmpeg";
import { makeGrain, paintFrame, type FrameContext, type SceneMedia } from "./painter";
import { ParallaxRenderer } from "./parallax";
import { buildTimeline, FPS, outputSize, wordGroups, wordTimings, type Quality } from "./timeline";
import { BACKUP_VOICE, DEFAULT_VOICE, fitSpeed, loadNarrator, type Narrator } from "./voice";

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
  /** 3D-depth camera moves (default on; falls back to flat moves if unavailable). */
  depth?: boolean;
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
  motion: "depth" | "flat";
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
        const res = await doFetch(s.image_url, fetchInit);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blob = await res.blob();
        image = await createImageBitmap(blob);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        missing.push(`Scene ${s.scene_number} image`);
      }
    }
    blobs.push(blob);
    images.push(image);
  }

  const parallax = images.some(Boolean) ? ParallaxRenderer.create(width, height) : null;
  let motion: RenderResult["motion"] = "flat";
  if (parallax) {
    let depthOf: ((b: Blob) => Promise<DepthMap>) | null = null;
    if (opts.depth !== false) {
      try {
        report({ stage: "loading", progress: 0.1, detail: "Loading the 3D depth model" });
        depthOf = await loadDepthEstimator((f) =>
          report({
            stage: "loading",
            progress: 0.1 + 0.15 * f,
            detail: "Loading the 3D depth model",
          }),
        );
      } catch (e) {
        notes.push(`3D depth unavailable (${errText(e)}); used flat camera moves.`);
      }
    }
    for (const [i, image] of images.entries()) {
      check(opts.signal);
      if (!image) continue;
      let depth: DepthMap | null = null;
      const blob = blobs[i];
      if (depthOf && blob) {
        report({
          stage: "loading",
          progress: 0.25 + (0.15 * i) / n,
          detail: `Depth for scene ${i + 1}`,
        });
        try {
          depth = await depthOf(blob);
          motion = "depth";
        } catch (e) {
          notes.push(`Scene ${i + 1}: depth failed (${errText(e)}).`);
        }
      }
      parallax.addScene(i, image, depth);
    }
  }

  const voices = await voiceScenes(manifest, opts, doFetch, fetchInit, report, notes, missing);
  check(opts.signal);

  // 2. Fit scene lengths to the narration, so no sentence is cut off.
  const durations = scenes.map((s, i) => {
    const v = voices.buffers[i];
    return v ? Math.max(s.duration_seconds, v.duration + 0.35) : s.duration_seconds;
  });
  const timedManifest: RenderManifest = {
    ...manifest,
    scenes: scenes.map((s, i) => ({ ...s, duration_seconds: durations[i] ?? s.duration_seconds })),
  };
  const { scenes: timeline, totalFrames } = buildTimeline(timedManifest);

  const media: SceneMedia[] = scenes.map((s, i) => {
    const dur = durations[i] ?? s.duration_seconds;
    const v = voices.buffers[i];
    const text = s.narration?.trim() || s.caption;
    const words = v
      ? wordTimings(text, 0.05, Math.min(v.duration, dur - 0.05))
      : wordTimings(text, 0.2, Math.max(0.5, dur - 0.5));
    return {
      image: images[i] ?? null,
      words: wordGroups(words, images[i] ? 4 : 6),
      gpu: !!parallax?.has(i),
    };
  });

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
      })),
      durationSeconds,
      { music: opts.music !== false },
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
      motion,
      notes,
    };
  } finally {
    sink.close();
    parallax?.dispose();
    for (const m of media) m.image?.close();
  }
}

/**
 * Narration for every scene: Kokoro in the browser (chosen voice, then the backup voice), and
 * the server's provider audio for any scene Kokoro couldn't voice.
 */
async function voiceScenes(
  manifest: RenderManifest,
  opts: RenderOptions,
  doFetch: typeof fetch,
  fetchInit: RequestInit,
  report: (p: RenderProgress) => void,
  notes: string[],
  missing: string[],
): Promise<{ buffers: (AudioBuffer | null)[]; kind: RenderResult["narration"] }> {
  const scenes = manifest.scenes;
  const buffers: (AudioBuffer | null)[] = scenes.map(() => null);
  let usedKokoro = false;
  let usedProvider = false;

  const wantKokoro = opts.narrator !== "provider" && scenes.some((s) => s.narration?.trim());
  let narrator: Narrator | null = null;
  if (wantKokoro) {
    try {
      report({ stage: "loading", progress: 0.4, detail: "Loading the Kokoro voice" });
      narrator = await loadNarrator((f) =>
        report({ stage: "loading", progress: 0.4 + 0.3 * f, detail: "Loading the Kokoro voice" }),
      );
    } catch (e) {
      notes.push(`Kokoro voice unavailable (${errText(e)}); used the server narration.`);
    }
  }

  let voice = opts.voice ?? DEFAULT_VOICE;
  for (const [i, s] of scenes.entries()) {
    check(opts.signal);
    const text = s.narration?.trim();
    if (narrator && text) {
      report({
        stage: "loading",
        progress: 0.7 + (0.3 * i) / scenes.length,
        detail: `Voicing scene ${i + 1} of ${scenes.length}`,
      });
      try {
        let speech;
        try {
          speech = await narrator.speak(text, voice);
        } catch (e) {
          if (voice === BACKUP_VOICE) throw e;
          notes.push(`Voice ${voice} failed (${errText(e)}); switched to ${BACKUP_VOICE}.`);
          voice = BACKUP_VOICE;
          speech = await narrator.speak(text, voice);
        }
        // Speak a little faster (up to 1.2×) rather than run past the planned scene length.
        const spoken = speech.samples.length / speech.sampleRate;
        const speed = fitSpeed(spoken, s.duration_seconds - 0.35);
        if (speed > 1) speech = await narrator.speak(text, voice, speed);
        buffers[i] = samplesToBuffer(speech.samples, speech.sampleRate);
        usedKokoro = true;
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
    }
  }
  return {
    buffers,
    kind: usedKokoro ? "kokoro" : usedProvider ? "provider" : "none",
  };
}
