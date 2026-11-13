import type { RenderManifest } from "@avs/schemas";
import {
  captionAt,
  captionChunks,
  coverRect,
  ease,
  motionFor,
  wrapText,
  type CaptionChunk,
  type TimedScene,
} from "./timeline";

/** Draws one video frame onto a 2D canvas: image with Ken Burns motion, text cards, captions. */

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface SceneMedia {
  image: ImageBitmap | null;
  captions: CaptionChunk[];
}

export function prepareCaptions(scene: RenderManifest["scenes"][number]): CaptionChunk[] {
  return captionChunks(scene.caption);
}

const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
const FADE_FRAMES = 8;

export function paintFrame(
  ctx: Ctx2D,
  width: number,
  height: number,
  timed: TimedScene,
  media: SceneMedia,
  frame: number,
  title: string,
): void {
  const local = frame - timed.startFrame;
  const t = timed.frameCount > 1 ? local / (timed.frameCount - 1) : 0;
  ctx.save();
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, width, height);

  if (media.image) {
    const m = motionFor(timed.index);
    const e = ease(t);
    const zoom = m.zoomFrom + (m.zoomTo - m.zoomFrom) * e;
    const panX = m.panX[0] + (m.panX[1] - m.panX[0]) * e;
    const panY = m.panY[0] + (m.panY[1] - m.panY[0]) * e;
    const r = coverRect(media.image.width, media.image.height, width, height, zoom, panX, panY);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(media.image, r.x, r.y, r.w, r.h, 0, 0, width, height);
    // Darken the bottom so captions stay readable on any image.
    const g = ctx.createLinearGradient(0, height * 0.55, 0, height);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.65)");
    ctx.fillStyle = g;
    ctx.fillRect(0, height * 0.55, width, height * 0.45);
  } else {
    paintTextCard(ctx, width, height, timed, title, t);
  }

  const caption = captionAt(media.captions, t);
  if (caption) paintCaption(ctx, width, height, caption);

  // Quick dip from black at each cut (longer at the very start), and a fade out at the very end.
  const fadeIn = timed.index === 0 ? FADE_FRAMES * 1.5 : FADE_FRAMES / 2;
  const inAlpha = 1 - Math.min(1, local / fadeIn);
  const outAlpha = isLast(timed)
    ? 1 - Math.min(1, (timed.frameCount - 1 - local) / (FADE_FRAMES * 1.5))
    : 0;
  const alpha = Math.max(inAlpha, outAlpha);
  if (alpha > 0.001) {
    ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}

let lastIndex = -1;
/** Set by the renderer so the painter knows which scene ends the video. */
export function setLastSceneIndex(i: number) {
  lastIndex = i;
}
const isLast = (t: TimedScene) => t.index === lastIndex;

function paintTextCard(
  ctx: Ctx2D,
  w: number,
  h: number,
  timed: TimedScene,
  title: string,
  t: number,
) {
  const hue = (220 + timed.index * 37) % 360;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue} 55% 18%)`);
  g.addColorStop(1, `hsl(${(hue + 40) % 360} 60% 8%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Slowly drifting light, so text cards still feel animated.
  const cx = w * (0.3 + 0.4 * t);
  const glow = ctx.createRadialGradient(cx, h * 0.35, 0, cx, h * 0.35, Math.max(w, h) * 0.6);
  glow.addColorStop(0, `hsla(${hue} 90% 70% / 0.25)`);
  glow.addColorStop(1, "hsla(0 0% 0% / 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  const size = Math.round(Math.min(w, h) * 0.05);
  ctx.font = `600 ${size}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(
    `${timed.scene.scene_number}`.padStart(2, "0") + `  ·  ${title}`.slice(0, 40),
    w / 2,
    h * 0.12,
  );
}

function paintCaption(ctx: Ctx2D, w: number, h: number, text: string) {
  const size = Math.round(Math.min(w, h) * 0.068);
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = wrapText(text, w * 0.86, (s) => ctx.measureText(s).width).slice(0, 3);
  const lineH = size * 1.2;
  const baseY = h * (w < h ? 0.74 : 0.8) - ((lines.length - 1) * lineH) / 2;
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(4, size * 0.16);
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.fillStyle = "#ffffff";
  lines.forEach((line, i) => {
    const y = baseY + i * lineH;
    ctx.strokeText(line, w / 2, y);
    ctx.fillText(line, w / 2, y);
  });
}
