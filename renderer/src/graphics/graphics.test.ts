import { GRAPHICS_PRESETS, renderManifestSchema, type GraphicsLayout } from "@avs/schemas";
import { describe, expect, it } from "vitest";
import { mixCues } from "../render";
import { buildTimeline, FPS, transitionAt } from "../timeline";
import { closeDealsManifest } from "./fixture";
import { graphicsSfxCues, layoutOf } from "./index";
import { busiestFrame, cues } from "./presets";
import { EXIT_FRAMES, GLIDE, POP, spring } from "./springs";
import { fitHeadline, wrapLines } from "./primitives";

const manifest = closeDealsManifest();
const layouts = manifest.scenes.map((s) => s.graphics as GraphicsLayout);

describe("springs", () => {
  it("starts at 0, settles at 1, and only the pop spring overshoots", () => {
    expect(spring(0, FPS, POP)).toBe(0);
    expect(spring(-5, FPS, POP)).toBe(0);
    expect(spring(90, FPS, POP)).toBeCloseTo(1, 3);
    const pop = Array.from({ length: 30 }, (_, f) => spring(f, FPS, POP));
    const glide = Array.from({ length: 60 }, (_, f) => spring(f, FPS, GLIDE));
    expect(Math.max(...pop)).toBeGreaterThan(1.05);
    expect(Math.max(...glide)).toBeLessThanOrEqual(1);
    expect(spring(7, FPS, POP)).toBe(spring(7, FPS, POP));
  });
});

describe("cues", () => {
  it("covers every preset in the fixture", () => {
    expect(new Set(layouts.map((l) => l.preset))).toEqual(new Set(GRAPHICS_PRESETS));
  });

  it.each(layouts.map((l, i) => [i + 1, l] as const))(
    "scene %i: deterministic and inside the scene",
    (_n, layout) => {
      for (const frames of [24, 60, 90, 300]) {
        const a = cues(layout, frames);
        expect(cues(layout, frames)).toEqual(a);
        expect(a.length).toBeGreaterThan(0);
        for (const c of a) {
          expect(c.frame).toBeGreaterThanOrEqual(0);
          expect(c.frame).toBeLessThan(frames);
          // Everything has entered before the exit fade starts.
          if (frames >= 60) expect(c.frame).toBeLessThan(frames - EXIT_FRAMES);
        }
        const busy = busiestFrame(layout, frames);
        expect(busy).toBeGreaterThanOrEqual(0);
        expect(busy).toBeLessThan(frames);
      }
    },
  );

  it("lands checks one by one, in order, after their rows", () => {
    const layout: GraphicsLayout = {
      preset: "checklist",
      headline: "LOADED",
      rows: ["a", "b", "c", "d", "e", "f"],
    };
    for (const frames of [45, 96, 240]) {
      const c = cues(layout, frames);
      const checks = c.filter((x) => x.key.startsWith("check:"));
      const rows = c.filter((x) => x.key.startsWith("row:"));
      expect(checks.map((x) => x.key)).toEqual([
        "check:0",
        "check:1",
        "check:2",
        "check:3",
        "check:4",
        "check:5",
      ]);
      for (let i = 1; i < checks.length; i++)
        expect(checks[i]!.frame).toBeGreaterThan(checks[i - 1]!.frame);
      expect(checks[0]!.frame).toBeGreaterThan(rows.at(-1)!.frame);
      expect(checks.every((x) => x.sfx === "confirm")).toBe(true);
    }
  });

  it("keeps the natural pace in long scenes and compresses short ones", () => {
    const l = layouts[0]!;
    expect(cues(l, 600)).toEqual(cues(l, 900));
    const short = cues(l, 40);
    expect(Math.max(...short.map((c) => c.frame))).toBeLessThan(40 - EXIT_FRAMES);
  });
});

describe("fixture and mix", () => {
  const { scenes: timeline, totalFrames } = buildTimeline(manifest);

  it("is a valid manifest of 12 graphics scenes, about 35 s long", () => {
    expect(renderManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.scenes).toHaveLength(12);
    expect(totalFrames / FPS).toBeCloseTo(34.8, 1);
  });

  it("has no blend or transition sound between graphics scenes", () => {
    for (const t of timeline.slice(1)) {
      for (const d of [-3, 0, 2]) expect(transitionAt(timeline, t.startFrame + d)).toBeNull();
    }
    expect(mixCues(timeline, true).some((c) => c.kind === "whoosh" && c.gainDb === undefined)).toBe(
      false,
    );
  });

  it("puts a sound on every cue that has one, at the cue's frame", () => {
    const sfx = graphicsSfxCues(timeline);
    const mix = mixCues(timeline, true);
    for (const t of timeline) {
      for (const c of cues(layoutOf(t.scene), t.frameCount)) {
        if (!c.sfx) continue;
        const at = (t.startFrame + c.frame) / FPS;
        expect(sfx.some((s) => Math.abs(s.at - at) < 1e-9 && s.kind === c.sfx)).toBe(true);
        expect(mix.some((s) => Math.abs(s.at - at) < 1e-9 && s.kind === c.sfx)).toBe(true);
      }
    }
    expect(sfx.length).toBeGreaterThan(50);
  });

  it("crossfades between a picture scene and a graphics scene", () => {
    const m = closeDealsManifest();
    m.scenes[1] = {
      ...m.scenes[1]!,
      visual_type: "image",
      transition_in: "whip",
      graphics: undefined,
    } as never;
    const { scenes: t } = buildTimeline(m);
    expect(transitionAt(t, t[1]!.startFrame)?.kind).toBe("crossfade");
  });
});

describe("text fitting", () => {
  // A fake measure: every character is 0.6 × the font size wide.
  const fake = {
    font: "",
    measureText(text: string) {
      const size = Number(/(\d+)px/.exec(fake.font)?.[1] ?? 10);
      return { width: text.length * size * 0.6 };
    },
  };
  const ctx = fake as unknown as CanvasRenderingContext2D;

  it("auto-fits a headline to 960 px in at most 3 lines", () => {
    const { lines, size } = fitHeadline(ctx, "CLOSE DEALS ON AUTOPILOT");
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) expect(l.length * size * 0.6).toBeLessThanOrEqual(960);
    const big = fitHeadline(ctx, "HI");
    expect(big.size).toBe(150);
  });

  it("ellipsises text past its line limit", () => {
    ctx.font = "700 40px Inter";
    const lines = wrapLines(ctx, "one two three four five six seven eight nine ten", 200, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });
});
