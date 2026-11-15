/**
 * Stock footage in the browser renderer (ADR 041). A clip is decoded by a hidden <video>
 * element; for each output frame the renderer seeks it to the exact time and copies the picture
 * into a small canvas, which the painter then draws like a still image (with the planned camera
 * move, minus 3D depth). Seeking frame by frame is slower than playback but deterministic, so the
 * output never drops or repeats frames whatever the device's speed.
 */

export interface VideoClip {
  /** Holds the most recently sought frame. */
  readonly frame: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  seek(seconds: number): Promise<void>;
  dispose(): void;
}

/** Longest side of the copied frame; enough for 1080p output once zoomed a little. */
const MAX_SIDE = 1920;

function waitFor(el: HTMLVideoElement, event: string, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`));
    }, ms);
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error(`the browser couldn't play the clip (${what})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", bad);
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

/** Loads a clip from its bytes. Rejects if the browser can't decode it in time. */
export async function loadClip(blob: Blob, timeoutMs = 30_000): Promise<VideoClip> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const loaded = waitFor(video, "loadeddata", timeoutMs, "loading the clip");
    video.src = url;
    await loaded;
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const frame = document.createElement("canvas");
  frame.width = Math.max(2, Math.round(video.videoWidth * scale));
  frame.height = Math.max(2, Math.round(video.videoHeight * scale));
  const ctx = frame.getContext("2d", { alpha: false });
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error("no 2D canvas for the clip");
  }
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  let at = -1;
  const draw = () => ctx.drawImage(video, 0, 0, frame.width, frame.height);
  return {
    frame,
    width: frame.width,
    height: frame.height,
    duration,
    async seek(seconds: number) {
      const t = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.05)));
      if (Math.abs(t - at) < 0.0005) return;
      const sought = waitFor(video, "seeked", 10_000, "seeking the clip");
      video.currentTime = t;
      await sought;
      at = t;
      draw();
    },
    dispose() {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * Where in the clip a scene's local time falls. A clip shorter than its scene plays in slow
 * motion to fill it (never looping); a longer one plays at normal speed from the start.
 */
export function clipTime(localSeconds: number, sceneSeconds: number, clipSeconds: number): number {
  if (clipSeconds <= 0) return 0;
  const rate = clipSeconds >= sceneSeconds ? 1 : clipSeconds / sceneSeconds;
  return Math.max(0, Math.min(clipSeconds - 0.05, localSeconds * rate));
}

/** Transition sound effects for each scene boundary, from the planned transitions. */
export interface SfxCue {
  at: number;
  kind: "whoosh" | "hit";
}

export function sfxCues(
  boundaries: { seconds: number; transition: string | undefined }[],
): SfxCue[] {
  const cues: SfxCue[] = [];
  for (const b of boundaries) {
    if (b.transition === "whip" || b.transition === "slide" || b.transition === "zoom")
      cues.push({ at: Math.max(0, b.seconds - 0.25), kind: "whoosh" });
    else if (b.transition === "flash") cues.push({ at: b.seconds, kind: "hit" });
  }
  return cues;
}
