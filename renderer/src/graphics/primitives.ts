import type { Ctx2D } from "../painter";
import { clamp01, easeOutCubic, lerp, POP, spring } from "./springs";
import { bodyFont, displayFont, DESIGN_H, DESIGN_W, type Tokens } from "./theme";

/** Drawing primitives for graphics scenes, in design pixels (ADR 048). */

const FPS = 30;

export function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ------------------------------------ background ------------------------------------ */

const bgCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

function surface(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  return typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
}

/** The light grey background with an even dot grid and a very soft vignette. */
export function dottedBackground(ctx: Ctx2D, tk: Tokens): void {
  const key = `${tk.background}|${tk.dot}`;
  let bg = bgCache.get(key);
  if (!bg) {
    bg = surface(DESIGN_W, DESIGN_H);
    const g = bg.getContext("2d") as Ctx2D;
    g.fillStyle = tk.background;
    g.fillRect(0, 0, DESIGN_W, DESIGN_H);
    g.fillStyle = tk.dot;
    const step = 36;
    for (let y = step / 2; y < DESIGN_H; y += step)
      for (let x = step / 2; x < DESIGN_W; x += step) {
        g.beginPath();
        g.arc(x, y, 2.4, 0, Math.PI * 2);
        g.fill();
      }
    const v = g.createRadialGradient(540, 900, 500, 540, 900, 1250);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(15,23,42,0.07)");
    g.fillStyle = v;
    g.fillRect(0, 0, DESIGN_W, DESIGN_H);
    bgCache.set(key, bg);
  }
  ctx.drawImage(bg as CanvasImageSource, 0, 0, DESIGN_W, DESIGN_H);
}

/* ------------------------------------- headline ------------------------------------- */

