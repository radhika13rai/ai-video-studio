import { z } from "zod";

/**
 * Motion-graphics scenes (ADR 048). A graphics scene draws no picture: it is one of a small
 * library of deterministic layout presets, laid out and animated in code by the renderer. The AI
 * only picks a preset and fills its text slots, so every slot here is size-capped: text that
 * fits the cap fits the frame.
 */

export const GRAPHICS_PRESETS = [
  "hook_headline",
  "card_list",
  "collect_into_anchor",
  "headline_papers",
  "headline_badge",
  "progress_card",
  "checklist",
  "chat_objection",
  "chat_reply",
  "stacked_cards",
  "cta_card",
] as const;
export type GraphicsPreset = (typeof GRAPHICS_PRESETS)[number];

/** Stored layouts larger than this are refused by the API. */
export const MAX_GRAPHICS_LAYOUT_BYTES = 8 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const headline = text(40);
const row = z.object({ title: text(28), subtitle: text(40).optional() });

export const graphicsLayoutSchema = z.discriminatedUnion("preset", [
  z.object({
    preset: z.literal("hook_headline"),
    pill: text(24).optional(),
    headline,
    items: z.array(text(18)).max(6),
  }),
  z.object({
    preset: z.literal("card_list"),
    headline: headline.optional(),
    rows: z.array(row).min(1).max(6),
  }),
  z.object({
    preset: z.literal("collect_into_anchor"),
    headline: headline.optional(),
    cards: z.array(text(20)).min(1).max(6),
  }),
  z.object({
    preset: z.literal("headline_papers"),
    headline,
    caption: text(40).optional(),
  }),
  z.object({
    preset: z.literal("headline_badge"),
    headline,
    badge: text(20),
  }),
  z.object({
    preset: z.literal("progress_card"),
    headline: headline.optional(),
    label: text(28),
    percent: z.number().int().min(0).max(100),
  }),
  z.object({
    preset: z.literal("checklist"),
    headline,
    rows: z.array(text(28)).min(1).max(6),
  }),
  z.object({
    preset: z.literal("chat_objection"),
    message: text(60),
    label: text(24),
  }),
  z.object({
    preset: z.literal("chat_reply"),
    reply: text(120),
    tags: z.array(text(18)).max(2),
  }),
  z.object({
    preset: z.literal("stacked_cards"),
    headline: headline.optional(),
    cards: z.array(row).min(1).max(5),
  }),
  z.object({
    preset: z.literal("cta_card"),
    headline,
    handle: text(30),
    button: text(18),
    line: text(48),
  }),
]);
export type GraphicsLayout = z.infer<typeof graphicsLayoutSchema>;

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "colours are #RRGGBB");

/** The project's persistent look: palette, the anchor object and the mascot (ADR 048). */
export const graphicsThemeSchema = z.object({
  palette: z.object({
    background: hex,
    accent: hex,
    accent_dark: hex,
    highlight: hex,
  }),
  anchor: z.enum(["folder", "none"]),
  mascot: z.boolean(),
});
export type GraphicsTheme = z.infer<typeof graphicsThemeSchema>;

export const DEFAULT_GRAPHICS_THEME: GraphicsTheme = {
  palette: {
    background: "#F3F4F6",
    accent: "#FF7A1A",
    accent_dark: "#C9500A",
    highlight: "#2F6BFF",
  },
  anchor: "folder",
  mascot: true,
};

/**
 * Words in a brief that ask for motion graphics (ADR 048): such projects get graphics scenes,
 * drawn free in the browser, instead of AI pictures. Shared by the director and the new-video
 * form (which shows that the look is free).
 */
export const MOTION_GRAPHICS_PATTERN =
  /\bmotion[- ]?graphics?\b|\bmotion design\b|\banimated (?:software |product |saas )?explainer\b|\bkinetic typography\b|\bexplainer animation\b|\bexplainer[- ]style\b|\bvox\b|\binfographics?\b|\bflat (?:2d |vector )?(?:motion|graphics|animation|design|illustration)/;

