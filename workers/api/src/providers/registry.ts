import {
  listProvidersForCapability,
  recordUsage,
  setProviderHealth,
  sumProviderUsageSince,
} from "../db";
import type { Env } from "../env";
import { WorkersAiFluxImage, WorkersAiMeloVoice, WorkersAiSdxlImage } from "./workers-ai";
import {
  ProviderError,
  type MediaCapability,
  type MediaProvider,
  type MediaRequest,
  type MediaResult,
} from "./types";

let override: MediaProvider[] | null = null;

/** Tests only: replace the code-registered media providers. */
export function setMediaProvidersOverride(providers: MediaProvider[] | null): void {
  override = providers;
}

/** Providers implemented in code and usable in this environment. */
export function codeProviders(env: Env): MediaProvider[] {
  if (override) return override;
  if ((env.AI_MEDIA_PROVIDER ?? "workers-ai") !== "workers-ai" || !env.AI) return [];
  return [
    new WorkersAiFluxImage(env.AI),
    new WorkersAiSdxlImage(env.AI),
    new WorkersAiMeloVoice(env.AI),
  ];
}

/**
 * Makes sure every code provider has a registry row. Existing rows are left alone, so settings
 * changed in D1 (enabled, priority, daily_limit) survive deploys.
 */
export async function syncRegistry(db: D1Database, providers: MediaProvider[]): Promise<void> {
  if (providers.length === 0) return;
  const now = new Date().toISOString();
  await db.batch(
    providers.map((p) =>
      db
        .prepare(
          `INSERT INTO providers (id, provider_name, capability, enabled, priority, health_status, quota_metadata, updated_at)
           VALUES (?, ?, ?, 1, ?, 'unknown', ?, ?) ON CONFLICT(provider_name, capability) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          p.name,
          p.capability,
          p.defaultPriority,
          JSON.stringify({ daily_limit: p.defaultDailyLimit }),
          now,
        ),
    ),
  );
}

const startOfUtcDay = () => `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

export interface Attempt {
  provider: string;
  outcome: "ok" | "quota" | "failed" | "over_daily_limit";
  detail?: string;
}

export class NoProviderError extends Error {
  constructor(
    readonly capability: MediaCapability,
    readonly attempts: Attempt[],
    /** True when some provider failed in a way a later retry might fix. */
    readonly retryable: boolean,
  ) {
    super(
      attempts.length === 0
        ? `No ${capability} provider is configured.`
        : `No ${capability} provider could produce it (${attempts.map((a) => `${a.provider}: ${a.outcome}`).join(", ")}).`,
    );
    this.name = "NoProviderError";
  }
}

/**
 * Tries providers in registry order (enabled, healthy first, then priority), skipping any that
 * reached their daily cap. Records usage and health. Throws NoProviderError when none succeed.
 */
export async function generateMedia(
  db: D1Database,
  env: Env,
  owner: { userId: string; projectId: string },
  request: MediaRequest,
): Promise<{ result: MediaResult; provider: string; attempts: Attempt[] }> {
  const available = codeProviders(env).filter((p) => p.capability === request.capability);
  await syncRegistry(db, available);
  const rows = await listProvidersForCapability(db, request.capability);
  const byName = new Map(available.map((p) => [p.name, p]));
  const attempts: Attempt[] = [];
  let retryable = false;

  for (const row of rows) {
    const provider = byName.get(row.provider_name);
    if (!provider) continue; // registry row for a provider this deploy doesn't have
    const limit = typeof row.quota.daily_limit === "number" ? row.quota.daily_limit : Infinity;
    const used = await sumProviderUsageSince(
      db,
      provider.name,
      request.capability,
      startOfUtcDay(),
    );
    if (used.units >= limit) {
      attempts.push({
        provider: provider.name,
        outcome: "over_daily_limit",
        detail: `${used.units}/${limit} today`,
      });
      continue;
    }
    try {
      const result = await provider.generate(request);
      await recordUsage(db, owner.userId, owner.projectId, {
        provider_name: provider.name,
        capability: request.capability,
        units_used: result.units,
        unit_type: result.unit_type,
      });
      if (row.health_status !== "healthy")
        await setProviderHealth(db, provider.name, request.capability, "healthy");
      attempts.push({ provider: provider.name, outcome: "ok" });
      return { result, provider: provider.name, attempts };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      attempts.push({
        provider: provider.name,
        outcome: err.kind === "quota" ? "quota" : "failed",
        detail: err.message,
      });
      if (err.kind !== "quota" && err.kind !== "unsupported") {
        retryable ||= err.retryable;
        await setProviderHealth(db, provider.name, request.capability, "degraded");
      }
    }
  }
  throw new NoProviderError(request.capability, attempts, retryable);
}
