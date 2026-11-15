import { DEFAULT_GRAPHICS_THEME, type GraphicsLayout, type GraphicsTheme } from "@avs/schemas";
import type { Ctx2D } from "../painter";
import { FPS, type TimedScene } from "../timeline";
import { cues, type GraphicsCue } from "./cues";
import { ANCHOR_POSE, drawPreset, MASCOT_POSE, type Pose } from "./presets";
import { dottedBackground, folder, mascot } from "./primitives";
import { exitFade, GLIDE, lerp, SOFT, spring } from "./springs";
import { DESIGN_H, DESIGN_W, tokens, type Tokens } from "./theme";

export { loadDisplayFont } from "./font";
export { cues, cueFrame, type GraphicsCue } from "./cues";
export { busiestFrame } from "./presets";
export { isDisplayFontReady } from "./theme";

/** True for scenes the graphics painter draws (ADR 048). */
export function isGraphicsScene(scene: TimedScene["scene"]): boolean {
  return scene.visual_type === "graphics";
}

/** A graphics scene's layout: its own, or a plain headline from its text when it has none. */
export function layoutOf(scene: TimedScene["scene"]): GraphicsLayout {
  if (scene.graphics) return scene.graphics;
  const text = (scene.on_screen_text || scene.caption || "").trim().slice(0, 40) || "…";
  return { preset: "headline_papers", headline: text };
}

const cueCache = new Map<string, GraphicsCue[]>();
/** Cues for a timed scene (cached: the painter asks every frame). */
export function sceneCues(t: TimedScene): GraphicsCue[] {
  const layout = layoutOf(t.scene);
  const key = `${t.frameCount}|${JSON.stringify(layout)}`;
  let c = cueCache.get(key);
  if (!c) {
    c = cues(layout, t.frameCount);
    if (cueCache.size > 200) cueCache.clear();
    cueCache.set(key, c);
  }
  return c;
}

const tokenCache = new WeakMap<object, Tokens>();
function tokensFor(theme: GraphicsTheme | undefined): Tokens {
  const key = theme ?? DEFAULT_GRAPHICS_THEME;
  let tk = tokenCache.get(key);
  if (!tk) {
    tk = tokens(key);
    tokenCache.set(key, tk);
  }
  return tk;
}

function mix(a: Pose, b: Pose, t: number): Pose {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), scale: lerp(a.scale, b.scale, t) };
}

/**
 * Draws one frame of a graphics scene: the dotted background, the persistent anchor object
 * gliding from its pose in the previous graphics scene, the preset's elements (fading out over
 * the scene's last frames) and the mascot. Laid out on the 1080 × 1920 design canvas and fitted
 * to the output frame.
 */
export function paintGraphicsScene(
  ctx: Ctx2D,
  w: number,
  h: number,
  timeline: TimedScene[],
  timed: TimedScene,
  frame: number,
  theme: GraphicsTheme | undefined,
): void {
  const tk = tokensFor(theme);
  const th = theme ?? DEFAULT_GRAPHICS_THEME;
  const layout = layoutOf(timed.scene);
  const local = Math.max(0, Math.min(timed.frameCount - 1, frame - timed.startFrame));
  const s = Math.min(w / DESIGN_W, h / DESIGN_H);
  ctx.save();
  ctx.fillStyle = tk.background;
  ctx.fillRect(0, 0, w, h);
  ctx.translate((w - DESIGN_W * s) / 2, (h - DESIGN_H * s) / 2);
  ctx.scale(s, s);
  dottedBackground(ctx, tk);

  const prev = timeline[timed.index - 1];
  const prevLayout = prev && isGraphicsScene(prev.scene) ? layoutOf(prev.scene) : null;
  const glide = spring(local, FPS, GLIDE);
  const enter = spring(local, FPS, SOFT);

  if (th.anchor === "folder") {
    const to = ANCHOR_POSE[layout.preset];
    const pose = prevLayout
      ? mix(ANCHOR_POSE[prevLayout.preset], to, glide)
      : { ...to, scale: to.scale * enter };
    folder(ctx, pose.x, pose.y, pose.scale, frame, tk);
  }

  ctx.save();
  ctx.globalAlpha = exitFade(local, timed.frameCount);
  drawPreset(ctx, layout, {
    local,
    frame,
    durationFrames: timed.frameCount,
    tk,
    cues: sceneCues(timed),
  });
  ctx.restore();

  if (th.mascot) {
    const to = MASCOT_POSE[layout.preset];
    const from = prevLayout ? MASCOT_POSE[prevLayout.preset] : null;
    const pose = from ? mix(from, to, glide) : { ...to, scale: to.scale * enter };
    // Turning round while walking: flip follows the destination after half the move.
    const flip = from && glide < 0.5 ? !!from.flip : !!to.flip;
    mascot(ctx, pose.x, pose.y, pose.scale, frame, glide < 0.9 && from ? "hop" : to.action, tk, {
      flip,
    });
  }
  ctx.restore();
}

/** Sound cues of every graphics scene, in seconds from the start of the video. */
export function graphicsSfxCues(
  timeline: TimedScene[],
): { at: number; kind: NonNullable<GraphicsCue["sfx"]>; gainDb?: number }[] {
  const out: { at: number; kind: NonNullable<GraphicsCue["sfx"]>; gainDb?: number }[] = [];
  for (const t of timeline) {
    if (!isGraphicsScene(t.scene)) continue;
    for (const c of sceneCues(t))
      if (c.sfx)
        out.push({
          at: (t.startFrame + c.frame) / FPS,
          kind: c.sfx,
          ...(c.gainDb !== undefined ? { gainDb: c.gainDb } : {}),
        });
  }
  return out;
}
