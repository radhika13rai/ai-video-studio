import type { GraphicsLayout, GraphicsPreset } from "@avs/schemas";
import type { Ctx2D } from "../painter";
import { cueFrame, cues, type GraphicsCue } from "./cues";
import {
  bodyText,
  card,
  check,
  checkSlot,
  connector,
  connectorPoint,
  diamond,
  extrudedHeadline,
  pill,
  ripple,
  roundRect,
  type MascotAction,
} from "./primitives";
import { clamp01, easeInOutCubic, easeOutCubic, lerp, POP, SOFT, spring } from "./springs";
import { bodyFont, displayFont, type Tokens } from "./theme";

export { cues, cueFrame, type GraphicsCue } from "./cues";

/**
 * One draw function per layout preset (ADR 048). All positions are design pixels on the
 * 1080 × 1920 canvas, with text kept inside Instagram's safe area (y 220–1540). Every element
 * enters at its cue frame (see cues.ts) and the whole layout fades over the scene's last frames.
 */

const FPS = 30;

export interface PresetFrame {
  local: number;
  frame: number;
  durationFrames: number;
  tk: Tokens;
  cues: GraphicsCue[];
}

/** Frames since the keyed element's cue (negative before it enters). */
const ageOf = (f: PresetFrame, key: string) => f.local - cueFrame(f.cues, key, 0);
const pop = (age: number) => spring(age, FPS, POP);
const soft = (age: number) => spring(age, FPS, SOFT);
const appear = (age: number) => clamp01(age / 4);

type Draw<P extends GraphicsPreset> = (
  ctx: Ctx2D,
  l: Extract<GraphicsLayout, { preset: P }>,
  f: PresetFrame,
) => void;

const COVERS = ["#2F6BFF", "#111827", "#22C55E", "#A855F7", "#EF4444", "#0EA5E9"];

const hookHeadline: Draw<"hook_headline"> = (ctx, l, f) => {
  if (l.pill) {
    const a = ageOf(f, "pill");
    pill(ctx, 540, 300, l.pill, f.tk, {
      scale: pop(a),
      alpha: appear(a),
      fill: "#111827",
      color: "#FFFFFF",
      icon: "✦",
      size: 32,
    });
  }
  extrudedHeadline(ctx, l.headline, 540, l.pill ? 560 : 520, ageOf(f, "headline"), f.tk, {
    maxSize: 150,
  });
  // Book-cover cards floating around the anchor, in two columns.
  const slots = [
    [170, 900],
    [910, 900],
    [170, 1150],
    [910, 1150],
    [170, 1400],
    [910, 1400],
  ] as const;
  l.items.forEach((item, i) => {
    const a = ageOf(f, `item:${i}`);
    const s = pop(a);
    if (s <= 0.001) return;
    const [x, y] = slots[i] ?? [540, 1300];
    const bob = Math.sin(f.frame * 0.06 + i * 1.7) * 10;
    const rot = (i % 2 ? 1 : -1) * (0.06 + 0.03 * (i % 3));
    ctx.save();
    ctx.globalAlpha *= appear(a);
    ctx.translate(x, y + bob);
    ctx.rotate(rot);
    ctx.scale(s, s);
    const w = 160;
    const h = 200;
    ctx.shadowColor = f.tk.shadow.color;
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 12;
    roundRect(ctx, -w / 2, -h / 2, w, h, 16);
    ctx.fillStyle = COVERS[i % COVERS.length] as string;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(-w / 2, -h / 2, 14, h);
    bodyText(ctx, item, 6, -10, w - 34, 24, "#FFFFFF", {
      weight: 800,
      maxLines: 3,
      align: "center",
    });
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(-30, h / 2 - 34, 72, 6);
    ctx.restore();
  });
};

