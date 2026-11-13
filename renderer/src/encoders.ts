/** Turns painted frames into H.264. WebCodecs (fast, hardware) when available, else JPEG frames for FFmpeg. */

export interface FrameSink {
  readonly kind: "webcodecs" | "frames";
  addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, frameIndex: number): Promise<void>;
  finish(): Promise<{ name: string; data: Uint8Array }[]>;
  close(): void;
}

const CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42001f"];

export async function pickWebCodecsConfig(
  width: number,
  height: number,
  fps: number,
): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  for (const codec of CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      framerate: fps,
      bitrate: width * height >= 1920 * 1080 ? 8_000_000 : 4_500_000,
      avc: { format: "annexb" },
    };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      /* try the next profile */
    }
  }
  return null;
}

export class WebCodecsSink implements FrameSink {
  readonly kind = "webcodecs" as const;
  private chunks: Uint8Array[] = [];
  private error: Error | null = null;
  private encoder: VideoEncoder;

  constructor(
    config: VideoEncoderConfig,
    private readonly fps: number,
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        this.chunks.push(buf);
      },
      error: (e) => {
        this.error = e instanceof Error ? e : new Error(String(e));
      },
    });
    this.encoder.configure(config);
  }

  async addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, i: number): Promise<void> {
    if (this.error) throw this.error;
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1_000_000) / this.fps),
      duration: Math.round(1_000_000 / this.fps),
    });
    this.encoder.encode(frame, { keyFrame: i % (this.fps * 2) === 0 });
    frame.close();
    // Keep memory flat: let the encoder drain before queueing more.
    while (this.encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 1));
  }

  async finish() {
    await this.encoder.flush();
    if (this.error) throw this.error;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return [{ name: "video.h264", data: out }];
  }

  close() {
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}

/** Fallback: JPEG frames that FFmpeg encodes with libx264 (slower, works everywhere). */
export class JpegFramesSink implements FrameSink {
  readonly kind = "frames" as const;
  private frames: { name: string; data: Uint8Array }[] = [];

  async addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, i: number): Promise<void> {
    const blob =
      "convertToBlob" in canvas
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })
        : await new Promise<Blob>((res, rej) =>
            (canvas as HTMLCanvasElement).toBlob(
              (b) => (b ? res(b) : rej(new Error("toBlob failed"))),
              "image/jpeg",
              0.9,
            ),
          );
    this.frames.push({
      name: `f${String(i).padStart(5, "0")}.jpg`,
      data: new Uint8Array(await blob.arrayBuffer()),
    });
  }

  async finish() {
    const out = this.frames;
    this.frames = [];
    return out;
  }

  close() {
    this.frames = [];
  }
}
