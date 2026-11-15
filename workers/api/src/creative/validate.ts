import {
  productionBlueprintSchema,
  type BlueprintIssue,
  type ProductionBlueprint,
} from "./blueprint";

/**
 * Deterministic checks and repairs on a composed blueprint. Every repair is recorded as an
 * issue; problems that can't be repaired are warnings. The result always satisfies the schema,
 * or validateBlueprint throws (a bug, never a model problem).
 */

/** Spoken words per second above which narration sounds rushed. */
export const MAX_WORDS_PER_SECOND = 3.2;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function validateBlueprint(input: ProductionBlueprint): ProductionBlueprint {
  const bp: ProductionBlueprint = structuredClone(input);
  const issues: BlueprintIssue[] = [...bp.issues];
  const repaired = (code: string, detail: string) =>
    issues.push({ code, severity: "repaired", detail });
  const warn = (code: string, detail: string) => issues.push({ code, severity: "warning", detail });

  // 1. Scene durations add up to the video's length (within 0.2 s).
  const total = bp.scenes.reduce((n, s) => n + s.duration_seconds, 0);
  if (Math.abs(total - bp.duration_seconds) > 0.2 && total > 0) {
    const k = bp.duration_seconds / total;
    bp.scenes.forEach(
      (s) => (s.duration_seconds = Math.max(0.5, Math.round(s.duration_seconds * k * 10) / 10)),
    );
    repaired(
      "durations_scaled",
      `Scene lengths added up to ${total.toFixed(1)} s; scaled to ${bp.duration_seconds} s.`,
    );
  }

  // 2. Beats are contiguous and cover the whole video.
  const beats = bp.narrative.beats;
  let beatFix = false;
  beats.forEach((b, i) => {
    const start = i === 0 ? 0 : beats[i - 1]!.end_s;
    const end = i === beats.length - 1 ? bp.duration_seconds : Math.max(b.end_s, start + 0.1);
    if (b.start_s !== start || b.end_s !== end) beatFix = true;
    b.start_s = start;
    b.end_s = Math.round(end * 10) / 10;
  });
  if (beatFix) repaired("beats_aligned", "Story beats were realigned to cover the whole video.");

  // 3. Scene → beat and character references resolve.
  const beatIds = new Set(beats.map((b) => b.id));
  const charIds = new Set(bp.characters.map((c) => c.id));
  let at = 0;
  for (const s of bp.scenes) {
    const mid = at + s.duration_seconds / 2;
    at += s.duration_seconds;
    if (!beatIds.has(s.beat_id)) {
      s.beat_id = (
        beats.find((b) => mid >= b.start_s && mid < b.end_s) ?? beats[beats.length - 1]!
      ).id;
      repaired("beat_reassigned", `Scene ${s.scene_number} pointed at an unknown beat.`);
    }
    const unknown = s.characters.filter((c) => !charIds.has(c));
    if (unknown.length) {
      s.characters = s.characters.filter((c) => charIds.has(c));
      repaired("character_dropped", `Scene ${s.scene_number} referenced unknown characters.`);
    }
    if (s.narration && s.narration.speaker !== "narrator" && !charIds.has(s.narration.speaker)) {
      s.narration.speaker = "narrator";
      repaired(
        "speaker_reset",
        `Scene ${s.scene_number}'s speaker is unknown; the narrator speaks.`,
      );
    }
    s.dialogue = s.dialogue.filter((d) => charIds.has(d.speaker));
  }

  // 4. Transitions: the first scene cuts in; never the same transition twice in a row.
  bp.scenes.forEach((s, i) => {
    if (i === 0 && s.transition_in !== "cut") {
      s.transition_in = "cut";
      repaired("first_cut", "The video opens with a cut.");
    }
    const prev = bp.scenes[i - 1];
    if (i > 1 && prev && s.transition_in === prev.transition_in && s.transition_in !== "cut") {
      s.transition_in = s.transition_in === "crossfade" ? "zoom" : "crossfade";
      repaired("transition_varied", `Scene ${s.scene_number} repeated the previous transition.`);
    }
  });

  // 5. Narration fits each scene; visual prompts fit the provider limit.
  for (const s of bp.scenes) {
    const spoken =
      words(s.narration?.text ?? "") + s.dialogue.reduce((n, d) => n + words(d.text), 0);
    if (spoken > 0 && spoken / s.duration_seconds > MAX_WORDS_PER_SECOND)
      warn(
        "narration_dense",
        `Scene ${s.scene_number} has ${spoken} words in ${s.duration_seconds} s; the scene will be lengthened to fit the voice.`,
      );
    if (s.visual_type !== "text" && !s.visual_prompt.trim())
      warn(
        "no_visual_prompt",
        `Scene ${s.scene_number} has no visual prompt; it renders as a text card.`,
      );
    if (s.visual_prompt.length > 1000) {
      s.visual_prompt = s.visual_prompt.slice(0, 1000);
      repaired("prompt_trimmed", `Scene ${s.scene_number}'s visual prompt was shortened.`);
    }
  }

  bp.issues = issues.slice(0, 60);
  bp.music.energy_curve = bp.music.energy_curve.slice(0, beats.length);
  return productionBlueprintSchema.parse(bp);
}