/** A list row card: icon dot, title and optional subtitle, sliding up into place. */
function rowCard(
  ctx: Ctx2D,
  f: PresetFrame,
  key: string,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  subtitle: string | undefined,
  icon: number,
): void {
  const a = ageOf(f, key);
  const s = soft(a);
  if (s <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= appear(a);
  ctx.translate(0, (1 - s) * 60);
  card(ctx, x, y, w, h, f.tk, { radius: 24 });
  ctx.fillStyle = COVERS[icon % COVERS.length] as string;
  roundRect(ctx, x + 22, y + h / 2 - 30, 60, 60, 16);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillRect(x + 38, y + h / 2 - 8, 28, 6);
  ctx.fillRect(x + 38, y + h / 2 + 4, 18, 6);
  const tx = x + 106;
  const tw = w - 130;
  if (subtitle) {
    bodyText(ctx, title, tx, y + h / 2 - 17, tw, 34, f.tk.ink, { weight: 800, maxLines: 1 });
    bodyText(ctx, subtitle, tx, y + h / 2 + 22, tw, 26, f.tk.muted, { weight: 600, maxLines: 1 });
  } else bodyText(ctx, title, tx, y + h / 2, tw, 36, f.tk.ink, { weight: 800, maxLines: 1 });
  ctx.restore();
}

const cardList: Draw<"card_list"> = (ctx, l, f) => {
  let top = 300;
  if (l.headline) {
    extrudedHeadline(ctx, l.headline, 540, 340, ageOf(f, "headline"), f.tk, {
      maxSize: 110,
      maxLines: 2,
    });
    top = 520;
  }
  const h = 110;
  const gap = 16;
  l.rows.forEach((r, i) =>
    rowCard(ctx, f, `row:${i}`, 90, top + i * (h + gap), 900, h, r.title, r.subtitle, i),
  );
};

const collectIntoAnchor: Draw<"collect_into_anchor"> = (ctx, l, f) => {
  let top = 330;
  if (l.headline) {
    extrudedHeadline(ctx, l.headline, 540, 330, ageOf(f, "headline"), f.tk, {
      maxSize: 96,
      maxLines: 1,
    });
    top = 470;
  }
  const target = { x: 540, y: 1130 };
  const collect = soft(ageOf(f, "collect"));
  const lines = clamp01(ageOf(f, "lines") / 14);
  const w = 400;
  const h = 112;
  l.cards.forEach((text, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = col ? 600 : 80;
    const y = top + row * (h + 46);
    const start = { x: x + w / 2, y: y + h };
    // Connector from the card to the folder, fading once the cards are collected.
    connector(ctx, start, target, lines - i * 0.06, f.tk, clamp01(1 - collect));
    const a = ageOf(f, `card:${i}`);
    const s = pop(a) * (1 - 0.75 * collect);
    if (s <= 0.001) return;
    const along = connectorPoint(start, target, easeInOutCubic(collect));
    const dx = along.x - start.x;
    const dy = along.y - start.y + (collect > 0 ? (-h / 2) * collect : 0);
    ctx.save();
    ctx.globalAlpha *= appear(a) * (1 - clamp01((collect - 0.75) / 0.25));
    ctx.translate(dx, dy);
    card(ctx, x, y, w, h, f.tk, { scale: s, radius: 22 });
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(s, s);
    ctx.fillStyle = COVERS[i % COVERS.length] as string;
    roundRect(ctx, -w / 2 + 20, -26, 52, 52, 14);
    ctx.fill();
    bodyText(ctx, text, -w / 2 + 92, 0, w - 112, 30, f.tk.ink, { weight: 800, maxLines: 2 });
    ctx.restore();
  });
  ripple(ctx, target.x, target.y + 40, ageOf(f, "ripple"), f.tk, 260);
};

const headlinePapers: Draw<"headline_papers"> = (ctx, l, f) => {
  extrudedHeadline(ctx, l.headline, 540, 540, ageOf(f, "headline"), f.tk, { maxSize: 150 });
  // Sheets fanning up out of the folder (drawn behind it: the folder is painted after presets
  // only when it is in front, so they rise from its centre).
  for (let i = 0; i < 4; i++) {
    const a = ageOf(f, `paper:${i}`);
    const s = soft(a);
    if (s <= 0.001) continue;
    const angle = (-0.36 + i * 0.24) * s;
    ctx.save();
    ctx.globalAlpha *= appear(a);
    ctx.translate(540 + (i - 1.5) * 70 * s, 1150 - 210 * s);
    ctx.rotate(angle);
    card(ctx, -95, -125, 190, 250, f.tk, { radius: 16 });
    ctx.fillStyle = "#E5E7EB";
    for (let k = 0; k < 6; k++) ctx.fillRect(-65, -90 + k * 30, k % 3 === 2 ? 80 : 130, 10);
    ctx.fillStyle = f.tk.accent;
    ctx.fillRect(-65, -110, 60, 10);
    ctx.restore();
  }
  if (l.caption) {
    const a = ageOf(f, "caption");
    pill(ctx, 540, 1470, l.caption, f.tk, { scale: pop(a), alpha: appear(a), size: 30 });
  }
};

const headlineBadge: Draw<"headline_badge"> = (ctx, l, f) => {
  extrudedHeadline(ctx, l.headline, 540, 560, ageOf(f, "headline"), f.tk, { maxSize: 150 });
  const d = ageOf(f, "diamond");
  diamond(ctx, 540, 1000, 220, f.frame, f.tk, pop(d));
  const b = ageOf(f, "badge");
  pill(ctx, 540, 1230, l.badge, f.tk, {
    scale: pop(b),
    alpha: appear(b),
    fill: f.tk.blue,
    color: "#FFFFFF",
    size: 36,
  });
};

const progressCard: Draw<"progress_card"> = (ctx, l, f) => {
  if (l.headline)
    extrudedHeadline(ctx, l.headline, 540, 470, ageOf(f, "headline"), f.tk, {
      maxSize: 120,
      maxLines: 2,
    });
  const a = ageOf(f, "card");
  const s = soft(a);
  if (s <= 0.001) return;
  const x = 100;
  const y = 760;
  const w = 880;
  const h = 270;
  ctx.save();
  ctx.globalAlpha *= appear(a);
  ctx.translate(0, (1 - s) * 70);
  card(ctx, x, y, w, h, f.tk);
  bodyText(ctx, l.label, x + 50, y + 70, w - 260, 38, f.tk.ink, { weight: 800, maxLines: 1 });
  const barStart = cueFrame(f.cues, "bar");
  const barEnd = cueFrame(f.cues, "done", barStart + 30);
  const p = easeInOutCubic(clamp01((f.local - barStart) / Math.max(1, barEnd - barStart)));
  const value = Math.round(l.percent * p);
  ctx.font = displayFont(64);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = f.tk.blue;
  ctx.fillText(`${value}%`, x + w - 50, y + 72);
  // Track and fill.
  roundRect(ctx, x + 50, y + 150, w - 100, 40, 20);
  ctx.fillStyle = "#E5E7EB";
  ctx.fill();
  const fillW = (w - 100) * (l.percent / 100) * p;
  if (fillW > 1) {
    roundRect(ctx, x + 50, y + 150, Math.max(40, fillW), 40, 20);
    const g = ctx.createLinearGradient(x + 50, 0, x + 50 + fillW, 0);
    g.addColorStop(0, "#7FA5FF");
    g.addColorStop(1, f.tk.blue);
    ctx.fillStyle = g;
    ctx.fill();
    // Moving sheen while loading.
    if (p < 1) {
      const sx = x + 50 + ((f.local * 18) % Math.max(40, fillW));
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(sx, y + 154, 26, 32);
    }
  }
  bodyText(ctx, p < 1 ? "Loading…" : "Done", x + 50, y + 228, 300, 26, f.tk.muted, {
    weight: 600,
    maxLines: 1,
  });
  check(ctx, x + w - 4, y + 4, 34, ageOf(f, "done"), f.tk);
  ctx.restore();
};

const checklist: Draw<"checklist"> = (ctx, l, f) => {
  extrudedHeadline(ctx, l.headline, 540, 430, ageOf(f, "headline"), f.tk, {
    maxSize: 140,
    maxLines: 2,
  });
  const h = 104;
  const gap = 20;
  const top = 620;
  l.rows.forEach((text, i) => {
    const a = ageOf(f, `row:${i}`);
    const s = soft(a);
    if (s <= 0.001) return;
    const y = top + i * (h + gap);
    ctx.save();
    ctx.globalAlpha *= appear(a);
    ctx.translate((1 - s) * -80, 0);
    card(ctx, 110, y, 860, h, f.tk, { radius: 24 });
    const ca = ageOf(f, `check:${i}`);
    if (ca < 0) checkSlot(ctx, 170, y + h / 2, 28);
    check(ctx, 170, y + h / 2, 30, ca, f.tk);
    bodyText(ctx, text, 225, y + h / 2, 700, 36, ca >= 0 ? f.tk.ink : f.tk.muted, {
      weight: 800,
      maxLines: 1,
    });
    ctx.restore();
  });
};

/** Three dots bouncing in turn: someone is typing. */
function typingDots(ctx: Ctx2D, cx: number, cy: number, frame: number, color: string): void {
  for (let i = 0; i < 3; i++) {
    const b = Math.max(0, Math.sin(frame * 0.3 - i * 0.9)) * 12;
    ctx.beginPath();
    ctx.arc(cx + (i - 1) * 30, cy - b, 10, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** A chat bubble card with an avatar; returns its height. */
function bubble(
  ctx: Ctx2D,
  f: PresetFrame,
  x: number,
  y: number,
  w: number,
  text: string,
  opts: { avatar: string; fill?: string; color?: string; size?: number; maxLines?: number },
): number {
  const size = opts.size ?? 40;
  ctx.save();
  ctx.font = bodyFont(size, 700);
  const maxLines = opts.maxLines ?? 3;
  const n = Math.max(1, Math.min(maxLines, Math.ceil(ctx.measureText(text).width / (w - 170))));
  ctx.restore();
  const h = Math.max(140, 70 + n * size * 1.25);
  card(ctx, x, y, w, h, f.tk, { fill: opts.fill ?? f.tk.card });
  ctx.beginPath();
  ctx.arc(x + 62, y + 70, 34, 0, Math.PI * 2);
  ctx.fillStyle = opts.avatar;
  ctx.fill();
  bodyText(ctx, text, x + 120, y + h / 2, w - 160, size, opts.color ?? f.tk.ink, {
    weight: 700,
    maxLines,
  });
  return h;
}

const chatObjection: Draw<"chat_objection"> = (ctx, l, f) => {
  const m = ageOf(f, "message");
  const ms = soft(m);
  if (ms > 0.001) {
    ctx.save();
    ctx.globalAlpha *= appear(m);
    ctx.translate(0, (1 - ms) * 60);
    bubble(ctx, f, 90, 470, 860, `“${l.message}”`, { avatar: "#9CA3AF", size: 46 });
    ctx.restore();
  }
  const la = ageOf(f, "label");
  const ls = pop(la);
  if (ls > 0.001) {
    ctx.save();
    ctx.translate(540, 790);
    ctx.rotate(-0.06);
    ctx.scale(ls, ls);
    ctx.globalAlpha *= appear(la);
    ctx.font = displayFont(88);
    const text = l.label.toUpperCase();
    const w = ctx.measureText(text).width + 70;
    ctx.shadowColor = "rgba(239,68,68,0.35)";
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 12;
    roundRect(ctx, -w / 2, -64, w, 128, 24);
    ctx.fillStyle = f.tk.red;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 6);
    ctx.restore();
  }
  const ta = ageOf(f, "typing");
  const ts = soft(ta);
  if (ts > 0.001) {
    ctx.save();
    ctx.globalAlpha *= appear(ta);
    ctx.translate((1 - ts) * 90, 0);
    card(ctx, 560, 960, 390, 130, f.tk, { fill: f.tk.blue });
    typingDots(ctx, 755, 1030, f.frame, "#FFFFFF");
    ctx.restore();
  }
};

const chatReply: Draw<"chat_reply"> = (ctx, l, f) => {
  const r = ageOf(f, "reply");
  const s = soft(r);
  if (s <= 0.001) return;
  const typed = Math.max(0, ageOf(f, "typing"));
  const chars = Math.min(l.reply.length, Math.floor(typed / 0.6));
  const shown = l.reply.slice(0, chars);
  ctx.save();
  ctx.globalAlpha *= appear(r);
  ctx.translate(0, (1 - s) * 60);
  // Card sized for the full reply so it doesn't grow while typing.
  ctx.font = bodyFont(44, 700);
  const lines = Math.max(1, Math.min(4, Math.ceil(ctx.measureText(l.reply).width / 640)));
  const h = 120 + lines * 56;
  card(ctx, 90, 520, 900, h, f.tk);
  ctx.fillStyle = f.tk.blue;
  roundRect(ctx, 90, 520, 16, h, 8);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(160, 580, 30, 0, Math.PI * 2);
  ctx.fillStyle = f.tk.accent;
  ctx.fill();
  bodyText(ctx, "Reply", 210, 580, 400, 30, f.tk.muted, { weight: 700, maxLines: 1 });
  const caret = chars < l.reply.length || Math.floor(f.frame / 12) % 2 === 0 ? "▍" : "";
  ctx.font = bodyFont(44, 700);
  ctx.fillStyle = f.tk.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  // Wrap the full text, then reveal it character by character so lines never re-flow.
  const words = l.reply.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > 760 && cur) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  let left = shown.length;
  out.slice(0, 4).forEach((line, i) => {
    const part = line.slice(0, Math.max(0, left));
    left -= line.length + 1;
    const isLast = left < 0 || i === Math.min(3, out.length - 1);
    if (part || i === 0)
      ctx.fillText(
        part + (isLast && part.length < line.length + 1 ? caret : ""),
        130,
        640 + i * 56,
      );
  });
  ctx.restore();
  l.tags.forEach((tag, i) => {
    const a = ageOf(f, `tag:${i}`);
    pill(ctx, 300 + i * 480, 520 + h + 90, tag, f.tk, {
      scale: pop(a),
      alpha: appear(a),
      fill: i ? f.tk.accent : f.tk.blue,
      color: "#FFFFFF",
      size: 32,
    });
  });
};

const stackedCards: Draw<"stacked_cards"> = (ctx, l, f) => {
  let top = 330;
  if (l.headline) {
    extrudedHeadline(ctx, l.headline, 540, 340, ageOf(f, "headline"), f.tk, {
      maxSize: 110,
      maxLines: 2,
    });
    top = 500;
  }
  const h = 124;
  const gap = 38;
  const spineX = 150;
  const bottom = top + (l.cards.length - 1) * (h + gap) + h / 2;
  const sp = easeOutCubic(clamp01(ageOf(f, "spine") / 18));
  if (sp > 0) {
    ctx.save();
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.strokeStyle = f.tk.blue;
    ctx.beginPath();
    ctx.moveTo(spineX, top + h / 2);
    ctx.lineTo(spineX, lerp(top + h / 2, bottom, sp));
    ctx.stroke();
    ctx.restore();
  }
  l.cards.forEach((c, i) => {
    const a = ageOf(f, `card:${i}`);
    const s = soft(a);
    if (s <= 0.001) return;
    const y = top + i * (h + gap);
    ctx.save();
    ctx.globalAlpha *= appear(a);
    ctx.beginPath();
    ctx.arc(spineX, y + h / 2, 16 * pop(a), 0, Math.PI * 2);
    ctx.fillStyle = f.tk.blue;
    ctx.fill();
    ctx.translate((1 - s) * 90, 0);
    ctx.fillStyle = f.tk.blue;
    ctx.fillRect(spineX + 16, y + h / 2 - 3, 40, 6);
    card(ctx, 210, y, 780, h, f.tk, { radius: 24 });
    ctx.font = displayFont(44);
    ctx.fillStyle = f.tk.accent;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), 262, y + h / 2 + 2);
    if (c.subtitle) {
      bodyText(ctx, c.title, 312, y + h / 2 - 18, 650, 34, f.tk.ink, { weight: 800, maxLines: 1 });
      bodyText(ctx, c.subtitle, 312, y + h / 2 + 22, 650, 26, f.tk.muted, {
        weight: 600,
        maxLines: 1,
      });
    } else bodyText(ctx, c.title, 312, y + h / 2, 650, 36, f.tk.ink, { weight: 800, maxLines: 2 });
    ctx.restore();
  });
};

