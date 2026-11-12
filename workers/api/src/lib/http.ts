import type { ErrorCode } from "@avs/contracts";
import { fail, ok } from "@avs/contracts";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function jsonOk<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(ok(data)), { status, headers: JSON_HEADERS });
}

export function jsonError(
  status: number,
  code: ErrorCode,
  message: string,
  retryable = false,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(fail(code, message, retryable)), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
