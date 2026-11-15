import type { GraphicsLayout, RenderManifest } from "@avs/schemas";

/**
 * A 12-scene motion-graphics explainer mirroring the "Close Deals on Autopilot" Reel (ADR 048),
 * used by the renderer tests and the browser fixture render (scripts/graphics-fixture.mjs).
 * Silent and without music, so every sound in its mix is a graphics cue.
 */
const LAYOUTS: GraphicsLayout[] = [
  {
    preset: "hook_headline",
    pill: "Claude Code",
    headline: "Close deals on autopilot",
    items: [
      "SPIN Selling",
      "Gap Selling",
      "Challenger Sale",
      "Never Split",
      "To Sell Is Human",
      "Pitch Anything",
    ],
  },
  {
    preset: "card_list",
    headline: "6 sales classics",
    rows: [
      { title: "SPIN Selling", subtitle: "Neil Rackham" },
      { title: "Gap Selling", subtitle: "Keenan" },
      { title: "The Challenger Sale", subtitle: "Dixon & Adamson" },
      { title: "Never Split the Difference", subtitle: "Chris Voss" },
      { title: "To Sell Is Human", subtitle: "Daniel Pink" },
      { title: "Pitch Anything", subtitle: "Oren Klaff" },
    ],
  },
  {
    preset: "collect_into_anchor",
    headline: "One folder",
    cards: [
      "SPIN Selling",
      "Gap Selling",
      "Challenger",
      "Never Split",
      "Sell Is Human",
      "Pitch Anything",
    ],
  },
  { preset: "headline_papers", headline: "Key points", caption: "Pulled from every book" },
  { preset: "headline_badge", headline: "Omni expert", badge: "Trained on 6 books" },
  { preset: "progress_card", headline: "Loading", label: "Loading sales knowledge", percent: 100 },
  {
    preset: "card_list",
    headline: "Sources",
    rows: [
      { title: "Discovery calls", subtitle: "SPIN + Gap Selling" },
      { title: "Negotiation", subtitle: "Never Split the Difference" },
      { title: "Framing", subtitle: "Pitch Anything" },
      { title: "Teaching", subtitle: "The Challenger Sale" },
    ],
  },
  {
    preset: "checklist",
    headline: "Loaded",
    rows: ["Discovery questions", "Objection handling", "Pricing talks", "Follow-up scripts"],
  },
  {
    preset: "chat_objection",
    message: "This is too expensive for us right now.",
    label: "Too expensive",
  },
  {
    preset: "chat_reply",
    reply: "Totally fair. Compared to what? What is it costing you to keep losing these deals?",
    tags: ["Gap Selling", "Reframe"],
  },
  {
    preset: "stacked_cards",
    headline: "5 principles",
    cards: [
      { title: "Diagnose, then prescribe" },
      { title: "Find the gap", subtitle: "Current state vs future state" },
      { title: "Label the emotion" },
      { title: "Teach, tailor, take control" },
      { title: "Frame the price last" },
    ],
  },
  {
    preset: "cta_card",
    headline: "Want the script?",
    handle: "@closewithai",
    button: "Follow",
    line: "Comment SCRIPT and I'll send you the script",
  },
];

/** Scene lengths (seconds): 34.8 s in all, like the 34.77 s Reel. */
const DURATIONS = [3.2, 3.0, 3.6, 2.6, 2.6, 2.8, 2.8, 3.2, 2.6, 3.0, 3.0, 2.4];

export function closeDealsManifest(): RenderManifest {
  let start = 0;
  const scenes = LAYOUTS.map((graphics, i) => {
    const duration = DURATIONS[i] ?? 3;
    const s = {
      scene_number: i + 1,
      start_seconds: Math.round(start * 1000) / 1000,
      duration_seconds: duration,
      visual_type: "graphics" as const,
      caption: "headline" in graphics && graphics.headline ? graphics.headline : graphics.preset,
      narration: null,
      image_url: null,
      voice_url: null,
      graphics,
    };
    start += duration;
    return s;
  });
  return {
    render_request_id: "graphics-fixture",
    render_attempt_token: "fixture",
    project: {
      id: "fixture",
      title: "Close deals on autopilot",
      aspect_ratio: "9:16",
      duration_seconds: Math.round(start * 1000) / 1000,
    },
    scenes,
    fallbacks: [],
    audio: { music: false, music_gain_db: 0, duck_under_voice: true, transition_sfx: true },
  };
}