/** Breaks text into at most `maxLines` lines no wider than `maxWidth`. */
export function wrapLines(ctx: Ctx2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`;
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** The largest headline size (≤ maxSize) whose lines all fit `maxWidth` in ≤ maxLines lines. */
export function fitHeadline(
  ctx: Ctx2D,
  text: string,
  opts: { maxWidth?: number; maxSize?: number; minSize?: number; maxLines?: number } = {},
): { lines: string[]; size: number } {
  const maxWidth = opts.maxWidth ?? 960;
  const maxLines = opts.maxLines ?? 3;
  const min = opts.minSize ?? 64;
  for (let size = opts.maxSize ?? 150; size >= min; size -= 6) {
    ctx.font = displayFont(size);
    const words = text.split(/\s+/);
    if (words.some((w) => ctx.measureText(w).width > maxWidth)) continue;
    const lines = wrapLines(ctx, text, maxWidth, 99);
    if (lines.length <= maxLines) return { lines, size };
  }
  ctx.font = displayFont(min);
  return { lines: wrapLines(ctx, text, maxWidth, maxLines), size: min };
}

/**
 * Chunky extruded headline: orange face with a lighter top, a darker orange extrusion and a soft
 * drop shadow. Letters spring in one by one with overshoot, starting `age` frames after the cue.
 * Returns the block's height.
 */
export function extrudedHeadline(
  ctx: Ctx2D,
  text: string,
  cx: number,
  cy: number,
  age: number,
  tk: Tokens,
  opts: { maxSize?: number; maxLines?: number; alpha?: number } = {},
): number {
  const { lines, size } = fitHeadline(ctx, text.toUpperCase(), {
    ...(opts.maxSize ? { maxSize: opts.maxSize } : {}),
    ...(opts.maxLines ? { maxLines: opts.maxLines } : {}),
  });
  ctx.font = displayFont(size);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const lineH = size * 1.02;
  const depth = Math.max(4, Math.round(size * 0.075));
  const top = cy - ((lines.length - 1) * lineH) / 2;
  let k = 0;
  lines.forEach((line, li) => {
    const total = ctx.measureText(line).width;
    let x = cx - total / 2;
    const y = top + li * lineH;
    for (const ch of [...line]) {
      const adv = ctx.measureText(ch).width;
      if (ch !== " ") {
        const s = spring(age - k * 1.3, FPS, POP);
        if (s > 0.001) {
          ctx.save();
          ctx.globalAlpha = (opts.alpha ?? 1) * clamp01(s * 4);
          ctx.translate(x + adv / 2, y + (1 - s) * size * 0.45);
          ctx.scale(Math.max(0, s), Math.max(0, s));
          // Shadow + extrusion, back to front.
          ctx.save();
          ctx.shadowColor = "rgba(120,53,15,0.28)";
          ctx.shadowBlur = size * 0.16;
          ctx.shadowOffsetY = size * 0.1;
          ctx.fillStyle = tk.accentDark;
          ctx.fillText(ch, -adv / 2, depth);
          ctx.restore();
          ctx.fillStyle = tk.accentDark;
          for (let d = depth - 1; d > 0; d -= 1) ctx.fillText(ch, -adv / 2, d);
          const face = ctx.createLinearGradient(0, -size * 0.45, 0, size * 0.4);
          face.addColorStop(0, tk.accentLight);
          face.addColorStop(0.45, tk.accent);
          face.addColorStop(1, tk.accent);
          ctx.fillStyle = face;
          ctx.fillText(ch, -adv / 2, 0);
          ctx.restore();
        }
        k++;
      }
      x += adv;
    }
  });
  return lines.length * lineH + depth;
}

/* --------------------------------------- shapes --------------------------------------- */

/** A white rounded card with a soft shadow, scaled about its centre. */
export function card(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tk: Tokens,
  opts: { scale?: number; alpha?: number; fill?: string; radius?: number } = {},
): void {
  const s = opts.scale ?? 1;
  if (s <= 0.001 || (opts.alpha ?? 1) <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= clamp01(opts.alpha ?? 1);
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(s, s);
  ctx.shadowColor = tk.shadow.color;
  ctx.shadowBlur = tk.shadow.blur;
  ctx.shadowOffsetY = tk.shadow.y;
  roundRect(ctx, -w / 2, -h / 2, w, h, opts.radius ?? tk.radius);
  ctx.fillStyle = opts.fill ?? tk.card;
  ctx.fill();
  ctx.restore();
}

/** A rounded pill with centred text. Returns its width. */
export function pill(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  text: string,
  tk: Tokens,
  opts: {
    size?: number;
    fill?: string;
    color?: string;
    scale?: number;
    alpha?: number;
    icon?: string;
  } = {},
): number {
  const size = opts.size ?? 34;
  ctx.save();
  ctx.font = bodyFont(size, 800);
  const label = opts.icon ? `${opts.icon}  ${text}` : text;
  const w = ctx.measureText(label).width + size * 1.6;
  const h = size * 1.9;
  ctx.globalAlpha *= clamp01(opts.alpha ?? 1);
  ctx.translate(cx, cy);
  ctx.scale(opts.scale ?? 1, opts.scale ?? 1);
  ctx.shadowColor = tk.shadow.color;
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 8;
  roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fillStyle = opts.fill ?? tk.card;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = opts.color ?? tk.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 0, size * 0.04);
  ctx.restore();
  return w;
}

/** A green check badge: the circle pops, then the tick draws itself. */
export function check(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  r: number,
  age: number,
  tk: Tokens,
): void {
  const s = spring(age, FPS, POP);
  if (s <= 0.001) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = tk.green;
  ctx.fill();
  const p = clamp01((age - 3) / 7);
  if (p > 0) {
    const [x0, y0, x1, y1, x2, y2] = [-r * 0.45, 0.02 * r, -r * 0.12, r * 0.34, r * 0.5, -r * 0.32];
    const segA = 0.4;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    const a = clamp01(p / segA);
    ctx.lineTo(lerp(x0, x1, a), lerp(y0, y1, a));
    if (p > segA) {
      const b = clamp01((p - segA) / (1 - segA));
      ctx.lineTo(lerp(x1, x2, b), lerp(y1, y2, b));
    }
    ctx.lineWidth = r * 0.22;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#FFFFFF";
    ctx.stroke();
  }
  ctx.restore();
}

/** An empty check circle, before its tick lands. */
export function checkSlot(ctx: Ctx2D, cx: number, cy: number, r: number, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha *= clamp01(alpha);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#D1D5DB";
  ctx.stroke();
  ctx.restore();
}

/** A blue gem diamond with a facet highlight, gently rotating. */
export function diamond(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  size: number,
  frame: number,
  tk: Tokens,
  scale = 1,
): void {
  if (scale <= 0.001) return;
  ctx.save();
  ctx.translate(cx, cy + Math.sin(frame * 0.08) * 8);
  ctx.scale(scale, scale);
  ctx.rotate(Math.sin(frame * 0.04) * 0.08);
  ctx.shadowColor = "rgba(47,107,255,0.35)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s, 0);
  ctx.lineTo(0, s);
  ctx.lineTo(-s, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(-s, -s, s, s);
  g.addColorStop(0, "#8DB0FF");
  g.addColorStop(0.5, tk.blue);
  g.addColorStop(1, "#1D3FB0");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.45, -s * 0.1);
  ctx.lineTo(0, s * 0.2);
  ctx.lineTo(-s * 0.45, -s * 0.1);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fill();
  ctx.restore();
}

/** Expanding rings that fade: an object "receiving" something. */
export function ripple(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  age: number,
  tk: Tokens,
  radius = 220,
): void {
  if (age < 0) return;
  for (let i = 0; i < 3; i++) {
    const p = clamp01((age - i * 5) / 22);
    if (p <= 0 || p >= 1) continue;
    ctx.save();
    ctx.globalAlpha *= (1 - p) * 0.6;
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy,
      radius * easeOutCubic(p),
      radius * 0.45 * easeOutCubic(p),
      0,
      0,
      Math.PI * 2,
    );
    ctx.lineWidth = 6 * (1 - p) + 2;
    ctx.strokeStyle = tk.blue;
    ctx.stroke();
    ctx.restore();
  }
}

export type Point = { x: number; y: number };

function bezier(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** A point on the connector curve from `a` to `b` (t in 0–1); used to fly things along it. */
export function connectorPoint(a: Point, b: Point, t: number): Point {
  const midY = (a.y + b.y) / 2;
  return bezier(a, { x: a.x, y: midY }, { x: b.x, y: midY }, b, clamp01(t));
}

/** A blue connector curve that draws itself from `a` to `b`, with a dot riding its tip. */
export function connector(
  ctx: Ctx2D,
  a: Point,
  b: Point,
  progress: number,
  tk: Tokens,
  alpha = 1,
): void {
  const p = clamp01(progress);
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp01(alpha);
  ctx.beginPath();
  const steps = 32;
  for (let i = 0; i <= steps * p; i++) {
    const q = connectorPoint(a, b, i / steps);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  }
  const tip = connectorPoint(a, b, p);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.strokeStyle = tk.blue;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = tk.blue;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.restore();
}

/* ---------------------------------- persistent objects ---------------------------------- */

/**
 * The glossy orange-yellow folder: back panel with a tab, a paper peeking out, a front flap with
 * a highlight, and a soft shadow on the ground. Floats gently. (cx, cy) is the folder's centre.
 */
export function folder(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  scale: number,
  frame: number,
  tk: Tokens,
  alpha = 1,
): void {
  if (scale <= 0.001 || alpha <= 0.001) return;
  const float = Math.sin(frame * 0.07) * 10;
  const W = 330;
  const H = 250;
  ctx.save();
  ctx.globalAlpha *= clamp01(alpha);
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  // Ground shadow (stays put while the folder floats).
  const sh = ctx.createRadialGradient(0, H * 0.62, 10, 0, H * 0.62, W * 0.6);
  sh.addColorStop(0, `rgba(15,23,42,${(0.2 - float * 0.006).toFixed(3)})`);
  sh.addColorStop(1, "rgba(15,23,42,0)");
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.ellipse(0, H * 0.62, W * 0.6, 34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(0, float - 10);
  // Back panel with tab.
  const back = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
  back.addColorStop(0, "#F59E0B");
  back.addColorStop(1, tk.accentDark);
  ctx.fillStyle = back;
  roundRect(ctx, -W / 2, -H / 2 - 28, W * 0.42, 60, 18);
  ctx.fill();
  roundRect(ctx, -W / 2, -H / 2, W, H, 26);
  ctx.fill();
  // Paper.
  ctx.fillStyle = "#FFFFFF";
  roundRect(ctx, -W / 2 + 26, -H / 2 - 16, W - 52, H * 0.7, 14);
  ctx.fill();
  ctx.fillStyle = "#E5E7EB";
  for (let i = 0; i < 3; i++)
    ctx.fillRect(-W / 2 + 56, -H / 2 + 14 + i * 26, W * 0.55 - i * 30, 10);
  // Front flap (slightly skewed for depth) with gloss.
  ctx.save();
  ctx.transform(1, 0, -0.08, 1, 0, 0);
  const front = ctx.createLinearGradient(0, -H * 0.2, 0, H / 2);
  front.addColorStop(0, "#FFC23D");
  front.addColorStop(0.55, tk.accent);
  front.addColorStop(1, tk.accentDark);
  ctx.shadowColor = "rgba(120,53,15,0.3)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = -6;
  ctx.fillStyle = front;
  roundRect(ctx, -W / 2 + 6, -H * 0.18, W - 4, H * 0.68, 26);
  ctx.fill();
  ctx.shadowColor = "transparent";
  const gloss = ctx.createLinearGradient(0, -H * 0.18, 0, H * 0.1);
  gloss.addColorStop(0, "rgba(255,255,255,0.55)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  roundRect(ctx, -W / 2 + 22, -H * 0.15, W - 40, H * 0.22, 18);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

const SPRITE = [
  "..oooooooo..",
  ".oooooooooo.",
  "oowooooooooo",
  "ooeeooooeeoo",
  "ooeeooooeeoo",
  "oooooooooooo",
  "ooooddddoooo",
  "oooooooooooo",
  ".oooooooooo.",
  "..oo....oo..",
  "..dd....dd..",
];

export type MascotAction = "idle" | "hop" | "point";

/**
 * The small pixel-art mascot: blinks every few seconds, hops, or points sideways with a pixel
 * arm. Drawn from a sprite grid with square pixels (no smoothing). (x, y) is its feet.
 */
export function mascot(
  ctx: Ctx2D,
  x: number,
  y: number,
  scale: number,
  frame: number,
  action: MascotAction,
  tk: Tokens,
  opts: { alpha?: number; flip?: boolean } = {},
): void {
  if (scale <= 0.001 || (opts.alpha ?? 1) <= 0.001) return;
  const px = 9;
  const cols = SPRITE[0]?.length ?? 12;
  const rows = SPRITE.length;
  const blink = frame % 96 < 4;
  const hop =
    action === "hop" ? Math.abs(Math.sin(frame * 0.22)) * 26 : Math.abs(Math.sin(frame * 0.09)) * 6;
  ctx.save();
  ctx.globalAlpha *= clamp01(opts.alpha ?? 1);
  ctx.translate(x, y);
  ctx.scale(scale * (opts.flip ? -1 : 1), scale);
  // Shadow shrinks as it rises.
  ctx.fillStyle = "rgba(15,23,42,0.16)";
  ctx.beginPath();
  ctx.ellipse(0, 0, (cols * px) / 2.4 - hop * 0.6, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(-(cols * px) / 2, -rows * px - hop);
  const colors: Record<string, string> = {
    o: tk.accent,
    d: tk.accentDark,
    e: "#111827",
    w: "#FFE3C8",
  };
  SPRITE.forEach((row, r) => {
    [...row].forEach((c, k) => {
      let ch = c;
      if (blink && c === "e") ch = r === 4 ? "e" : "o";
      const fill = colors[ch];
      if (!fill) return;
      ctx.fillStyle = fill;
      ctx.fillRect(k * px, r * px, px + 0.5, px + 0.5);
    });
  });
  if (action === "point") {
    const reach = 2 + Math.round((Math.sin(frame * 0.18) + 1) * 0.75);
    ctx.fillStyle = tk.accent;
    for (let i = 0; i < reach; i++) ctx.fillRect((cols + i) * px, 5 * px, px + 0.5, px + 0.5);
    ctx.fillStyle = tk.accentDark;
    ctx.fillRect((cols + reach) * px, 4 * px, px + 0.5, px * 2 + 0.5);
  }
  ctx.restore();
}

/** Body text helper: draws `text` wrapped to `maxWidth`, returns the number of lines. */
export function bodyText(
  ctx: Ctx2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  color: string,
  opts: { weight?: number; maxLines?: number; align?: CanvasTextAlign; lineH?: number } = {},
): number {
  ctx.save();
  ctx.font = bodyFont(size, opts.weight ?? 700);
  ctx.fillStyle = color;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "middle";
  const lines = wrapLines(ctx, text, maxWidth, opts.maxLines ?? 2);
  const lh = opts.lineH ?? size * 1.22;
  lines.forEach((l, i) => ctx.fillText(l, x, y + (i - (lines.length - 1) / 2) * lh));
  ctx.restore();
  return lines.length;
}
