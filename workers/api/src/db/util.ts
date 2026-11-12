import type { z } from "zod";
import { invalidData } from "./errors";

/** All IDs are UUIDs generated in the application. */
export const newId = (): string => crypto.randomUUID();

/** All timestamps are UTC ISO-8601 strings. */
export const nowIso = (): string => new Date().toISOString();

/** Validates a value against a schema, then serializes it for a JSON TEXT column. */
export function toJson<T>(schema: z.ZodType<T>, value: unknown, field: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw invalidData(`${field}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return JSON.stringify(parsed.data);
}

/** Parses a JSON TEXT column read from the database and validates its shape. */
export function fromJson<T>(schema: z.ZodType<T>, text: string | null, field: string): T {
  let raw: unknown;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    throw invalidData(`${field}: stored JSON is malformed`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidData(`${field}: stored JSON has an unexpected shape`);
  return parsed.data;
}

/**
 * SQL fragment that is true only when `projectCol` belongs to the user bound at the
 * placeholder position. Every project-scoped query goes through this (CLAUDE.md rule 9).
 */
export const OWNED = (projectCol: string) =>
  `${projectCol} IN (SELECT id FROM projects WHERE user_id = ?)`;