const ctaCard: Draw<"cta_card"> = (ctx, l, f) => {
  extrudedHeadline(ctx, l.headline, 540, 420, ageOf(f, "headline"), f.tk, {
    maxSize: 140,
    maxLines: 2,
  });
  const a = ageOf(f, "card");
  const s = pop(a);
  if (s <= 0.001) return;
  const x = 110;
  const y = 640;
  const w = 860;
  const h = 520;
  ctx.save();
  ctx.globalAlpha *= appear(a);
  card(ctx, x, y, w, h, f.tk, { scale: s });
  ctx.translate(540, y + h / 2);
  ctx.scale(s, s);
  ctx.translate(-540, -(y + h / 2));
  const ha = appear(ageOf(f, "handle"));
  ctx.save();
  ctx.globalAlpha *= ha;
  ctx.beginPath();
  ctx.arc(x + 110, y + 110, 56, 0, Math.PI * 2);
  const av = ctx.createLinearGradient(x + 54, y + 54, x + 166, y + 166);
  av.addColorStop(0, f.tk.accentLight);
  av.addColorStop(1, f.tk.accent);
  ctx.fillStyle = av;
  ctx.fill();
  bodyText(ctx, l.handle, x + 190, y + 95, w - 230, 40, f.tk.ink, { weight: 800, maxLines: 1 });
  bodyText(ctx, "Creator", x + 190, y + 140, 300, 26, f.tk.muted, { weight: 600, maxLines: 1 });
  ctx.restore();
  const ba = ageOf(f, "button");
  const bs = pop(ba);
  if (bs > 0.001) {
    ctx.save();
    ctx.globalAlpha *= appear(ba);
    ctx.translate(540, y + 290);
    ctx.scale(bs, bs);
    ctx.font = bodyFont(44, 800);
    const bw = Math.max(380, ctx.measureText(l.button).width + 120);
    roundRect(ctx, -bw / 2, -50, bw, 100, 50);
    ctx.fillStyle = f.tk.blue;
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(l.button, 0, 2);
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha *= appear(ageOf(f, "line"));
  bodyText(ctx, l.line, 540, y + 430, w - 100, 32, f.tk.muted, {
    weight: 700,
    maxLines: 2,
    align: "center",
  });
  ctx.restore();
  ctx.restore();
  // Curved orange arrow pointing at the button.
  const p = easeOutCubic(clamp01(ageOf(f, "arrow") / 14));
  if (p > 0) {
    ctx.save();
    ctx.strokeStyle = f.tk.accent;
    ctx.fillStyle = f.tk.accent;
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    const from = { x: 930, y: 1360 };
    const to = { x: 790, y: y + 330 };
    const ctl = { x: 990, y: y + 330 };
    const pt = (t: number) => ({
      x: (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * ctl.x + t * t * to.x,
      y: (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * ctl.y + t * t * to.y,
    });
    ctx.beginPath();
    for (let i = 0; i <= 24 * p; i++) {
      const q = pt(i / 24);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    if (p > 0.95) {
      const tip = pt(1);
      const back = pt(0.92);
      const ang = Math.atan2(tip.y - back.y, tip.x - back.x);
      ctx.translate(tip.x, tip.y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-24, -22);
      ctx.lineTo(-24, 22);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
};

const DRAW: { [P in GraphicsPreset]: Draw<P> } = {
  hook_headline: hookHeadline,
  card_list: cardList,
  collect_into_anchor: collectIntoAnchor,
  headline_papers: headlinePapers,
  headline_badge: headlineBadge,
  progress_card: progressCard,
  checklist,
  chat_objection: chatObjection,
  chat_reply: chatReply,
  stacked_cards: stackedCards,
  cta_card: ctaCard,
};

export function drawPreset(ctx: Ctx2D, layout: GraphicsLayout, f: PresetFrame): void {
  (DRAW[layout.preset] as Draw<GraphicsPreset>)(ctx, layout as never, f);
}

/* ----------------------------------- persistent poses ----------------------------------- */

export interface Pose {
  x: number;
  y: number;
  scale: number;
}

/** Where the anchor object sits for each preset (it glides between these across scenes). */
export const ANCHOR_POSE: Record<GraphicsPreset, Pose> = {
  hook_headline: { x: 540, y: 1150, scale: 1 },
  card_list: { x: 540, y: 1420, scale: 0.42 },
  collect_into_anchor: { x: 540, y: 1250, scale: 1 },
  headline_papers: { x: 540, y: 1230, scale: 0.95 },
  headline_badge: { x: 870, y: 1430, scale: 0.42 },
  progress_card: { x: 540, y: 1330, scale: 0.62 },
  checklist: { x: 880, y: 1440, scale: 0.38 },
  chat_objection: { x: 540, y: 1360, scale: 0.55 },
  chat_reply: { x: 860, y: 1440, scale: 0.4 },
  stacked_cards: { x: 880, y: 1450, scale: 0.36 },
  cta_card: { x: 540, y: 1380, scale: 0.42 },
};

/** Where the mascot stands (feet) for each preset, and what it does. */
export const MASCOT_POSE: Record<GraphicsPreset, Pose & { action: MascotAction; flip?: boolean }> =
  {
    hook_headline: { x: 540, y: 1500, scale: 0.85, action: "point" },
    card_list: { x: 760, y: 1500, scale: 0.75, action: "idle" },
    collect_into_anchor: { x: 830, y: 1500, scale: 0.8, action: "point", flip: true },
    headline_papers: { x: 850, y: 1500, scale: 0.8, action: "hop" },
    headline_badge: { x: 210, y: 1500, scale: 0.8, action: "point" },
    progress_card: { x: 820, y: 1500, scale: 0.8, action: "hop" },
    checklist: { x: 200, y: 1500, scale: 0.75, action: "hop" },
    chat_objection: { x: 830, y: 1500, scale: 0.8, action: "idle" },
    chat_reply: { x: 200, y: 1500, scale: 0.75, action: "point" },
    stacked_cards: { x: 660, y: 1500, scale: 0.72, action: "idle" },
    cta_card: { x: 220, y: 1500, scale: 0.85, action: "point" },
  };

/** The frame at which every element of the layout has entered (for stills and tests). */
export function busiestFrame(layout: GraphicsLayout, durationFrames: number): number {
  const list = cues(layout, durationFrames);
  // The collect layout is busiest just before its cards fly into the anchor.
  if (layout.preset === "collect_into_anchor")
    return Math.max(0, Math.min(durationFrames - 9, cueFrame(list, "collect") - 1));
  const last = Math.max(0, ...list.map((c) => c.frame));
  return Math.max(0, Math.min(durationFrames - 9, last + 16));
}
