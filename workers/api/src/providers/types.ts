import type { AspectRatio } from "@avs/types";

/** Media capabilities with at least one real implementation. Video and music have none yet. */
export type MediaCapability = "image" | "voice";

export type MediaRequest =
  | { capability: "image"; prompt: string; aspect_ratio: AspectRatio }
  | { capability: "voice"; text: string; lang?: string };

export interface MediaResult {
  bytes: Uint8Array;
  mime_type: string;
  extension: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  /** For quota accounting in usage_events. */
  units: number;
  unit_type: string;
  model: string;
}

/** A pluggable media generator. Agents and the workflow only ever see this interface. */
export interface MediaProvider {
  /** Registry key, e.g. "workers-ai-flux". Lowercase slug. */
  readonly name: string;
  readonly capability: MediaCapability;
  /** Daily safety cap we apply ourselves (not the vendor's number); stored in the registry. */
  readonly defaultDailyLimit: number;
  readonly defaultPriority: number;
  generate(request: MediaRequest): Promise<MediaResult>;
}

export type ProviderErrorKind = "quota" | "unavailable" | "bad_response" | "unsupported";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly kind: ProviderErrorKind,
    readonly retryable: boolean,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}
