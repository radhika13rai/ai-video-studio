import { GRAPHICS_PRESETS, graphicsLayoutSchema, type GraphicsLayout } from "@avs/schemas";
import { describe, expect, it } from "vitest";
import { applyCommand, coalesceKey, tryCommand } from "./commands";
import { sampleTimeline } from "./commands.test";
import { layoutForPreset, rowsToText, SLOTS, textToList, textToRows, withSlot } from "./graphics";

const checklist: GraphicsLayout = {
  preset: "checklist",
  headline: "LOADED",
  rows: ["Discovery questions", "Objection handling"],
};

describe("graphics editor helpers", () => {
  it("switches to every preset with a valid layout that keeps the words", () => {
    for (const p of GRAPHICS_PRESETS) {
      const l = layoutForPreset(checklist, p);
      expect(l.preset).toBe(p);
      expect(graphicsLayoutSchema.safeParse(l).success, p).toBe(true);
    }
    expect(layoutForPreset(checklist, "card_list")).toMatchObject({
      headline: "LOADED",
      rows: [{ title: "Discovery questions" }, { title: "Objection handling" }],
    });
    expect(layoutForPreset(checklist, "chat_objection")).toMatchObject({ message: "LOADED" });
  });

  it("describes a slot for every field of every preset", () => {
    for (const p of GRAPHICS_PRESETS) {
      const sample = layoutForPreset(checklist, p) as Record<string, unknown>;
      const keys = SLOTS[p].map((s) => s.key);
      for (const k of Object.keys(sample))
        if (k !== "preset") expect(keys, `${p}.${k}`).toContain(k);
    }
  });

  it("round-trips rows and lists as text", () => {
    const rows = [{ title: "SPIN Selling", subtitle: "Neil Rackham" }, { title: "Gap Selling" }];
    expect(textToRows(rowsToText(rows))).toEqual(rows);
    expect(textToList(" a \n\n b \n")).toEqual(["a", "b"]);
    expect(
      withSlot({ preset: "headline_papers", headline: "X", caption: "c" }, "caption", ""),
    ).toEqual({
      preset: "headline_papers",
      headline: "X",
    });
  });
});

describe("setGraphics command", () => {
  const t = sampleTimeline();
  const id = t.clips[0]!.id;

  it("sets a clip's layout and refuses one that breaks the limits", () => {
    const next = applyCommand(t, { type: "setGraphics", clipId: id, layout: checklist });
    expect(next.clips[0]!.graphics).toEqual(checklist);
    expect(t.clips[0]!.graphics).toBeUndefined();
    const bad = tryCommand(t, {
      type: "setGraphics",
      clipId: id,
      layout: { ...checklist, rows: [] } as never,
    });
    expect(bad.ok).toBe(false);
  });

  it("merges typing in one preset into one undo step", () => {
    expect(coalesceKey({ type: "setGraphics", clipId: id, layout: checklist })).toBe(
      coalesceKey({ type: "setGraphics", clipId: id, layout: { ...checklist, headline: "DONE" } }),
    );
    expect(coalesceKey({ type: "setGraphics", clipId: id, layout: checklist })).not.toBe(
      coalesceKey({
        type: "setGraphics",
        clipId: id,
        layout: layoutForPreset(checklist, "cta_card"),
      }),
    );
  });
});
