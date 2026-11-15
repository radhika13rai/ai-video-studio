import type { AspectRatio, ProviderTier } from "@avs/types";

/**
 * Media capabilities. Each is separate: a provider serves only the capabilities it declares, so
 * an image model is never used to stand in for video (ADR 040). Text has its own interface
 * (ai/text-model.ts).
 */
export type MediaCapability = "image" | "video" | "image_to_video" | "voice" | "music" | "sfx";

export const MEDIA_CAPABILITIES: readonly MediaCapability[] = [
  "image",
  "video",
  "image_to_video",
  "voice",
  "music",
  "sfx",
];

/** One typed request per capability. */
export type MediaRequest =
  | { capability: "image"; prompt: string; aspect_ratio: AspectRatio }
  | { capability: "video"; prompt: string; aspect_ratio: AspectRatio; duration_seconds: number }
  | {
      capability: "image_to_video";
      prompt: string;
      aspect_ratio: AspectRatio;
      duration_seconds: number;
      image: { bytes: Uint8Array; mime_type: string };
    }
  | { capability: "voice"; text: string; lang?: string }
  | { capability: "music"; prompt: string; duration_seconds: number }
  | { capability: "sfx"; prompt: string; duration_seconds: number };

export type RequestFor<C extends MediaCapability> = Extract<MediaRequest, { capability: C }>;

export interface MediaResult {
  bytes: Uint8Array;
  mime_type: string;
  extension: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  /** For quota accounting in usage_events, in the provider's cost unit. */
  units: number;
  unit_type: string;
  model: string;
  /** What the provider says it charged, when its API reports it. */
  actual_cost_usd?: number;
  /** Licence facts for the asset row (e.g. stock footage attribution). */
  license?: Record<string, string>;
}

/** How a provider charges: usd_per_unit × units (units come from `estimateUnits`). */
export interface CostModel {
  unit: "image" | "second" | "1k_chars" | "minute" | "request" | "clip";
  usd_per_unit: number;
  /** Plain-language source of the price, e.g. "Cloudflare catalogue, 2026-11-15". */
  source: string;
}

export interface ProviderLimits {
  aspect_ratios?: readonly AspectRatio[];
  min_duration_seconds?: number;
  max_duration_seconds?: number;
  max_prompt_chars?: number;
  max_text_chars?: number;
}

/** Facts every provider declares in code. Routing, budgets and the status page read these. */
export interface ProviderFacts<C extends MediaCapability = MediaCapability> {
  /** Registry key, e.g. "workers-ai-flux". Lowercase slug. */
  readonly name: string;
  readonly capability: C;
  /** Paid providers run only when paid generation is switched on and the budget allows. */
  readonly tier: ProviderTier;
  readonly cost: CostModel;
  readonly limits: ProviderLimits;
  /** Per-call time limit (each submit or poll for async providers). */
  readonly timeoutMs: number;
  /**
   * Name of the Worker secret holding this provider's key (never the key itself). The provider
   * is unavailable while the secret is unset. Null for bindings such as Workers AI.
   */
  readonly credential: string | null;
  /** Whether output may be used commercially under the provider's terms. */
  readonly commercialUse: boolean;
  /** Daily safety cap we apply ourselves (not the vendor's number); stored in the registry. */
  readonly defaultDailyLimit: number;
  readonly defaultPriority: number;
}

/** Answers in one call. */
export interface SyncMediaProvider<
  C extends MediaCapability = MediaCapability,
> extends ProviderFacts<C> {
  readonly mode: "sync";
  generate(request: RequestFor<C>, signal: AbortSignal): Promise<MediaResult>;
}

export type PollResult =
  | { status: "running" }
  | { status: "succeeded"; result: MediaResult }
  | { status: "failed"; message: string; retryable: boolean };

/** Long-running work: submit, then poll until done (video generation APIs). */
export interface AsyncMediaProvider<
  C extends MediaCapability = MediaCapability,
