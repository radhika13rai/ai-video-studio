import type { ParallaxRenderer } from "./parallax";
import {
  activeWords,
  coverRect,
  ease,
  FPS,
  hash01,
  shotAt,
  shotsFor,
  transitionAt,
  wrapText,
  type Shot,
  type TimedScene,
  type TimedWord,
} from "./timeline";

/**
 * Draws one video frame: the scene's picture with a moving camera (depth parallax on the GPU
 * when available, else a 2D crop), cuts between shots, transitions between scenes, word-by-word
 * captions, a title intro, a progress bar, film grain and a vignette.
 */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface SceneMedia {
  image: ImageBitmap | null;
  /** Caption lines with per-word timing (seconds from the scene start). */
  words: TimedWord[][];
  /** True when the parallax renderer has this scene's textures. */
  gpu: boolean;
}

export interface FrameContext {
  width: number;
  height: number;
  timeline: TimedScene[];
  media: SceneMedia[];
  totalFrames: number;
  title: string;
  parallax: ParallaxRenderer | null;
  grain: CanvasPattern[] | null;
}

const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
const HIGHLIGHT = "#ffd84d";
const shotCache = new Map<string, Shot[]>();

function shotsOf(t: TimedScene): Shot[] {
  const key = `${t.index}:${t.frameCount}`;
  let s = shotCache.get(key);
  if (!s) {
    s = shotsFor(t.index, t.frameCount);
    shotCache.set(key, s);
  }
  return s;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Motion curve: mostly linear (the camera keeps moving), softened at the ends. */
const glide = (t: number) => 0.6 * t + 0.4 * ease(t);

export function paintFrame(ctx: Ctx2D, fc: FrameContext, frame: number): void {
  const { width: w, height: h } = fc;
  ctx.save();
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, w, h);

  const tr = transitionAt(fc.timeline, frame);
  const current = tr ? (tr.progress < 0.5 ? tr.from : tr.to) : sceneOf(fc.timeline, frame);
  if (tr) paintTransition(ctx, fc, frame, tr.from, tr.to, tr.progress, tr.kind);
  else paintScene(ctx, fc, current, frame);

  paintVignette(ctx, w, h);
  const media = fc.media[current.index] as SceneMedia;
  const seconds = (frame - current.startFrame) / FPS;
  if (media.image) paintCaptions(ctx, w, h, media.words, seconds);
  else paintKineticText(ctx, w, h, media.words, seconds);
  if (frame < 2.4 * FPS) paintTitle(ctx, w, h, fc.title, frame / FPS);
  paintProgress(ctx, w, h, frame / Math.max(1, fc.totalFrames - 1));
  if (fc.grain) paintGrain(ctx, w, h, fc.grain, frame);

  // Fade in from black at the start and out at the end.
  const fadeIn = 1 - Math.min(1, frame / 12);
  const fadeOut = 1 - Math.min(1, (fc.totalFrames - 1 - frame) / 18);
  const alpha = Math.max(fadeIn, fadeOut);
  if (alpha > 0.001) {
    ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

function sceneOf(timeline: TimedScene[], frame: number): TimedScene {
  for (const t of timeline) if (frame < t.startFrame + t.frameCount) return t;
  return timeline[timeline.length - 1] as TimedScene;
}

const clampPan = (p: number) => Math.max(-1, Math.min(1, p));

/** Draws a scene's picture (or text-card background) filling the frame. */
function paintScene(ctx: Ctx2D, fc: FrameContext, timed: TimedScene, frame: number): void {
  const { width: w, height: h } = fc;
  const media = fc.media[timed.index] as SceneMedia;
  const local = frame - timed.startFrame;
  if (!media.image) {
    paintTextCard(ctx, w, h, timed, local / Math.max(1, timed.frameCount - 1));
    return;
  }
  const shots = shotsOf(timed);
  const { shot, index } = shotAt(shots, Math.max(0, Math.min(timed.frameCount - 1, local)));
  const t = clamp01((local - shot.startFrame) / Math.max(1, shot.frameCount - 1));
  const m = glide(t);
  let zoom = lerp(shot.zoomFrom, shot.zoomTo, m);
  // A quick punch-in on each cut inside a scene gives the edit some energy.
  const sinceCut = local - shot.startFrame;
  if (index > 0 && sinceCut >= 0 && sinceCut < 6) zoom *= 1 + 0.05 * (1 - sinceCut / 6);
  // Gentle handheld drift so the frame is never perfectly still.
  const seed = timed.index * 7 + index;
  const panX = lerp(shot.panX[0], shot.panX[1], m) + 0.03 * Math.sin(frame * 0.071 + seed);
  const panY = lerp(shot.panY[0], shot.panY[1], m) + 0.025 * Math.sin(frame * 0.053 + seed * 2);
  const crop = coverRect(
    media.image.width,
    media.image.height,
    w,
    h,
    zoom,
    clampPan(panX),
    clampPan(panY),
  );
  if (media.gpu && fc.parallax) {
    const cam = lerp(shot.camera[0], shot.camera[1], m);
    const out = fc.parallax.draw(timed.index, { crop, camera: [cam, cam * 0.25] }, 0.045);
    ctx.drawImage(out, 0, 0, w, h);
  } else {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(media.image, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  }
}

function paintTransition(
  ctx: Ctx2D,
  fc: FrameContext,
  frame: number,
  from: TimedScene,
  to: TimedScene,
  p: number,
  kind: string,
): void {
  const { width: w, height: h } = fc;
  const e = ease(p);
  const layer = (scene: TimedScene, alpha: number, dx = 0, scale = 1) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(w / 2 + dx, h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-w / 2, -h / 2);
    paintScene(ctx, fc, scene, frame);
    ctx.restore();
  };
  switch (kind) {
    case "zoom":
      layer(from, 1, 0, 1 + e * 0.5);
      layer(to, e, 0, 1.35 - 0.35 * e);
      break;
    case "slide":
      layer(from, 1, -e * w);
      layer(to, 1, (1 - e) * w);
      break;
    case "whip": {
      const q = p < 0.5 ? (2 * p) ** 3 / 2 : 1 - (2 - 2 * p) ** 3 / 2;
      for (const k of [0, 2, 1]) {
        const blur = (k - 1) * w * 0.04 * Math.sin(Math.PI * p);
        const a = k === 1 ? 1 : 0.35;
        layer(from, a, -q * w + blur);
        layer(to, a, (1 - q) * w + blur);
      }
      break;
    }
    case "flash":
      layer(from, 1);
      layer(to, e);
      ctx.fillStyle = `rgba(255,255,255,${(0.85 * (1 - Math.abs(2 * p - 1))).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      break;
    default:
      layer(from, 1);
      layer(to, e);
  }
}

function paintTextCard(ctx: Ctx2D, w: number, h: number, timed: TimedScene, t: number) {
  const hue = (220 + timed.index * 37) % 360;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 60% 20%)`);
  g.addColorStop(1, `hsl(${(hue + 50) % 360} 65% 8%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Drifting light blobs and rising particles, so text scenes move too.
  for (let i = 0; i < 3; i++) {
    const cx = w * (0.2 + 0.6 * ((hash01(timed.index, i) + t * (0.3 + i * 0.1)) % 1));
    const cy = h * (0.25 + 0.5 * hash01(timed.index, i, 9));
    const r = Math.max(w, h) * (0.35 + 0.15 * i);
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    glow.addColorStop(0, `hsla(${(hue + i * 40) % 360} 90% 65% / 0.22)`);
    glow.addColorStop(1, "hsla(0 0% 0% / 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  for (let i = 0; i < 40; i++) {
    const x = w * hash01(timed.index, i, 1);
    const y = h * ((hash01(timed.index, i, 2) - t * (0.1 + 0.2 * hash01(i, 3)) + 1) % 1);
    const r = 1 + 2.5 * hash01(i, timed.index, 4);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintVignette(ctx: Ctx2D, w: number, h: number) {
  const g = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.35,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.75,
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Darker band at the bottom so captions read on any picture.
  const b = ctx.createLinearGradient(0, h * 0.55, 0, h);
  b.addColorStop(0, "rgba(0,0,0,0)");
  b.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = b;
  ctx.fillRect(0, h * 0.55, w, h * 0.45);
}

interface PlacedWord {
  word: TimedWord;
  index: number;
  x: number;
  y: number;
  width: number;
}

/** Lays out words centred in lines no wider than `maxWidth`. */
function layoutWords(
  ctx: Ctx2D,
  words: TimedWord[],
  maxWidth: number,
  centerX: number,
  centerY: number,
  lineH: number,
): PlacedWord[] {
  const space = ctx.measureText(" ").width * 1.35; // room for the highlighted word to grow
  const lines = wrapText(
    words.map((wd) => wd.text).join(" "),
    maxWidth,
    (s) => ctx.measureText(s).width,
  );
  const placed: PlacedWord[] = [];
  let k = 0;
  lines.forEach((line, li) => {
    const count = line.split(" ").length;
    const items = words.slice(k, k + count);
    const widths = items.map((wd) => ctx.measureText(wd.text).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * (items.length - 1);
    let x = centerX - total / 2;
    const y = centerY + (li - (lines.length - 1) / 2) * lineH;
    items.forEach((wd, i) => {
      placed.push({ word: wd, index: k + i, x, y, width: widths[i] ?? 0 });
      x += (widths[i] ?? 0) + space;
    });
    k += count;
  });
  return placed;
}

function paintCaptions(ctx: Ctx2D, w: number, h: number, groups: TimedWord[][], seconds: number) {
  const now = activeWords(groups, seconds);
  if (!now) return;
  const size = Math.round(Math.min(w, h) * 0.075);
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const placed = layoutWords(
    ctx,
    now.group,
    w * 0.84,
    w / 2,
    h * (w < h ? 0.72 : 0.8),
    size * 1.18,
  );
  // The group pops in when it first appears.
  const groupAge = seconds - (now.group[0]?.start ?? seconds);
  const groupScale = groupAge < 0.12 ? 0.85 + (Math.max(0, groupAge) / 0.12) * 0.15 : 1;
  for (const p of placed) {
    const active = p.index === now.active;
    const age = seconds - p.word.start;
    const pop = active && age < 0.14 ? 1 + 0.18 * (1 - Math.max(0, age) / 0.14) : active ? 1.06 : 1;
    const scale = pop * groupScale;
    ctx.save();
    ctx.translate(p.x + p.width / 2, p.y);
    ctx.scale(scale, scale);
    ctx.lineWidth = Math.max(5, size * 0.18);
    ctx.strokeStyle = "rgba(0,0,0,0.92)";
    ctx.strokeText(p.word.text, -p.width / 2, 0);
    ctx.fillStyle = active ? HIGHLIGHT : "#ffffff";
    ctx.fillText(p.word.text, -p.width / 2, 0);
    ctx.restore();
  }
}

/** Text scenes: the line is shown big in the centre, each word rising in as it's said. */
function paintKineticText(
  ctx: Ctx2D,
  w: number,
  h: number,
  groups: TimedWord[][],
  seconds: number,
) {
  // Keep the last line on screen after the voice finishes, until the scene ends.
  const last = groups[groups.length - 1];
  const lastEnd = last?.[last.length - 1]?.end ?? 0;
  const now =
    activeWords(groups, seconds) ??
    (last && seconds >= lastEnd ? { group: last, active: last.length - 1 } : null);
  if (!now) return;
  const size = Math.round(Math.min(w, h) * 0.1);
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const placed = layoutWords(ctx, now.group, w * 0.82, w / 2, h * 0.48, size * 1.15);
  for (const p of placed) {
    const shown = clamp01((seconds - p.word.start + 0.25) / 0.2);
    if (shown <= 0) continue;
    ctx.save();
    ctx.globalAlpha = shown;
    ctx.translate(p.x, p.y + (1 - shown) * size * 0.5);
    ctx.fillStyle = p.index === now.active ? HIGHLIGHT : "#ffffff";
    ctx.fillText(p.word.text, 0, 0);
    ctx.restore();
  }
}

function paintTitle(ctx: Ctx2D, w: number, h: number, title: string, seconds: number) {
  const size = Math.round(Math.min(w, h) * 0.062);
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const words = title
    .trim()
    .split(/\s+/)
    .slice(0, 10)
    .map((text, i) => ({ text, start: 0.15 + i * 0.08, end: 99 }));
  const placed = layoutWords(ctx, words, w * 0.84, w / 2, h * 0.16, size * 1.15);
  const out = clamp01((seconds - 1.9) / 0.4);
  for (const p of placed) {
    const inT = clamp01((seconds - p.word.start) / 0.3);
    const a = ease(inT) * (1 - out);
    if (a <= 0) continue;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(p.x, p.y + (1 - ease(inT)) * size * 0.8 - out * size * 0.4);
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(4, size * 0.16);
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(p.word.text, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(p.word.text, 0, 0);
    ctx.restore();
  }
}

function paintProgress(ctx: Ctx2D, w: number, h: number, fraction: number) {
  const barH = Math.max(4, Math.round(h * 0.005));
  const y = Math.round(h * 0.03);
  const x = Math.round(w * 0.06);
  const full = w - 2 * x;
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fillRect(x, y, full, barH);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillRect(x, y, full * clamp01(fraction), barH);
}

/** Pre-made noise tiles; one is overlaid per frame (shifted) for a light film grain. */
export function makeGrain(ctx: Ctx2D): CanvasPattern[] | null {
  try {
    const size = 160;
    const tiles: CanvasPattern[] = [];
    for (let k = 0; k < 4; k++) {
      const c =
        typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(size, size)
          : Object.assign(document.createElement("canvas"), { width: size, height: size });
      const g = c.getContext("2d") as Ctx2D | null;
      if (!g) return null;
      const img = g.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const v = Math.floor(hash01(k, i) * 255);
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const pattern = ctx.createPattern(c as CanvasImageSource, "repeat");
      if (!pattern) return null;
      tiles.push(pattern);
    }
    return tiles;
  } catch {
    return null;
  }
}

function paintGrain(ctx: Ctx2D, w: number, h: number, tiles: CanvasPattern[], frame: number) {
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = tiles[frame % tiles.length] as CanvasPattern;
  const ox = Math.floor(hash01(frame, 1) * 160);
  const oy = Math.floor(hash01(frame, 2) * 160);
  ctx.translate(-ox, -oy);
  ctx.fillRect(0, 0, w + ox, h + oy);
  ctx.restore();
}
