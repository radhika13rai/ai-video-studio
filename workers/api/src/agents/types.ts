import { ASPECT_RATIOS, TARGET_PLATFORMS, VIDEO_TYPES } from "@avs/types";
import { z } from "zod";

/** What every agent receives about the project. Validated at each agent's entry. */
export const briefSchema = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(4000),
  video_type: z.enum(VIDEO_TYPES),
  aspect_ratio: z.enum(ASPECT_RATIOS),
  duration_seconds: z.number().int().min(5).max(60),
  target_platform: z.enum(TARGET_PLATFORMS),
  style: z.string().max(200).nullish(),
});
export type Brief = z.infer<typeof briefSchema>;

export interface AgentMeta {
  agent: string;
  /** "deterministic" for rule-based agents, otherwise the model name. */
  model: string;
  attempts: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AgentResult<T> {
  output: T;
  meta: AgentMeta;
}

export type AgentErrorKind = "invalid_input" | "invalid_output" | "quota" | "unavailable";

export class AgentError extends Error {
  constructor(
    readonly agent: string,
    message: string,
    readonly kind: AgentErrorKind,
    readonly retryable: boolean,
  ) {
    super(`${agent}: ${message}`);
    this.name = "AgentError";
  }
}

export function parseInput<S extends z.ZodType>(
  agent: string,
  schema: S,
  input: unknown,
): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success)
    throw new AgentError(
      agent,
      `invalid input: ${r.error.issues[0]?.message ?? "?"}`,
      "invalid_input",
      false,
    );
  return r.data;
}
