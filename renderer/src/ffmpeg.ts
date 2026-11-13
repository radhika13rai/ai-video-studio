import { FFMPEG_CORE_BASE } from "@avs/contracts";
import { FFmpeg } from "@ffmpeg/ffmpeg";

/**
 * FFmpeg.wasm (single-threaded core, so no cross-origin isolation is needed). The 32 MB core is
 * served from our own origin: Vite serves it from node_modules in development, and the Worker
 * serves it from R2 in production (Workers static assets are limited to 25 MiB per file).
 */
let instance: FFmpeg | null = null;

export async function loadFFmpeg(
  onLog?: (line: string) => void,
  base = FFMPEG_CORE_BASE,
): Promise<FFmpeg> {
  if (instance?.loaded) return instance;
  const ff = new FFmpeg();
  if (onLog) ff.on("log", ({ message }) => onLog(message));
  const origin = typeof location !== "undefined" ? location.origin : "";
  await ff.load({
    coreURL: `${origin}${base}/ffmpeg-core.js`,
    wasmURL: `${origin}${base}/ffmpeg-core.wasm`,
  });
  instance = ff;
  return ff;
}

export function resetFFmpeg(): void {
  instance?.terminate();
  instance = null;
}

/** Muxes H.264 (or JPEG frames) with WAV narration into an H.264/AAC MP4 with fast start. */
export async function assembleMp4(
  ff: FFmpeg,
  video: { kind: "webcodecs" | "frames"; files: { name: string; data: Uint8Array }[] },
  wav: Uint8Array,
  fps: number,
  onProgress?: (p: number) => void,
): Promise<Uint8Array> {
  const handler = ({ progress }: { progress: number }) =>
    onProgress?.(Math.max(0, Math.min(1, progress)));
  ff.on("progress", handler);
  try {
    for (const f of video.files) await ff.writeFile(f.name, f.data);
    await ff.writeFile("audio.wav", wav);
    const input =
      video.kind === "webcodecs"
        ? ["-r", String(fps), "-f", "h264", "-i", "video.h264"]
        : ["-framerate", String(fps), "-i", "f%05d.jpg"];
    const vcodec =
      video.kind === "webcodecs"
        ? ["-c:v", "copy"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
    const code = await ff.exec([
      ...input,
      "-i",
      "audio.wav",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      ...vcodec,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      "out.mp4",
    ]);
    if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
    const out = await ff.readFile("out.mp4");
    if (typeof out === "string") throw new Error("FFmpeg returned text instead of a video");
    return out;
  } finally {
    ff.off("progress", handler);
    for (const name of [...video.files.map((f) => f.name), "audio.wav", "out.mp4"]) {
      try {
        await ff.deleteFile(name);
      } catch {
        /* already gone */
      }
    }
  }
}
