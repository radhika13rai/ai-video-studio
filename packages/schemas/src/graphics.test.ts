import { describe, expect, it } from "vitest";
import {
  beatKind,
  DEFAULT_GRAPHICS_THEME,
  fallbackGraphicsLayout,
  fitText,
  GRAPHICS_PRESETS,
  graphicsLayoutSchema,
  graphicsThemeSchema,
  type GraphicsLayout,
} from "./graphics";
import { renderManifestSchema } from "./index";

/** One valid layout per preset (also used as the "too big" base). */
const SAMPLE_LAYOUTS: Record<(typeof GRAPHICS_PRESETS)[number], GraphicsLayout> = {
  hook_headline: {
    preset: "hook_headline",
    pill: "Claude Code",
    headline: "CLOSE DEALS ON AUTOPILOT",
    items: ["SPIN Selling", "Gap Selling"],
  },
  card_list: { preset: "card_list", rows: [{ title: "SPIN Selling", subtitle: "Neil Rackham" }] },
  collect_into_anchor: { preset: "collect_into_anchor", cards: ["Book one", "Book two"] },
  headline_papers: { preset: "headline_papers", headline: "KEY POINTS" },
  headline_badge: { preset: "headline_badge", headline: "OMNI EXPERT", badge: "6 books" },
  progress_card: { preset: "progress_card", label: "Loading knowledge", percent: 72 },
  checklist: { preset: "checklist", headline: "LOADED", rows: ["Objections", "Pricing"] },
  chat_objection: { preset: "chat_objection", message: "Too expensive", label: "OBJECTION" },
  chat_reply: { preset: "chat_reply", reply: "Compared to what?", tags: ["Gap Selling"] },
  stacked_cards: { preset: "stacked_cards", cards: [{ title: "Listen first" }] },
  cta_card: {
    preset: "cta_card",
    headline: "WANT IT?",
    handle: "@sales.ai",
    button: "Follow",
    line: "Comment SCRIPT and I'll send it",
  },
};

