import type { RenderManifest } from "@avs/schemas";
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  captionAt,
  captionChunks,
  coverRect,
  motionFor,
  outputSize,
  sceneAt,
  wrapText,
} from "./timeline";
import { encodeWav } from "./wav";

const manifest = (durations: number[]): RenderManifest => ({
  render_request_id: "r",
  project: {
    id: "p",
    title: "t",
    aspect_ratio: "9:16",
    duration_seconds: durations.reduce((a, b) => a + b, 0),
  },
  scenes: durations.map((d, i) => ({
    scene_number: i + 1,
    start_seconds: 0,
    duration_seconds: d,
    visual_type: "image",
    caption: "",
    image_url: null,
    voice_url: null,
  })),
  fallbacks: [],
});

describe("timeline", () => {
  it("assigns whole frames that add up exactly, even with fractional seconds", () => {
    const { scenes, totalFrames } = buildTimeline(manifest([4.3, 5.1, 5.6, 4.9, 5.0, 5.1]));
    expect(totalFrames).toBe(900);
    expect(scenes.reduce((n, s) => n + s.frameCount, 0)).toBe(900);
    expect(scenes.map((s) => s.startFrame)).toEqual([0, 129, 282, 450, 597, 747]);
    expect(sceneAt(scenes, 0).index).toBe(0);
    expect(sceneAt(scenes, 129).index).toBe(1);
    expect(sceneAt(scenes, 899).index).toBe(5);
  });

  it("picks the output size for each format", () => {
    expect(outputSize("9:16", "720p")).toEqual({ width: 720, height: 1280 });
    expect(outputSize("16:9", "1080p")).toEqual({ width: 1920, height: 1080 });
    expect(outputSize("1:1", "720p")).toEqual({ width: 720, height: 720 });
  });
});

describe("captions", () => {
  it("breaks narration at sentences and commas into short timed chunks", () => {
    const chunks = captionChunks(
      "The deep ocean is home to giant tube worms, living in extreme conditions. They glow.",
    );
    expect(chunks.map((c) => c.text)).toEqual([
      "The deep ocean is home to",
      "giant tube worms,",
      "living in extreme conditions.",
      "They glow.",
    ]);
    expect(chunks[0]?.from).toBe(0);
    expect(chunks.at(-1)?.to).toBe(1);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]?.from).toBe(chunks[i - 1]?.to);
    expect(captionAt(chunks, 0)).toBe("The deep ocean is home to");
    expect(captionAt(chunks, 0.999)).toBe("They glow.");
    expect(captionChunks("   ")).toEqual([]);
  });

  it("does not leave a single dangling word", () => {
    expect(captionChunks("one two three four five six seven").map((c) => c.text)).toEqual([
      "one two three four five six seven",
    ]);
  });

  it("wraps lines to a width", () => {
    const lines = wrapText("aaa bbb ccc ddd", 7, (s) => s.length);
    expect(lines).toEqual(["aaa bbb", "ccc ddd"]);
    // Greedy wrapping would leave "to" alone; balanced wrapping splits near the middle.
    expect(wrapText("The deep ocean is home to", 22, (s) => s.length)).toEqual([
      "The deep ocean",
      "is home to",
    ]);
    expect(
      wrapText("one two three four five six seven eight nine ten", 12, (s) => s.length),
    ).toHaveLength(5);
  });
});

describe("motion and cropping", () => {
  it("centre-crops a square image to fill a vertical frame", () => {
    const r = coverRect(1024, 1024, 720, 1280, 1, 0, 0);
    expect(r.h).toBeCloseTo(1024);
    expect(r.w).toBeCloseTo(576);
    expect(r.x).toBeCloseTo(224);
    expect(r.y).toBeCloseTo(0);
  });

  it("zooms in and pans within the image", () => {
    const r = coverRect(1024, 1024, 720, 1280, 1.2, 1, 1);
    expect(r.x + r.w).toBeCloseTo(1024);
    expect(r.y + r.h).toBeCloseTo(1024);
    expect(motionFor(0)).toEqual(motionFor(4));
    expect(motionFor(1)).not.toEqual(motionFor(0));
  });
});

describe("wav", () => {
  it("writes a valid 16-bit PCM header and clamps samples", () => {
    const wav = encodeWav(
      [new Float32Array([0, 1, -1, 2]), new Float32Array([0, 0.5, -0.5, -2])],
      48000,
    );
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(dv.getUint16(22, true)).toBe(2);
    expect(dv.getUint32(24, true)).toBe(48000);
    expect(dv.getUint32(40, true)).toBe(16);
    expect(dv.getInt16(44 + 4 * 1, true)).toBe(32767);
    expect(dv.getInt16(44 + 4 * 3 + 2, true)).toBe(-32768);
  });
});
