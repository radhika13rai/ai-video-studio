import type { RenderManifest } from "@avs/schemas";
import { decodeAudio, mixNarration } from "./audio";
import { JpegFramesSink, pickWebCodecsConfig, WebCodecsSink, type FrameSink } from "./encoders";
import { assembleMp4, loadFFmpeg } from "./ffmpeg";
import { paintFrame, prepareCaptions, setLastSceneIndex, type SceneMedia } from "./painter";
import { buildTimeline, FPS, outputSize, sceneAt, type Quality } from "./timeline";

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
}

export interface RenderResult {
  mp4: Uint8Array;
  width: number;
  height: number;
  durationSeconds: number;
  frames: number;
  encoder: "webcodecs" | "ffmpeg";
  missingMedia: string[];
}

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Render cancelled", "AbortError");
}

/** Renders a manifest into an MP4 entirely in the browser. */
export async function renderVideo(
  manifest: RenderManifest,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const quality = opts.quality ?? "720p";
  const report = opts.onProgress ?? (() => undefined);
  const doFetch = opts.fetchImpl ?? fetch;
  const { width, height } = outputSize(manifest.project.aspect_ratio, quality);
  const { scenes: timeline, totalFrames } = buildTimeline(manifest);
  setLastSceneIndex(timeline.length - 1);
  const missing: string[] = [];

  // 1. Download every scene's image and narration.
  report({ stage: "loading", progress: 0 });
  const media: SceneMedia[] = [];
  const voices: (AudioBuffer | null)[] = [];
  const ffmpegPromise = loadFFmpeg(undefined, opts.ffmpegBase); // in parallel with downloads
  for (const [i, s] of manifest.scenes.entries()) {
    check(opts.signal);
    let image: ImageBitmap | null = null;
    if (s.image_url) {
      try {
        const res = await doFetch(s.image_url, opts.signal ? { signal: opts.signal } : {});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        image = await createImageBitmap(await res.blob());
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        missing.push(`Scene ${s.scene_number} image`);
      }
    }
    let voice: AudioBuffer | null = null;
    if (s.voice_url) {
      try {
        const res = await doFetch(s.voice_url, opts.signal ? { signal: opts.signal } : {});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        voice = await decodeAudio(await res.arrayBuffer());
        if (!voice) missing.push(`Scene ${s.scene_number} narration (couldn't decode)`);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        missing.push(`Scene ${s.scene_number} narration`);
      }
    }
    media.push({ image, captions: prepareCaptions(s) });
    voices.push(voice);
    report({
      stage: "loading",
      progress: (i + 1) / manifest.scenes.length,
      detail: `Scene ${i + 1} of ${manifest.scenes.length}`,
    });
  }

  // 2. Paint every frame and encode it.
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d", { alpha: false }) as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("This browser can't draw video frames (no 2D canvas).");
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
      const timed = sceneAt(timeline, f);
      paintFrame(
        ctx,
        width,
        height,
        timed,
        media[timed.index] as SceneMedia,
        f,
        manifest.project.title,
      );
      await sink.addFrame(canvas, f);
    }
    const videoFiles = await sink.finish();
    report({ stage: "frames", progress: 1 });

    // 3. Mix narration.
    check(opts.signal);
    report({ stage: "audio", progress: 0 });
    const durationSeconds = totalFrames / FPS;
    const wav = await mixNarration(
      timeline.map((t, i) => ({
        buffer: voices[i] ?? null,
        startSeconds: t.startFrame / FPS,
        maxSeconds: t.frameCount / FPS,
      })),
      durationSeconds,
    );
    report({ stage: "audio", progress: 1 });

    // 4. Assemble the MP4 (AAC audio; H.264 copied, or encoded from frames).
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
    };
  } finally {
    sink.close();
    for (const m of media) m.image?.close();
  }
}
