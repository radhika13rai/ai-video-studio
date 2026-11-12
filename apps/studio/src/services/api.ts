import type { ApiResponse, HealthData } from "@avs/contracts";
import { API_PATHS } from "@avs/contracts";
import { errorEnvelopeSchema, healthDataSchema, successEnvelopeSchema } from "@avs/schemas";

const BASE_URL: string = import.meta.env?.VITE_API_BASE_URL ?? "";

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Fetches the API health. Every response is validated before it is trusted. */
export async function getHealth(fetchImpl: typeof fetch = fetch): Promise<HealthData> {
  let res: Response;
  try {
    res = await fetchImpl(`${BASE_URL}${API_PATHS.health}`, {
      headers: { accept: "application/json" },
    });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "Could not reach the API.", true);
  }
  const body: unknown = await res.json().catch(() => null);
  const success = successEnvelopeSchema(healthDataSchema).safeParse(body);
  if (success.success) return success.data.data;
  const failure = errorEnvelopeSchema.safeParse(body);
  if (failure.success) {
    const { code, message, retryable } = failure.data.error;
    throw new ApiClientError(code, message, retryable);
  }
  throw new ApiClientError("INVALID_RESPONSE", `Unexpected response (HTTP ${res.status}).`, false);
}

export type { ApiResponse };
