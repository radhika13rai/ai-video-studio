import type { RenderManifest } from "@avs/schemas";
import { describe, expect, it } from "vitest";
import { fitDurations, sceneWords, withDurations } from "./prepare";
import { speechPlan } from "./render";
import { memoryVoiceCache, speechKey } from "./voice-cache";

type Scene = RenderManifest["scenes"][number];
const scene = (over: Partial<Scene> = {}): Scene => ({
  scene_number: 1,
  start_seconds: 0,
  duration_seconds: 4,
  visual_type: "image",
  caption: "Caption text here",
  image_url: null,
  voice_url: null,
  ...over,
});

describe("shared render stages", () => {
  it("lengthens a scene to fit its narration, never shortens it", () => {
    const scenes = [scene(), scene({ duration_seconds: 2 }), scene()];
    expect(fitDurations(scenes, [3, 4, null])).toEqual([4, 4.35, 4]);
    const m = withDurations(
      {
        render_request_id: "r",
        render_attempt_token: "t",
        project: { id: "p", title: "T", aspect_ratio: "9:16", duration_seconds: 10 },
        scenes,
        fallbacks: [],
      },
      [4, 4.35, 4],
    );
    expect(m.scenes.map((s) => s.duration_seconds)).toEqual([4, 4.35, 4]);
  });

  it("times caption words over the voice when there is one", () => {
    const s = scene({ narration: "one two three four five six seven" });
    const voiced = sceneWords(s, 5, 3, true);
    expect(voiced.map((g) => g.length)).toEqual([4, 3]); // pictures: 4 words at a time
    expect(voiced.at(-1)!.at(-1)!.end).toBeLessThanOrEqual(3.05 + 1e-9);
    const card = sceneWords(
      scene({ narration: "one two three four five six seven" }),
      5,
      null,
      false,
    );
    expect(card.map((g) => g.length)).toEqual([6, 1]); // text cards: 6
  });
});

describe("speech plan and voice cache", () => {
  it("uses the scene's voice and speed, or fits the speed to the scene", () => {
    expect(speechPlan(scene({ narration: "  " }), "af_heart")).toBeNull();
    expect(
      speechPlan(
        scene({ narration: "Hi there.", voice_id: "am_michael", voice_speed: 1.1 }),
        "af_heart",
      ),
    ).toEqual({
      text: "Hi there.",
      voice: "am_michael",
      speed: 1.1,
    });
    // Unknown voices fall back; a long line speeds up (at most 1.2×).
    const long = speechPlan(
      scene({ narration: Array(40).fill("word").join(" "), voice_id: "nope" }),
      "af_heart",
    );
    expect(long).toMatchObject({ voice: "af_heart", speed: 1.2 });
  });

  it("keys a line by text, voice and speed", async () => {
    const a = await speechKey("Hello.", "af_heart", 1);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await speechKey(" Hello. ", "af_heart", 1)).toBe(a);
    expect(await speechKey("Hello.", "am_michael", 1)).not.toBe(a);
    expect(await speechKey("Hello.", "af_heart", 1.1)).not.toBe(a);
    const cache = memoryVoiceCache();
    await cache.put(a, { samples: new Float32Array([0.1, 0.2]), sampleRate: 24000 });
    expect((await cache.get(a))?.sampleRate).toBe(24000);
    expect(await cache.get("missing")).toBeNull();
  });
});
