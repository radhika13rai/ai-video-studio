import { z } from "zod";

/**
 * The only thing agents know about language models. Any provider (Workers AI today, others in
 * Task 8) implements this, so agents never import a vendor SDK (CLAUDE.md rule 10).
 */
export interface TextModel {
  readonly name: string;
  generate(request: TextRequest): Promise<TextResponse>;
}

export interface TextRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** JSON Schema the reply must follow. Providers that support constrained output use it. */
  jsonSchema?: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
}

export interface TextResponse {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type ModelErrorKind = "quota" | "unavailable" | "bad_response";

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: ModelErrorKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/** Default text model on the Workers AI free tier. Supports JSON-schema constrained output. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const workersAiResponse = z.object({
  response: z
    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .nullish(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
});

interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Workers AI through the `AI` binding. The response is validated before use (rule 11). */
export class WorkersAiTextModel implements TextModel {
  readonly name: string;
  constructor(
    private readonly ai: AiBinding,
    model: string = DEFAULT_WORKERS_AI_MODEL,
  ) {
    this.name = `workers-ai:${model}`;
    this.model = model;
  }
  private readonly model: string;

  async generate(req: TextRequest): Promise<TextResponse> {
    let raw: unknown;
    try {
      raw = await this.ai.run(this.model, {
        messages: [{ role: "system", content: req.system }, ...req.messages],
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.6,
        ...(req.jsonSchema
          ? { response_format: { type: "json_schema", json_schema: req.jsonSchema } }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 4006: the account used up its free daily allocation; retrying today won't help.
      if (/4006|daily free allocation|neurons/i.test(msg))
        throw new ModelError("Workers AI daily free allowance is used up.", "quota", false);
      throw new ModelError(`Workers AI request failed: ${msg.slice(0, 200)}`, "unavailable", true);
    }
    const parsed = workersAiResponse.safeParse(raw);
    if (!parsed.success || parsed.data.response == null)
      throw new ModelError("Workers AI returned an unexpected response.", "bad_response", true);
    const r = parsed.data.response;
    const usage = parsed.data.usage;
    return {
      text: typeof r === "string" ? r : JSON.stringify(r),
      ...(usage
        ? {
            usage: {
              ...(usage.prompt_tokens !== undefined ? { input_tokens: usage.prompt_tokens } : {}),
              ...(usage.completion_tokens !== undefined
                ? { output_tokens: usage.completion_tokens }
                : {}),
            },
          }
        : {}),
    };
  }
}