> extends ProviderFacts<C> {
  readonly mode: "async";
  /** Suggested wait between polls. */
  readonly pollIntervalSeconds: number;
  /** Give up after this long and mark the job timed out. */
  readonly maxWaitSeconds: number;
  submit(request: RequestFor<C>, signal: AbortSignal): Promise<{ external_id: string }>;
  poll(externalId: string, signal: AbortSignal): Promise<PollResult>;
}

/** A pluggable media generator. Agents and the workflow only ever see this interface. */
export type MediaProvider = SyncMediaProvider | AsyncMediaProvider;

export type ProviderErrorKind =
  "quota" | "unavailable" | "bad_response" | "unsupported" | "timeout" | "auth";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly kind: ProviderErrorKind,
    readonly retryable: boolean,
    /** When the provider should be tried again (e.g. a daily allowance resets), if known. */
    readonly retryAt?: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

/** Units of the provider's cost unit a request will use (before the call). */
export function estimateUnits(cost: CostModel, request: MediaRequest): number {
  switch (cost.unit) {
    case "image":
    case "request":
    case "clip":
      return 1;
    case "second":
      return "duration_seconds" in request ? request.duration_seconds : 1;
    case "minute":
      if ("duration_seconds" in request) return request.duration_seconds / 60;
      // ≈150 spoken words a minute
      return request.capability === "voice"
        ? request.text.split(/\s+/).filter(Boolean).length / 150
        : 1;
    case "1k_chars":
      return request.capability === "voice" ? request.text.length / 1000 : 1;
  }
}

/** Estimated cost in USD, rounded to a millionth of a dollar. */
export function estimateCostUsd(provider: Pick<ProviderFacts, "cost">, req: MediaRequest): number {
  return Math.round(provider.cost.usd_per_unit * estimateUnits(provider.cost, req) * 1e6) / 1e6;
}

/** Null when the provider can take the request, else the reason it can't. */
export function unsupportedReason(
  provider: Pick<ProviderFacts, "capability" | "limits">,
  req: MediaRequest,
): string | null {
  if (provider.capability !== req.capability) return `doesn't make ${req.capability}`;
  const l = provider.limits;
  if ("aspect_ratio" in req && l.aspect_ratios && !l.aspect_ratios.includes(req.aspect_ratio))
    return `doesn't support ${req.aspect_ratio}`;
  if ("duration_seconds" in req) {
    if (l.max_duration_seconds !== undefined && req.duration_seconds > l.max_duration_seconds)
      return `clips are at most ${l.max_duration_seconds} s`;
    if (l.min_duration_seconds !== undefined && req.duration_seconds < l.min_duration_seconds)
      return `clips are at least ${l.min_duration_seconds} s`;
  }
  if ("prompt" in req && l.max_prompt_chars !== undefined && req.prompt.length > l.max_prompt_chars)
    return `prompts are at most ${l.max_prompt_chars} characters`;
  if (
    req.capability === "voice" &&
    l.max_text_chars !== undefined &&
    req.text.length > l.max_text_chars
  )
    return `text is at most ${l.max_text_chars} characters`;
  return null;
}

/** Rejects with a timeout ProviderError if `work` takes longer than `ms`, and aborts it. */
export async function withTimeout<T>(
  provider: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(
        new ProviderError(provider, `no answer within ${Math.round(ms / 1000)} s`, "timeout", true),
      );
    }, ms);
  });
  try {
    return await Promise.race([work(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Maps an HTTP failure from a vendor API to a ProviderError. */
export function httpError(provider: string, status: number, detail = ""): ProviderError {
  const tail = detail ? `: ${detail.slice(0, 160)}` : "";
  if (status === 401 || status === 403)
    return new ProviderError(provider, `the API key was refused (HTTP ${status})`, "auth", false);
  if (status === 402 || status === 429)
    return new ProviderError(
      provider,
      `out of quota or credit (HTTP ${status})${tail}`,
      "quota",
      false,
    );
  if (status === 400 || status === 404 || status === 413 || status === 422)
    return new ProviderError(
      provider,
      `request rejected (HTTP ${status})${tail}`,
      "bad_response",
      false,
    );
  return new ProviderError(provider, `HTTP ${status}${tail}`, "unavailable", true);
}