export function mentionsMotionGraphics(text: string): boolean {
  return MOTION_GRAPHICS_PATTERN.test(text.toLowerCase());
}

/* ------------------------------ deterministic fallback ------------------------------ */

export interface GraphicsFallbackInput {
  /** The scene's position (0-based) and the number of scenes. */
  index: number;
  count: number;
  /** The blueprint beat's name, e.g. "Hook", "Problem", "Call to action" (may be empty). */
  beat: string;
  narration: string;
  on_screen_text: string | null;
}

/** Cuts text to at most `max` characters on a word boundary (never empty for non-empty input). */
export function fitText(input: string, max: number): string {
  const t = input.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.5 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:.-]+$/, "");
}

/** Short phrases from narration: split on sentence and comma breaks, then trimmed to `max`. */
function phrases(text: string, max: number, limit: number): string[] {
  const parts = text
    .split(/[.!?;,:\n]+|\s[-–—]\s/)
    .map((p) => fitText(p, max))
    .filter((p) => p.length >= 2);
  return [...new Set(parts)].slice(0, limit);
}

function headlineOf(input: GraphicsFallbackInput): string {
  const src = input.on_screen_text?.trim() || phrases(input.narration, 40, 1)[0] || "Watch this";
  return fitText(src, 40).toUpperCase();
}

type BeatKind = "hook" | "problem" | "list" | "proof" | "objection" | "cta" | "body";

/** Classifies a beat name (falling back to the scene's position). */
export function beatKind(input: Pick<GraphicsFallbackInput, "beat" | "index" | "count">): BeatKind {
  const b = input.beat.toLowerCase();
  if (/hook|intro|open/.test(b)) return "hook";
  if (/cta|call to action|outro|close|follow|subscribe/.test(b)) return "cta";
  if (/object|doubt|but\b|pushback/.test(b)) return "objection";
  if (/proof|result|benefit|payoff|outcome/.test(b)) return "proof";
  if (/step|list|tip|point|how|feature/.test(b)) return "list";
  if (/problem|pain|setup|context|why/.test(b)) return "problem";
  if (input.index === 0) return "hook";
  if (input.index === input.count - 1) return "cta";
  return "body";
}

/**
 * A valid layout from the scene's own text, without AI: hook → hook_headline, CTA → cta_card,
 * lists → checklist / card_list, and so on. Used when the model is off or returns junk.
 */
export function fallbackGraphicsLayout(input: GraphicsFallbackInput): GraphicsLayout {
  const kind = beatKind(input);
  const head = headlineOf(input);
  const bits = phrases(input.narration, 28, 6);
  const rows = bits.length ? bits : [fitText(input.narration || head, 28) || "Key point"];
  switch (kind) {
    case "hook":
      return { preset: "hook_headline", headline: head, items: phrases(input.narration, 18, 4) };
    case "cta":
      return {
        preset: "cta_card",
        headline: head,
        handle: "@yourhandle",
        button: "Follow",
        line: "Comment and I'll send you the script",
      };
    case "objection":
      return {
        preset: "chat_objection",
        message: fitText(input.on_screen_text || input.narration || head, 60) || head,
        label: "OBJECTION",
      };
    case "proof":
      return { preset: "checklist", headline: head, rows: rows.slice(0, 4) };
    case "list":
      return {
        preset: "card_list",
        headline: head,
        rows: rows.slice(0, 4).map((title) => ({ title })),
      };
    case "problem":
      return { preset: "headline_badge", headline: head, badge: fitText(rows[0] ?? head, 20) };
    default:
      return input.index % 2
        ? {
            preset: "stacked_cards",
            headline: head,
            cards: rows.slice(0, 3).map((title) => ({ title })),
          }
        : { preset: "headline_papers", headline: head };
  }
}
