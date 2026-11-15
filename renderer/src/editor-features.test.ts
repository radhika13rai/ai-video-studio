import type { RenderManifest } from "@avs/schemas";
import { describe, expect, it } from "vitest";
import { mixCues } from "./render";
import { buildTimeline, FPS, transitionAt } from "./timeline";

type Scene = RenderManifest["scenes"][number];
const scene = (n: number, over: Partial<Scene> = {}): Scene => ({
  scene_number: n,
  start_seconds: (n - 1) * 4,
  duration_seconds: 4,
  visual_type: "image",
  caption: `Scene ${n}`,
  image_url: null,
  voice_url: null,
  ...over,
});
const manifest = (scenes: Scene[]): RenderManifest => ({
  render_request_id: "r",
  render_attempt_token: "t",
  project: { id: "p", title: "T", aspect_ratio: "9:16", duration_seconds: 12 },
  scenes,
  fallbacks: [],
});

describe("editor transition lengths", () => {
  it("uses the scene's own transition length, centred on the cut", () => {
    const { scenes } = buildTimeline(
      manifest([
        scene(1),
        scene(2, { transition_in: "crossfade", transition_seconds: 1 }),
        scene(3),
      ]),
    );
    const cut = scenes[1]!.startFrame;
    // 1 s = 30 frames: 15 either side of the cut.
    expect(transitionAt(scenes, cut - 15)?.kind).toBe("crossfade");
    expect(transitionAt(scenes, cut - 16)).toBeNull();
    expect(transitionAt(scenes, cut + 14)?.progress).toBeCloseTo(29 / 30, 5);
    // The default stays 14 frames (7 either side).
    const next = scenes[2]!.startFrame;
    expect(transitionAt(scenes, next - 7)).not.toBeNull();
    expect(transitionAt(scenes, next - 8)).toBeNull();
  });
});

describe("sound effect cues", () => {
  const { scenes } = buildTimeline(
    manifest([
      scene(1, { sfx: [{ kind: "riser", at_s: 3.5, gain_db: -3 }] }),
      scene(2, { transition_in: "whip", sfx: [{ kind: "pop", at_s: 0.5, gain_db: 0 }] }),
      scene(3, { transition_in: "flash" }),
    ]),
  );

  it("places each scene's effects at its start plus their offset, with transition effects", () => {
    expect(mixCues(scenes, true)).toEqual([
      { at: 3.5, kind: "riser", gainDb: -3 },
      { at: 3.75, kind: "whoosh" },
      { at: 4.5, kind: "pop", gainDb: 0 },
      { at: 8, kind: "hit" },
    ]);
  });

  it("keeps placed effects when automatic transition effects are off", () => {
    expect(mixCues(scenes, false).map((c) => c.kind)).toEqual(["riser", "pop"]);
    expect(scenes[1]!.startFrame / FPS).toBe(4);
  });
});
