import type { Env } from "../env";
import { DEFAULT_WORKERS_AI_MODEL, WorkersAiTextModel, type TextModel } from "./text-model";

let override: TextModel | null = null;

/** Tests only: route every text request to `model` (pass null to restore). */
export function setTextModelOverride(model: TextModel | null): void {
  override = model;
}

/** The text model for this environment, or null when none is available (local dev, no AI). */
export function textModelFor(env: Env): TextModel | null {
  if (override) return override;
  // Explicit switch: under `wrangler dev --local` and in tests the AI binding object exists but
  // can't run, so its presence alone doesn't mean AI is available.
  if ((env.AI_TEXT_PROVIDER ?? "workers-ai") !== "workers-ai" || !env.AI) return null;
  return new WorkersAiTextModel(env.AI, env.AI_TEXT_MODEL || DEFAULT_WORKERS_AI_MODEL);
}
