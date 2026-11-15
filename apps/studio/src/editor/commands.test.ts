import { timelineFromProduction, timelineSchema, type Timeline } from "@avs/schemas";
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  coalesceKey,
  dropIndex,
  initialHistory,
  MAX_HISTORY,
  record,
  redo,
  trimmedDuration,
  tryCommand,
  undo,
} from "./commands";

export function sampleTimeline(): Timeline {
  return timelineFromProduction({
    aspect_ratio: "9:16",
    scenes: [1, 2, 3].map((n) => ({
      id: `s${n}`,
      scene_number: n,
      description: `Scene ${n}`,
      voiceover: `Line ${n}.`,
      duration_seconds: 5,
      visual_type: "image" as const,
    })),
    assets: [1, 2, 3].map((n) => ({ id: `img${n}`, scene_id: `s${n}`, asset_type: "image" })),
  });
}

const ids = (t: Timeline) => t.clips.map((c) => c.id);

describe("editor commands", () => {
  it("moves, duplicates and deletes clips without touching the input", () => {
    const t = sampleTimeline();
    const frozen = JSON.stringify(t);
    const moved = applyCommand(t, { type: "moveClip", from: 0, to: 2 });
    expect(ids(moved)).toEqual(["c_s2", "c_s3", "c_s1"]);
    expect(JSON.stringify(t)).toBe(frozen);
    const dup = applyCommand(t, { type: "duplicateClip", clipId: "c_s2", newId: "c_copy" });
    expect(ids(dup)).toEqual(["c_s1", "c_s2", "c_copy", "c_s3"]);
    expect(timelineSchema.safeParse(dup).success).toBe(true);
    expect(ids(applyCommand(t, { type: "deleteClip", clipId: "c_s1" }))).toEqual(["c_s2", "c_s3"]);
    const one = { ...t, clips: [t.clips[0]!] };
    expect(applyCommand(one, { type: "deleteClip", clipId: "c_s1" })).toBe(one); // never empty
  });

  it("clamps lengths and keeps overlays and sounds inside a shortened clip", () => {
    let t = sampleTimeline();
    t = applyCommand(t, {
      type: "addOverlay",
      clipId: "c_s1",
      overlay: {
        id: "o1",
        text: "Hi",
        start_s: 4,
        duration_s: 1,
        preset: "title",
        x: 0.5,
        y: 0.5,
        animation: "fade",
      },
    });
    t = applyCommand(t, {
      type: "addSfx",
      clipId: "c_s1",
      sfx: { id: "x1", kind: "pop", at_s: 4.5, gain_db: 0 },
    });
    t = applyCommand(t, { type: "setDuration", clipId: "c_s1", seconds: 2.04 });
    const c = t.clips[0]!;
    expect(c.duration_s).toBe(2);
    expect(c.overlays[0]).toMatchObject({ start_s: 1.8, duration_s: 0.2 });
    expect(c.sfx[0]!.at_s).toBeCloseTo(1.95, 5);
    expect(timelineSchema.safeParse(t).success).toBe(true);
    expect(
      applyCommand(t, { type: "setDuration", clipId: "c_s1", seconds: 99 }).clips[0]!.duration_s,
    ).toBe(30);
    expect(
      applyCommand(t, { type: "setDuration", clipId: "c_s1", seconds: 0 }).clips[0]!.duration_s,
    ).toBe(0.5);
  });

  it("edits voice, captions, music, aspect ratio and transition sounds", () => {
    let t = sampleTimeline();
    t = applyCommand(t, {
      type: "updateVoice",
      clipId: "c_s2",
      patch: { text: "New line", voice_id: "am_michael" },
    });
    t = applyCommand(t, { type: "setCaptions", patch: { style: "karaoke" } });
    t = applyCommand(t, { type: "setMusic", patch: { mode: "none" } });
    t = applyCommand(t, { type: "setAspect", aspect: "16:9" });
    t = applyCommand(t, { type: "setAutoTransitionSfx", on: false });
    expect(t.clips[1]!.voice).toMatchObject({ text: "New line", voice_id: "am_michael" });
    expect(t).toMatchObject({
      aspect_ratio: "16:9",
      captions: { style: "karaoke" },
      music: { mode: "none" },
      auto_transition_sfx: false,
    });
  });

  it("refuses edits that would make an invalid timeline, with the reason", () => {
    const t = sampleTimeline();
    let long = t;
    for (const c of t.clips)
      long = applyCommand(long, { type: "setDuration", clipId: c.id, seconds: 30 });
    // 3 × 30 s + one more 30 s copy is exactly the 120 s limit; a fifth clip is too much.
    const full = tryCommand(long, { type: "duplicateClip", clipId: "c_s1", newId: "c_more" });
    expect(full.ok).toBe(true);
    const res = tryCommand(full.ok ? full.timeline : long, {
      type: "duplicateClip",
      clipId: "c_s1",
      newId: "c_again",
    });
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/the most is 120 s/) });
    expect(tryCommand(t, { type: "moveClip", from: 1, to: 1 })).toEqual({ ok: true, timeline: t });
  });
});

