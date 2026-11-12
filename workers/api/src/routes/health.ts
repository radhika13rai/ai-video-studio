import type { HealthData } from "@avs/contracts";
import type { Env } from "../env";
import { jsonOk } from "../lib/http";

export const SERVICE_NAME = "ai-video-studio-api";
export const SERVICE_VERSION = "0.1.0";

export function handleHealth(env: Env): Response {
  const data: HealthData = {
    status: "ok",
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: env.APP_ENV ?? "development",
    timestamp: new Date().toISOString(),
  };
  return jsonOk(data);
}
