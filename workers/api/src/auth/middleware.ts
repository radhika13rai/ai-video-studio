import { upsertUserByEmail, type User } from "../db";
import type { Env } from "../env";
import { ApiError } from "../lib/errors";
import { AccessError, verifyAccessJwt, type KeyFetcher } from "./access";

export const ACCESS_HEADER = "cf-access-jwt-assertion";
export const DEV_USER_HEADER = "x-dev-user";
const DEV_ENVIRONMENTS = new Set(["development", "test"]);
const DEFAULT_DEV_EMAIL = "developer@example.com";

export type AuthMode = "access" | "dev" | "unconfigured";

/** Access when configured; a local developer identity only in development/test; else fail closed. */
export function authMode(env: Env): AuthMode {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return "access";
  if (DEV_ENVIRONMENTS.has(env.APP_ENV ?? "")) return "dev";
  return "unconfigured";
}

function readAccessToken(request: Request): string | null {
  const header = request.headers.get(ACCESS_HEADER);
  if (header) return header;
  const cookie = request.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

/**
 * Resolves the caller to a row in `users`.
 * - access: verifies the Cloudflare Access JWT and maps its email to a user.
 * - dev: uses `X-Dev-User: <email>` or developer@example.com. Never active in production.
 * - unconfigured: rejects every request (production without Access settings).
 */
export async function authenticate(
  request: Request,
  env: Env,
  db: D1Database,
  getKeys?: KeyFetcher,
): Promise<User> {
  const mode = authMode(env);
  if (mode === "unconfigured") {
    console.error("Authentication is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD.");
    throw new ApiError(401, "UNAUTHENTICATED", "Sign-in is not configured for this deployment.");
  }
  if (mode === "dev") {
    const email = request.headers.get(DEV_USER_HEADER)?.trim() || DEFAULT_DEV_EMAIL;
    return upsertUserByEmail(db, email, email.split("@")[0]);
  }
  const token = readAccessToken(request);
  if (!token) throw new ApiError(401, "UNAUTHENTICATED", "Sign in through Cloudflare Access.");
  try {
    const identity = await verifyAccessJwt(token, {
      teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
      audience: env.ACCESS_AUD ?? "",
      ...(getKeys ? { getKeys } : {}),
    });
    return await upsertUserByEmail(db, identity.email);
  } catch (err) {
    if (err instanceof AccessError)
      throw new ApiError(401, "UNAUTHENTICATED", `Access token rejected: ${err.message}.`);
    throw err;
  }
}