describe("undo and redo", () => {
  it("records, undoes and redoes; a new edit clears redo", () => {
    const t0 = sampleTimeline();
    const t1 = applyCommand(t0, { type: "moveClip", from: 0, to: 1 });
    const t2 = applyCommand(t1, { type: "setAspect", aspect: "1:1" });
    let h = record(record(initialHistory(t0), t1, null, 0), t2, null, 10);
    expect(h.present).toBe(t2);
    h = undo(h);
    expect(h.present).toBe(t1);
    h = undo(h);
    expect(h.present).toBe(t0);
    expect(undo(h)).toBe(h); // nothing more to undo
    h = redo(h);
    expect(h.present).toBe(t1);
    const t3 = applyCommand(t1, { type: "setAspect", aspect: "16:9" });
    h = record(h, t3, null, 20);
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it("merges rapid edits of the same thing into one step", () => {
    const t0 = sampleTimeline();
    const cmd = (s: number) => ({ type: "setDuration" as const, clipId: "c_s1", seconds: s });
    let h = initialHistory(t0);
    h = record(h, applyCommand(h.present, cmd(5.5)), coalesceKey(cmd(5.5)), 0);
    h = record(h, applyCommand(h.present, cmd(6)), coalesceKey(cmd(6)), 300);
    h = record(h, applyCommand(h.present, cmd(6.5)), coalesceKey(cmd(6.5)), 600);
    expect(h.past).toHaveLength(1);
    expect(undo(h).present).toBe(t0);
    // After a pause it's a new step.
    h = record(h, applyCommand(h.present, cmd(7)), coalesceKey(cmd(7)), 3000);
    expect(h.past).toHaveLength(2);
  });

  it("keeps at most 100 steps", () => {
    let h = initialHistory(sampleTimeline());
    for (let i = 0; i < 150; i++)
      h = record(
        h,
        applyCommand(h.present, { type: "setAspect", aspect: i % 2 ? "1:1" : "16:9" }),
        null,
        i,
      );
    expect(h.past).toHaveLength(MAX_HISTORY);
  });
});

describe("drag geometry", () => {
  const extents = [
    { left: 0, width: 100 },
    { left: 104, width: 50 },
    { left: 158, width: 200 },
  ];
  it("drops a clip before the first clip whose middle is right of the pointer", () => {
    expect(dropIndex(10, extents)).toBe(0);
    expect(dropIndex(60, extents)).toBe(1);
    expect(dropIndex(140, extents)).toBe(2);
    expect(dropIndex(900, extents)).toBe(2);
  });
  it("turns a trim drag into a length, snapped and clamped", () => {
    expect(trimmedDuration(5, 40, 20)).toBe(7);
    expect(trimmedDuration(5, -33, 20)).toBe(3.4);
    expect(trimmedDuration(5, -1000, 20)).toBe(0.5);
  });
});
