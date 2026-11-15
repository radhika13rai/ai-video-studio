import type { Clip, GraphicsLayout, GraphicsPreset } from "@avs/schemas";
import { useState } from "react";
import type { EditorCommand } from "./commands";
import {
  GRAPHICS_PRESETS,
  layoutForPreset,
  PRESET_LABELS,
  rowsToText,
  SLOTS,
  textToList,
  textToRows,
  withSlot,
  type Slot,
} from "./graphics";

/**
 * The layout of a graphics scene (ADR 048): the preset and its text slots. Each change is one
 * typed command, so it is undoable and autosaved like every other edit.
 */
export function GraphicsEditor({
  clip,
  dispatch,
}: {
  clip: Clip;
  dispatch: (cmd: EditorCommand) => boolean;
}) {
  const layout: GraphicsLayout = clip.graphics ?? {
    preset: "headline_papers",
    headline: (clip.on_screen_text || clip.description || "Headline").slice(0, 40),
  };
  const set = (next: GraphicsLayout) =>
    dispatch({ type: "setGraphics", clipId: clip.id, layout: next });
  const values = layout as Record<string, unknown>;
  return (
    <div className="graphics-editor">
      <h3 className="panel-title">Layout</h3>
      <label className="field">
        <span>Preset</span>
        <select
          aria-label="Layout preset"
          value={layout.preset}
          onChange={(e) => set(layoutForPreset(layout, e.target.value as GraphicsPreset))}
        >
          {GRAPHICS_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      {SLOTS[layout.preset].map((slot) => (
        <SlotField
          key={`${clip.id}:${layout.preset}:${slot.key}`}
          slot={slot}
          value={values[slot.key]}
          onCommit={(v) => set(withSlot(layout, slot.key, v))}
        />
      ))}
    </div>
  );
}

function asText(slot: Slot, value: unknown): string {
  if (slot.kind === "rows")
    return rowsToText((value as { title: string; subtitle?: string }[]) ?? []);
  if (slot.kind === "list") return ((value as string[]) ?? []).join("\n");
  if (slot.kind === "percent") return String(value ?? 0);
  return String(value ?? "");
}

function parse(slot: Slot, text: string): unknown {
  if (slot.kind === "rows") return textToRows(text);
  if (slot.kind === "list") return textToList(text);
  if (slot.kind === "percent") return Math.round(Number(text) || 0);
  return slot.optional && !text.trim() ? "" : text;
}

/**
 * One slot's input. It keeps the text being typed (a trailing newline, an empty field) while
 * the stored layout only changes when the text is valid, and follows the stored layout when it
 * changes from elsewhere (undo, a version restore).
 */
function SlotField({
  slot,
  value,
  onCommit,
}: {
  slot: Slot;
  value: unknown;
  onCommit: (v: unknown) => boolean;
}) {
  const stored = asText(slot, value);
  const [draft, setDraft] = useState(stored);
  const [seen, setSeen] = useState(stored);
  const [refused, setRefused] = useState(false);
  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
  }
  const change = (text: string) => {
    setDraft(text);
    const value = parse(slot, text);
    const saved = onCommit(value);
    setRefused(!saved);
    // What the store now holds came from this draft: don't reset the draft to it.
    if (saved) setSeen(asText(slot, value === "" ? undefined : value));
  };
  const hint =
    slot.kind === "text"
      ? `${draft.length}/${slot.max}${slot.optional ? " · optional" : ""}`
      : slot.kind === "list"
        ? `Up to ${slot.maxItems} lines, ${slot.max} characters each`
        : slot.kind === "rows"
          ? `Up to ${slot.maxItems} lines: Title | subtitle (subtitle optional)`
          : undefined;
  return (
    <label className="field">
      <span>{slot.label}</span>
      {slot.kind === "percent" ? (
        <span className="range">
          <input
            type="range"
            aria-label={slot.label}
            min={0}
            max={100}
            step={1}
            value={Number(draft) || 0}
            onChange={(e) => change(e.target.value)}
          />
          <output>{draft}%</output>
        </span>
      ) : slot.kind === "text" && !slot.multiline ? (
        <input
          aria-label={slot.label}
          value={draft}
          maxLength={slot.max}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <textarea
          aria-label={slot.label}
          rows={slot.kind === "text" ? 2 : 4}
          value={draft}
          maxLength={slot.kind === "text" ? slot.max : undefined}
          onChange={(e) => change(e.target.value)}
        />
      )}
      {hint && (
        <small className={refused ? "bad" : "muted"}>{refused ? `Not saved: ${hint}` : hint}</small>
      )}
    </label>
  );
}
