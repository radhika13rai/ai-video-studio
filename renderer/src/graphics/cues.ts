import type { GraphicsLayout } from "@avs/schemas";
import { EXIT_FRAMES } from "./springs";

/**
 * When each element of a graphics scene enters (ADR 048). The painter animates from these
 * frames and the audio mixer places a sound on each one, so every sound lands on its animation.
 * Pure: the same layout and length always give the same cues.
 */

export type GraphicsSfx = "click" | "tick" | "confirm" | "impact" | "pop" | "whoosh";

export interface GraphicsCue {
  /** Element key, e.g. "headline", "row:2", "check:0". */
  key: string;
  /** Frame (from the scene start) at which the element starts entering. */
  frame: number;
  /** The sound on this cue, if any, and its level. */
  sfx?: GraphicsSfx;
  gainDb?: number;
}

type Raw = { key: string; at: number; sfx?: GraphicsSfx; gainDb?: number };

function rawCues(l: GraphicsLayout): Raw[] {
  const out: Raw[] = [];
  const push = (key: string, at: number, sfx?: GraphicsSfx, gainDb?: number) =>
    out.push({ key, at, ...(sfx ? { sfx } : {}), ...(gainDb !== undefined ? { gainDb } : {}) });
  const headline = (at = 3) => push("headline", at, "impact");
  switch (l.preset) {
    case "hook_headline": {
      if (l.pill) push("pill", 2, "click");
      headline(l.pill ? 8 : 3);
      l.items.forEach((_, i) => push(`item:${i}`, 20 + 5 * i, "pop", -4));
      break;
    }
    case "card_list": {
      let at = 3;
      if (l.headline) {
        headline(at);
        at = 14;
      }
      l.rows.forEach((_, i) => push(`row:${i}`, at + 7 * i, "click"));
      break;
    }
    case "collect_into_anchor": {
      let at = 3;
      if (l.headline) {
        headline(at);
        at = 12;
      }
      l.cards.forEach((_, i) => push(`card:${i}`, at + 5 * i, "pop", -3));
      const lines = at + 5 * l.cards.length + 4;
      push("lines", lines, "whoosh", -6);
      push("collect", lines + 20, "confirm");
      push("ripple", lines + 26, "impact", -4);
      break;
    }
    case "headline_papers": {
      headline();
      for (let i = 0; i < 4; i++) push(`paper:${i}`, 14 + 4 * i, "tick", -2);
      if (l.caption) push("caption", 34, "click", -4);
      break;
    }
    case "headline_badge": {
      headline();
      push("diamond", 15, "confirm");
      push("badge", 22, "pop");
      break;
    }
    case "progress_card": {
      let at = 3;
      if (l.headline) {
        headline(at);
        at = 12;
      }
      push("card", at, "click");
      push("bar", at + 6, "tick", -4);
      push("done", at + 40, "confirm");
      break;
    }
    case "checklist": {
      headline();
      l.rows.forEach((_, i) => push(`row:${i}`, 13 + 4 * i, "click", -4));
      const first = 13 + 4 * l.rows.length + 6;
      l.rows.forEach((_, i) => push(`check:${i}`, first + 8 * i, "confirm"));
      break;
    }
    case "chat_objection": {
      push("message", 3, "pop");
      push("label", 14, "impact");
      push("typing", 26, "click", -4);
      break;
    }
    case "chat_reply": {
      push("reply", 3, "pop");
      push("typing", 9, "tick", -4);
      const typed = 9 + Math.ceil(l.reply.length * 0.6);
      l.tags.forEach((_, i) => push(`tag:${i}`, typed + 4 + 6 * i, "pop", -2));
      break;
    }
    case "stacked_cards": {
      let at = 3;
      if (l.headline) {
        headline(at);
        at = 12;
      }
      push("spine", at, "whoosh", -6);
      l.cards.forEach((_, i) => push(`card:${i}`, at + 6 + 7 * i, "click"));
      break;
    }
    case "cta_card": {
      headline();
      push("card", 12, "pop");
      push("handle", 17);
      push("button", 22, "click");
      push("line", 28);
      push("arrow", 34, "whoosh", -6);
      break;
    }
  }
  return out;
}

/**
 * Entrance frames for every element of `layout` in a scene `durationFrames` long. A short scene
 * compresses the schedule so every element has fully entered before the exit fade; a long scene
 * keeps the natural pace (the elements then hold).
 */
export function cues(layout: GraphicsLayout, durationFrames: number): GraphicsCue[] {
  const raw = rawCues(layout);
  const last = Math.max(1, ...raw.map((r) => r.at));
  // Leave room for the last element to settle (≈10 frames) before the fade-out.
  const budget = Math.max(0, durationFrames - EXIT_FRAMES - 10);
  const k = Math.min(1, budget / last);
  return raw.map((r) => ({
    key: r.key,
    frame: Math.max(0, Math.min(durationFrames - 1, Math.round(r.at * k))),
    ...(r.sfx ? { sfx: r.sfx } : {}),
    ...(r.gainDb !== undefined ? { gainDb: r.gainDb } : {}),
  }));
}

/** The frame a keyed element enters at (or `fallback` if the layout has no such element). */
export function cueFrame(list: GraphicsCue[], key: string, fallback = 0): number {
  return list.find((c) => c.key === key)?.frame ?? fallback;
}
