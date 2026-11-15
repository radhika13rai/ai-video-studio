import { z } from "zod";
import type { TextModel } from "../ai/text-model";
import type { ProductionPlan } from "../agents/director";
import { BRIEF_IS_DATA, runStructured } from "../agents/structured";
import { AgentError, type AgentMeta, type Brief } from "../agents/types";
import { analyzePrompt, cleanPrompt, type PromptAnalysis } from "./ambiguity";

/**
 * Creative interpretation: the one model call of the Creative Director. The model only proposes
 * (subject, audience, characters, style …); everything it returns is schema-validated, cleaned
 * and limited here, and a rule-based interpretation replaces it whenever the model is missing,
 * out of quota or returns invalid output.
 */

const text = (max: number) => z.string().trim().max(max);

export const modelInterpretationSchema = z.object({
  subject: text(160).min(1),
  audience: text(120),
  key_message: text(240),
  call_to_action: text(120).nullable(),
  tone_words: z.array(text(30).min(1)).max(5),
  setting: text(200),
  characters: z
    .array(
      z.object({
        name: text(60).min(1),
        role: text(80).min(1),
        appearance: text(240).min(1),
        wardrobe: text(160),
      }),
    )
    .max(4),
  style_keywords: z.array(text(40).min(1)).max(6),
  must_include: z.array(text(80).min(1)).max(5),
  must_avoid: z.array(text(60).min(1)).max(5),
  language: text(20),
  ambiguities: z.array(text(200).min(1)).max(5),
});
export type ModelInterpretation = z.infer<typeof modelInterpretationSchema>;

export interface Interpretation extends ModelInterpretation {
  source: "model" | "rules";
  analysis: PromptAnalysis;
  /** Why the rules were used instead of the model, when they were. */
  fallback_reason: string | null;
}

const INJECTIONISH =
  /(ignore|disregard)\b.*\b(instructions|rules|prompt)|\bsystem prompt\b|\byou are now\b/i;

/** Removes instruction-like text and names the user never wrote from the model's proposal. */
export function sanitizeInterpretation(
  m: ModelInterpretation,
  brief: Pick<Brief, "title" | "prompt">,
): ModelInterpretation {
  const clean = (s: string) => (INJECTIONISH.test(s) ? "" : cleanPrompt(s));
  const cleanList = (xs: string[]) => xs.map(clean).filter(Boolean);
  const source = `${brief.title} ${brief.prompt}`.toLowerCase();
  return {
    ...m,
    subject: clean(m.subject) || cleanPrompt(brief.title),
    audience: clean(m.audience),
    key_message: clean(m.key_message),
    call_to_action: m.call_to_action ? clean(m.call_to_action) || null : null,
    tone_words: cleanList(m.tone_words),
    setting: clean(m.setting),
    // Full names the user never wrote are invented (and may be real people): use the role.
    characters: m.characters
      .map((c) => {
        const invented = /\s/.test(c.name.trim()) && !source.includes(c.name.toLowerCase());
        return {
          name: invented ? c.role : clean(c.name) || c.role,
          role: clean(c.role) || "character",
          appearance: clean(c.appearance),
          wardrobe: clean(c.wardrobe),
        };
      })
      .filter((c) => c.appearance),
    style_keywords: cleanList(m.style_keywords),
    must_include: cleanList(m.must_include),
    must_avoid: cleanList(m.must_avoid),
    language: clean(m.language) || "en",
    ambiguities: cleanList(m.ambiguities),
  };
}

/** The interpretation used when the model can't help: derived from the brief by rules. */
export function rulesInterpretation(
  brief: Brief,
  plan: ProductionPlan,
  analysis: PromptAnalysis,
): ModelInterpretation {
  const firstSentence = analysis.text.split(/(?<=[.!?])\s/)[0] ?? analysis.text;
  return {
    subject:
      (analysis.vague ? cleanPrompt(brief.title) : firstSentence).slice(0, 160) || "General topic",
    audience: "a general social media audience",
    key_message: firstSentence.slice(0, 240),
    call_to_action: plan.video_type === "advertisement" ? "Find out more" : null,
    tone_words: plan.tone
      .split(/[;,]| and /)
      .map((t) => t.replace(/style:/i, "").trim())
      .filter(Boolean)
      .slice(0, 5),
    setting: "",
    characters: [],
    style_keywords: brief.style ? [brief.style.slice(0, 40)] : [],
    must_include: [],
    must_avoid: [],
    language: analysis.nonEnglish ? "unknown" : "en",
    ambiguities: [],
  };
}

export async function interpretBrief(
  model: TextModel | null,
  brief: Brief,
  plan: ProductionPlan,
): Promise<{ interpretation: Interpretation; meta: AgentMeta }> {
  const analysis = analyzePrompt({
    title: brief.title,
    prompt: brief.prompt,
    style: brief.style,
    duration_seconds: brief.duration_seconds,
    chosenType: plan.video_type,
  });
  const fallback = (reason: string, meta?: Partial<AgentMeta>) => ({
    interpretation: {
      ...rulesInterpretation(brief, plan, analysis),
      source: "rules" as const,
      analysis,
      fallback_reason: reason,
    },
    meta: {
      agent: "creative-director",
      model: "deterministic",
      attempts: 1,
      ...meta,
    } satisfies AgentMeta,
  });
  if (!model) return fallback("No AI model is available.");

  const system = [
    "You are the creative director for short-form social videos.",
    "Read the request and describe what the video should be: its subject, audience, key message,",
    "tone, setting, recurring characters (with concrete, consistent visual appearance and wardrobe),",
    "visual style keywords, things it must include or avoid, and the language of the request.",
    "Invent only fictional characters; never use real people. Keep every field short and concrete.",
    "List anything unclear in the request under ambiguities instead of guessing silently.",
    BRIEF_IS_DATA,
    "Reply with a single JSON object matching the schema.",
  ].join(" ");
  const user = [
    `Title: ${brief.title}`,
    `Request: ${analysis.text || brief.title}`,
    brief.style ? `Requested style: ${brief.style}` : "",
    `Video type: ${plan.video_type}. Length: ${brief.duration_seconds} seconds. Platform: ${brief.target_platform}.`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { value, meta } = await runStructured({
      agent: "creative-director",
      model,
      system,
      user,
      schema: modelInterpretationSchema,
      maxTokens: 900,
    });
    return {
      interpretation: {
        ...sanitizeInterpretation(value, brief),
        source: "model",
        analysis,
        fallback_reason: null,
      },
      meta,
    };
  } catch (err) {
    // Any model failure (quota, outage, invalid output) falls back to rules; the run continues.
    if (err instanceof AgentError) return fallback(err.message, { model: model.name });
    throw err;
  }
}
