import type { BindingCheck, HealthData } from "@avs/contracts";
import type { Env } from "../env";
import { jsonOk } from "../lib/http";

export const SERVICE_NAME = "ai-video-studio-api";
export const SERVICE_VERSION = "0.1.0";

async function check(fn: () => Promise<unknown>): Promise<BindingCheck> {
  const started = Date.now();
  try {
    await fn();
    return { status: "ok", latency_ms: Date.now() - started };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Probes each binding with the cheapest real call: a SELECT 1, a HEAD on a missing key. */
export async function checkBindings(env: Env): Promise<HealthData["bindings"]> {
  const missing: BindingCheck = { status: "missing" };
  const [database, storage] = await Promise.all([
    env.DB ? check(() => env.DB!.prepare("SELECT 1 AS ok").first()) : missing,
    env.MEDIA ? check(() => env.MEDIA!.head("__health__/probe")) : missing,
  ]);
  return {
    database,
    storage,
    workflows: env.PRODUCTION_WORKFLOW ? { status: "ok" } : missing,
  };
}

export async function handleHealth(env: Env): Promise<Response> {
  const bindings = await checkBindings(env);
  const healthy = Object.values(bindings).every((b) => b.status === "ok");
  const data: HealthData = {
    status: healthy ? "ok" : "degraded",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: env.APP_ENV ?? "development",
    timestamp: new Date().toISOString(),
    bindings,
  };
  // Always 200: the endpoint answered. `status` and `bindings` say what is degraded.
  return jsonOk(data);
}
