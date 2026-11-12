import type { z } from "zod";
import { ApiError } from "./errors";

export const MAX_JSON_BYTES = 64 * 1024;

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Request body is not valid.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Reads, size-limits, parses and validates a JSON body (CLAUDE.md rule 11 applies to input too). */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type))
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_JSON_BYTES)
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Body must be at most ${MAX_JSON_BYTES} bytes.`);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES)
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", `Body must be at most ${MAX_JSON_BYTES} bytes.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "Body is not valid JSON.");
  }
  return parseOrThrow(schema, raw);
}

export function parseOrThrow<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", describe(parsed.error));
  return parsed.data;
}
