import {
  fitText,
  GRAPHICS_PRESETS,
  graphicsLayoutSchema,
  type GraphicsLayout,
  type GraphicsPreset,
} from "@avs/schemas";

/** Editor helpers for graphics scenes (ADR 048). Pure, so they are unit-tested. */

export const PRESET_LABELS: Record<GraphicsPreset, string> = {
  hook_headline: "Hook headline",
  card_list: "Card list",
  collect_into_anchor: "Collect into folder",
  headline_papers: "Headline + papers",
  headline_badge: "Headline + badge",
  progress_card: "Progress card",
  checklist: "Checklist",
  chat_objection: "Chat: objection",
  chat_reply: "Chat: reply",
  stacked_cards: "Stacked cards",
  cta_card: "Call to action",
};
export { GRAPHICS_PRESETS };

export type Slot =
  | {
      key: string;
      label: string;
      kind: "text";
      max: number;
      optional?: boolean;
      multiline?: boolean;
    }
  | { key: string; label: string; kind: "list"; max: number; maxItems: number; minItems: number }
  | { key: string; label: string; kind: "rows"; maxItems: number }
  | { key: string; label: string; kind: "percent" };

const HEADLINE = { key: "headline", label: "Headline", kind: "text", max: 40 } as const;
const OPT_HEADLINE = { ...HEADLINE, optional: true } as const;

/** The editable text slots of each preset, with the schema's limits. */
export const SLOTS: Record<GraphicsPreset, Slot[]> = {
  hook_headline: [
    { key: "pill", label: "Pill", kind: "text", max: 24, optional: true },
    HEADLINE,
    {
      key: "items",
      label: "Floating items (one per line)",
      kind: "list",
      max: 18,
      maxItems: 6,
      minItems: 0,
    },
  ],
  card_list: [OPT_HEADLINE, { key: "rows", label: "Rows", kind: "rows", maxItems: 6 }],
  collect_into_anchor: [
    OPT_HEADLINE,
    {
      key: "cards",
      label: "Cards (one per line)",
      kind: "list",
      max: 20,
      maxItems: 6,
      minItems: 1,
    },
  ],
  headline_papers: [
    HEADLINE,
    { key: "caption", label: "Caption", kind: "text", max: 40, optional: true },
  ],
  headline_badge: [HEADLINE, { key: "badge", label: "Badge", kind: "text", max: 20 }],
  progress_card: [
    OPT_HEADLINE,
    { key: "label", label: "Label", kind: "text", max: 28 },
    { key: "percent", label: "Progress", kind: "percent" },
  ],
  checklist: [
    HEADLINE,
    {
      key: "rows",
      label: "Checklist items (one per line)",
      kind: "list",
      max: 28,
      maxItems: 6,
      minItems: 1,
    },
  ],
  chat_objection: [
    { key: "message", label: "Message", kind: "text", max: 60, multiline: true },
    { key: "label", label: "Red label", kind: "text", max: 24 },
  ],
  chat_reply: [
    { key: "reply", label: "Reply", kind: "text", max: 120, multiline: true },
    { key: "tags", label: "Tags (one per line)", kind: "list", max: 18, maxItems: 2, minItems: 0 },
  ],
  stacked_cards: [OPT_HEADLINE, { key: "cards", label: "Cards", kind: "rows", maxItems: 5 }],
  cta_card: [
    HEADLINE,
    { key: "handle", label: "Handle", kind: "text", max: 30 },
    { key: "button", label: "Button", kind: "text", max: 18 },
    { key: "line", label: "Line under the button", kind: "text", max: 48 },
  ],
};

type Row = { title: string; subtitle?: string };

/** Rows as editable text: "Title | subtitle", one per line. */
export function rowsToText(rows: Row[]): string {
  return rows.map((r) => (r.subtitle ? `${r.title} | ${r.subtitle}` : r.title)).join("\n");
}
export function textToRows(text: string): Row[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [title = "", ...rest] = l.split("|");
      const subtitle = rest.join("|").trim();
      return subtitle ? { title: title.trim(), subtitle } : { title: title.trim() };
    });
}
export const textToList = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Every short text in a layout, headline first (to carry over when the preset changes). */
function textsOf(l: GraphicsLayout): { headline: string; items: string[] } {
  const v = l as Record<string, unknown>;
  const headline = String(v.headline ?? v.message ?? v.reply ?? v.label ?? "").trim();
  const list = (v.items ?? v.rows ?? v.cards ?? v.tags ?? []) as (string | Row)[];
  const items = list.map((x) => (typeof x === "string" ? x : x.title));
  return { headline, items };
}

/**
 * A valid layout of `preset` that keeps the current layout's words where they fit: the
 * headline stays the headline and list items stay list items.
 */
export function layoutForPreset(from: GraphicsLayout, preset: GraphicsPreset): GraphicsLayout {
  const { headline: h, items: raw } = textsOf(from);
  const head = fitText(h || "Headline", 40);
  const items = raw.length ? raw : ["First point", "Second point"];
  const list = (max: number, n: number) => items.slice(0, n).map((x) => fitText(x, max));
  const rows = (n: number) => items.slice(0, n).map((x) => ({ title: fitText(x, 28) }));
  const candidates: Record<GraphicsPreset, GraphicsLayout> = {
    hook_headline: { preset, headline: head, items: list(18, 6) } as GraphicsLayout,
    card_list: { preset, headline: head, rows: rows(6) } as GraphicsLayout,
    collect_into_anchor: { preset, headline: head, cards: list(20, 6) } as GraphicsLayout,
    headline_papers: { preset, headline: head } as GraphicsLayout,
    headline_badge: {
      preset,
      headline: head,
      badge: fitText(items[0] ?? "New", 20),
    } as GraphicsLayout,
    progress_card: {
      preset,
      headline: head,
      label: fitText(items[0] ?? head, 28),
      percent: 100,
    } as GraphicsLayout,
    checklist: { preset, headline: head, rows: list(28, 6) } as GraphicsLayout,
    chat_objection: {
      preset,
      message: fitText(h || "That's too expensive", 60),
      label: "OBJECTION",
    } as GraphicsLayout,
    chat_reply: {
      preset,
      reply: fitText(h || "Compared to what?", 120),
      tags: list(18, 2),
    } as GraphicsLayout,
    stacked_cards: { preset, headline: head, cards: rows(5) } as GraphicsLayout,
    cta_card: {
      preset,
      headline: head,
      handle: "@yourhandle",
      button: "Follow",
      line: "Comment and I'll send you the script",
    } as GraphicsLayout,
  };
  const out = graphicsLayoutSchema.safeParse(candidates[preset]);
  return out.success ? out.data : (candidates[preset] as GraphicsLayout);
}

/** Sets one slot; empty optional text removes the key. Not validated here (the command is). */
export function withSlot(l: GraphicsLayout, key: string, value: unknown): GraphicsLayout {
  const next = { ...(l as Record<string, unknown>) };
  if (value === "" || value === undefined) delete next[key];
  else next[key] = value;
  return next as GraphicsLayout;
}
