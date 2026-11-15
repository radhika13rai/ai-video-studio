import type { ConcreteVideoType } from "../agents/director";
import { scoreTypes } from "../agents/director";
import type { BlueprintIssue } from "./blueprint";

/**
 * Deterministic checks on the user's request, run before and after the model: normalise junk,
 * spot instruction-injection attempts, vague or conflicting requests and content that can't fit
 * the duration. Nothing here rejects a prompt; it records assumptions the user can see.
 */

export interface PromptAnalysis {
  /** The prompt as plain text: markup, code and control characters removed. */
  text: string;
  meaningfulWords: number;
  vague: boolean;
  injection: boolean;
  /** Probably not English (mostly non-Latin letters). */
  nonEnglish: boolean;
  /** Numbered list size requested, e.g. "10 tips" → 10. */
  requestedItems: number | null;
  /** Other video types the wording also suggests (the chosen type is excluded). */
  conflictingTypes: ConcreteVideoType[];
  assumptions: string[];
  issues: BlueprintIssue[];
}

const STOPWORDS = new Set(
  (
    "a an the and or but of to in on for with about make create video videos something some " +
    "cool nice good great please me my i we you it this that thing stuff short reel clip one " +
    "is are be do can want need just"
  ).split(" "),
);

const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /disregard (all |any |the )?(previous|prior|above) /i,
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /\b(reveal|print|show) (your|the) (instructions|prompt|rules)\b/i,
  /\brespond (only )?with\b.*\b(json|code|text)\b/i,
];

/** Strips markup, code fences, JSON-looking blobs, URLs and control characters. */
export function cleanPrompt(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[{}[\]"]+/g, " ")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

export function analyzePrompt(input: {
  title: string;
  prompt: string;
  style?: string | null | undefined;
  duration_seconds: number;
  chosenType: ConcreteVideoType;
}): PromptAnalysis {
  const assumptions: string[] = [];
  const issues: BlueprintIssue[] = [];
  const text = cleanPrompt(input.prompt);
  if (text !== input.prompt.trim())
    issues.push({
      code: "prompt_cleaned",
      severity: "repaired",
      detail: "Markup, code or links were removed from the request before planning.",
    });

  const words = (text.match(WORD) ?? []).map((w) => w.toLowerCase());
  const meaningful = words.filter((w) => !STOPWORDS.has(w) && w.length > 1);
  const titleWords = (cleanPrompt(input.title).match(WORD) ?? []).filter(
    (w) => !STOPWORDS.has(w.toLowerCase()),
  );
  const vague = meaningful.length < 4;
  if (vague)
    assumptions.push(
      titleWords.length > 0
        ? `The request is short, so the title "${input.title.trim().slice(0, 80)}" was used as the topic.`
        : "The request has no clear topic; a general, broadly appealing video was planned.",
    );

  const injection = INJECTION.some((r) => r.test(input.prompt) || r.test(input.title));
  if (injection)
    issues.push({
      code: "prompt_instructions_ignored",
      severity: "warning",
      detail: "The request contained instructions aimed at the AI; they were treated as text only.",
    });

  const letters = text.match(/\p{L}/gu) ?? [];
  const latin = letters.filter((c) => /[A-Za-zÀ-ɏ]/.test(c)).length;
  const nonEnglish = letters.length >= 6 && latin / letters.length < 0.5;
  if (nonEnglish)
    assumptions.push(
      "The request isn't in English; the narration is in English because the free voices are English.",
    );

  const listMatch =
    /\b(?:top\s+)?(\d{1,3})\s+(?:\w+\s+)?(tips|facts|ways|reasons|things|steps|ideas|secrets|mistakes|habits|items|examples)\b/i.exec(
      text,
    );
  let requestedItems: number | null = listMatch ? Number(listMatch[1]) : null;
  if (requestedItems !== null) {
    // Each point needs roughly a shot and a sentence; hook and close take ~30% of the time.
    const fits = Math.max(1, Math.floor((input.duration_seconds * 0.7) / 3.5));
    if (requestedItems > fits) {
      assumptions.push(
        `${requestedItems} ${listMatch?.[2] ?? "points"} don't fit in ${input.duration_seconds} s; the best ${fits} were kept.`,
      );
      requestedItems = fits;
    }
  }

  const scored = scoreTypes(`${input.title} ${text} ${input.style ?? ""}`).filter(
    (s) => s.hits > 0,
  );
  const conflictingTypes = scored
    .filter((s) => s.type !== input.chosenType)
    .map((s) => s.type)
    .slice(0, 2);
  if (conflictingTypes.length > 0 && scored.length > 1)
    assumptions.push(
      `The request also sounds like ${conflictingTypes.join(" and ")}; it was planned as ${input.chosenType}.`,
    );

  return {
    text: text || cleanPrompt(input.title),
    meaningfulWords: meaningful.length,
    vague,
    injection,
    nonEnglish,
    requestedItems,
    conflictingTypes,
    assumptions,
    issues,
  };
}
