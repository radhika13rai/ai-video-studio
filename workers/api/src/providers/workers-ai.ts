import type { AspectRatio } from "@avs/types";
import { sniffMedia, toBytes } from "./media-bytes";
import { ProviderError, type MediaProvider, type MediaRequest, type MediaResult } from "./types";

interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

const MAX_BYTES = 15 * 1024 * 1024;

function classify(provider: string, err: unknown): ProviderError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/4006|daily free allocation|neurons/i.test(msg))
    return new ProviderError(
      provider,
      "Workers AI daily free allowance is used up.",
      "quota",
      false,
    );
  return new ProviderError(provider, `request failed: ${msg.slice(0, 200)}`, "unavailable", true);
}

/** Runs a model and validates that real media of the expected kind came back. */
async function runMedia(
  provider: string,
  ai: AiBinding,
  model: string,
  inputs: Record<string, unknown>,
  base64Key: string,
  kind: "image" | "audio",
): Promise<Omit<MediaResult, "units" | "unit_type">> {
  let raw: unknown;
  try {
    raw = await ai.run(model, inputs);
  } catch (err) {
    throw classify(provider, err);
  }
  const bytes = await toBytes(raw, base64Key);
  if (!bytes || bytes.length === 0)
    throw new ProviderError(provider, "returned no media", "bad_response", true);
  if (bytes.length > MAX_BYTES)
    throw new ProviderError(provider, "returned an oversized file", "bad_response", false);
  const sniffed = sniffMedia(bytes);
  if (!sniffed || !sniffed.mime_type.startsWith(`${kind}/`))
    throw new ProviderError(provider, `returned data that isn't ${kind}`, "bad_response", true);
  return { bytes, model, ...sniffed };
}

const VISUAL_SUFFIX = "high detail, professional photography, no text, no watermark, no logos";

/** FLUX.1 schnell: best prompt-following of the free models in testing. Square 1024×1024 only. */
export class WorkersAiFluxImage implements MediaProvider {
  readonly name = "workers-ai-flux";
  readonly capability = "image" as const;
  readonly defaultDailyLimit = 60;
  readonly defaultPriority = 10;
  static readonly MODEL = "@cf/black-forest-labs/flux-1-schnell";
  constructor(private readonly ai: AiBinding) {}

  async generate(req: MediaRequest): Promise<MediaResult> {
    if (req.capability !== "image")
      throw new ProviderError(this.name, "only makes images", "unsupported", false);
    const r = await runMedia(
      this.name,
      this.ai,
      WorkersAiFluxImage.MODEL,
      {
        prompt: `${req.prompt}. ${compositionHint(req.aspect_ratio)} ${VISUAL_SUFFIX}`.slice(
          0,
          2048,
        ),
        steps: 4,
      },
      "image",
      "image",
    );
    return { ...r, units: 1, unit_type: "images" };
  }
}

/** Square output gets cropped for 9:16 and 16:9, so ask for a centred subject. */
function compositionHint(ratio: AspectRatio): string {
  if (ratio === "9:16")
    return "Vertical composition, main subject centred with space above and below.";
  if (ratio === "16:9") return "Wide composition, main subject centred horizontally.";
  return "";
}