describe("graphicsLayoutSchema", () => {
  it.each(GRAPHICS_PRESETS)("accepts a valid %s layout", (preset) => {
    expect(graphicsLayoutSchema.parse(SAMPLE_LAYOUTS[preset])).toEqual(SAMPLE_LAYOUTS[preset]);
  });

  it("rejects oversize text in every preset", () => {
    const long = "x".repeat(200);
    const bad: unknown[] = [
      { ...SAMPLE_LAYOUTS.hook_headline, headline: long },
      { ...SAMPLE_LAYOUTS.hook_headline, items: [long] },
      { ...SAMPLE_LAYOUTS.card_list, rows: [{ title: long }] },
      { ...SAMPLE_LAYOUTS.collect_into_anchor, cards: [long] },
      { ...SAMPLE_LAYOUTS.headline_papers, headline: long },
      { ...SAMPLE_LAYOUTS.headline_badge, badge: long },
      { ...SAMPLE_LAYOUTS.progress_card, label: long },
      { ...SAMPLE_LAYOUTS.checklist, rows: [long] },
      { ...SAMPLE_LAYOUTS.chat_objection, message: long },
      { ...SAMPLE_LAYOUTS.chat_reply, reply: long },
      { ...SAMPLE_LAYOUTS.stacked_cards, cards: [{ title: "ok", subtitle: long }] },
      { ...SAMPLE_LAYOUTS.cta_card, line: long },
    ];
    for (const b of bad)
      expect(graphicsLayoutSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("rejects too many items and empty lists", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `Item ${i}`);
    const bad: unknown[] = [
      { ...SAMPLE_LAYOUTS.hook_headline, items: seven },
      { ...SAMPLE_LAYOUTS.card_list, rows: seven.map((title) => ({ title })) },
      { ...SAMPLE_LAYOUTS.collect_into_anchor, cards: seven },
      { ...SAMPLE_LAYOUTS.checklist, rows: seven },
      { ...SAMPLE_LAYOUTS.checklist, rows: [] },
      { ...SAMPLE_LAYOUTS.chat_reply, tags: ["a", "b", "c"] },
      { ...SAMPLE_LAYOUTS.stacked_cards, cards: seven.slice(0, 6).map((title) => ({ title })) },
      { ...SAMPLE_LAYOUTS.progress_card, percent: 140 },
      { preset: "nope", headline: "x" },
    ];
    for (const b of bad)
      expect(graphicsLayoutSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("validates the theme", () => {
    expect(graphicsThemeSchema.parse(DEFAULT_GRAPHICS_THEME)).toEqual(DEFAULT_GRAPHICS_THEME);
    expect(
      graphicsThemeSchema.safeParse({
        ...DEFAULT_GRAPHICS_THEME,
        palette: { ...DEFAULT_GRAPHICS_THEME.palette, accent: "orange" },
      }).success,
    ).toBe(false);
  });
});

describe("manifest", () => {
  const base = {
    render_request_id: "r",
    render_attempt_token: "t",
    project: { id: "p", title: "T", aspect_ratio: "9:16", duration_seconds: 4 },
    scenes: [
      {
        scene_number: 1,
        start_seconds: 0,
        duration_seconds: 4,
        visual_type: "image",
        caption: "c",
        image_url: null,
        voice_url: null,
      },
    ],
    fallbacks: [],
  };
  it("still parses an old manifest without graphics, unchanged", () => {
    expect(renderManifestSchema.parse(base)).toEqual(base);
  });
  it("carries a graphics scene and the theme", () => {
    const m = {
      ...base,
      graphics_theme: DEFAULT_GRAPHICS_THEME,
      scenes: [{ ...base.scenes[0], visual_type: "graphics", graphics: SAMPLE_LAYOUTS.checklist }],
    };
    expect(renderManifestSchema.parse(m)).toEqual(m);
  });
});

describe("fallbackGraphicsLayout", () => {
  const beats = ["Hook", "Problem", "Steps", "Proof", "Objection", "Call to action", "Middle", ""];
  it.each(beats)("maps beat %j to a valid preset", (beat) => {
    for (const [index, count] of [
      [0, 6],
      [2, 6],
      [3, 6],
      [5, 6],
    ] as const) {
      const layout = fallbackGraphicsLayout({
        index,
        count,
        beat,
        narration:
          "Six sales books, loaded into one assistant. It handles objections, pricing and follow-ups for you, every single time!",
        on_screen_text: null,
      });
      expect(graphicsLayoutSchema.safeParse(layout).success, `${beat}/${index}`).toBe(true);
    }
  });

  it("maps the main beats to their presets", () => {
    const at = (beat: string, index = 2) =>
      fallbackGraphicsLayout({
        index,
        count: 6,
        beat,
        narration: "One. Two. Three.",
        on_screen_text: "Hi",
      }).preset;
    expect(at("Hook")).toBe("hook_headline");
    expect(at("Call to action")).toBe("cta_card");
    expect(at("Objection")).toBe("chat_objection");
    expect(at("Proof")).toBe("checklist");
    expect(at("Steps")).toBe("card_list");
    expect(at("", 0)).toBe("hook_headline");
    expect(at("", 5)).toBe("cta_card");
  });

  it("stays valid with empty and huge text", () => {
    for (const narration of ["", "a".repeat(5000), "!!! ... ,,,"]) {
      for (const beat of beats) {
        const layout = fallbackGraphicsLayout({
          index: 1,
          count: 3,
          beat,
          narration,
          on_screen_text: null,
        });
        expect(
          graphicsLayoutSchema.safeParse(layout).success,
          `${beat}:${narration.slice(0, 10)}`,
        ).toBe(true);
      }
    }
  });

  it("fits text on word boundaries", () => {
    expect(fitText("close deals on autopilot today", 20)).toBe("close deals on");
    expect(fitText("short", 20)).toBe("short");
    expect(beatKind({ beat: "Intro", index: 3, count: 6 })).toBe("hook");
  });
});
