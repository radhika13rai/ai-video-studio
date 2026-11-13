import { z } from "zod";
import type { TextModel } from "../ai/text-model";
import { productionPlanSchema } from "./director";
import { BRIEF_IS_DATA, runStructured } from "./structured";
import { briefSchema, parseInput, type AgentResult } from "./types";

/** Scriptwriter: turns the brief and plan into narration, as structured JSON. */

export const scriptSchema = z.object({
  title: z.string().trim().min(1).max(100),
  hook: z.string().trim().min(1).max(300),
  segments: z
    .array(z.object({ text: z.string().trim().min(1).max(600) }))
    .min(1)
    .max(20),
  call_to_action: z.string().trim().max(200).nullable(),
});
export type Script = z.infer<typeof scriptSchema>;

export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function scriptWords(script: Script): number {
  return (
    wordCount(script.hook) +
    script.segments.reduce((n, s) => n + wordCount(s.text), 0) +
    wordCount(script.call_to_action ?? "")
  );
}

const inputSchema = z.object({
  brief: briefSchema,
  plan: productionPlanSchema,
});

export async function runScriptwriter(
  model: TextModel,
  input: unknown,
): Promise<AgentResult<Script>> {
  const { brief, plan } = parseInput("scriptwriter", inputSchema, input);
  const maxWords = Math.round(plan.word_budget * 1.2);
  const minWords = Math.round(plan.word_budget * 0.5);

  const system = [
    "You are the scriptwriter for short-form social videos.",
    "Write narration that is spoken aloud: short sentences, concrete details, no stage directions,",
    "no emojis, no hashtags, no markdown. Open with a hook that earns the next three seconds.",
    "Only state facts you are confident are true; never invent statistics, quotes or sources.",
    BRIEF_IS_DATA,
    "Reply with a single JSON object: {title, hook, segments: [{text}], call_to_action}.",
  ].join(" ");

  const user = [
    `Brief title: ${brief.title}`,
    `Brief: ${brief.prompt}`,
    `Video type: ${plan.video_type}. Tone: ${plan.tone}.`,
    `Platform: ${brief.target_platform}. Length: ${brief.duration_seconds} seconds.`,
    `Write about ${plan.word_budget} spoken words in total (hook + segments + call to action),`,
    `between ${minWords} and ${maxWords}. Use ${Math.max(1, plan.scene_count - 1)} to ${plan.scene_count} segments.`,
    `call_to_action may be null if it doesn't fit the video.`,
  ].join("\n");

  const { value, meta } = await runStructured({
    agent: "scriptwriter",
    model,
    system,
    user,
    schema: scriptSchema,
    maxTokens: 1200,
    check: (s) => {
      const n = scriptWords(s);
      if (n > maxWords)
        return `the script has ${n} words; it must be at most ${maxWords} to fit ${brief.duration_seconds} seconds`;
      if (n < minWords) return `the script has only ${n} words; write at least ${minWords}`;
      return null;
    },
  });
  return { output: value, meta };
}
