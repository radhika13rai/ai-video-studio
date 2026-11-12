import type { ErrorCode } from "@avs/contracts";
import { RepositoryError } from "../db";
import { jsonError } from "./http";

/** An error that becomes a specific HTTP response. Throw it from any handler. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const REPO_MAP: Record<RepositoryError["kind"], [number, ErrorCode]> = {
  not_found: [404, "NOT_FOUND"],
  conflict: [409, "CONFLICT"],
  invalid_state: [409, "INVALID_STATE"],
  invalid_data: [400, "VALIDATION_ERROR"],
};

/** Converts anything thrown by a handler into the shared error envelope. Never leaks internals. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ApiError)
    return jsonError(err.status, err.code, err.message, err.retryable, err.headers);
  if (err instanceof RepositoryError) {
    const [status, baseCode] = REPO_MAP[err.kind];
    const code =
      err.kind === "not_found" && /^project /.test(err.message) ? "PROJECT_NOT_FOUND" : baseCode;
    const message = err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".";
    return jsonError(status, code, message, false);
  }
  console.error("Unhandled error", err);
  return jsonError(500, "INTERNAL_ERROR", "Unexpected server error.", true);
}
