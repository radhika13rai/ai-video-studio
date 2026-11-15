import {
  listProvidersForCapability,
  paidSpendSince,
  recordProviderFailure,
  recordProviderSuccess,
  recordUsage,
  releaseUsage,
  reservePaidSpend,
  settleUsage,
  sumProviderUsageSince,
} from "../db";
import type { Env } from "../env";
import { paidSettings, planRoute, secretOf, startOfUtcDay, type RoutePlan } from "./policy";
import { FalWanImageToVideo } from "./fal";
import { PexelsStockVideo } from "./pexels";
import { WorkersAiFluxImage } from "./workers-ai";
import {
  ProviderError,
  withTimeout,
  type MediaCapability,
  type MediaProvider,
  type MediaRequest,
  type MediaResult,
  type SyncMediaProvider,
} from "./types";

let override: MediaProvider[] | null = null;

/** Tests only: replace the code-registered media providers. */
export function setMediaProvidersOverride(providers: MediaProvider[] | null): void {
  override = providers;
}

/** Providers implemented in code for this environment (usable or not; see `isUsable`). */
export function codeProviders(env: Env): MediaProvider[] {
  if (override) return override;
  if (env.AI_MEDIA_PROVIDER === "none") return [];
  const out: MediaProvider[] = [];
  // SDXL-Lightning and MeloTTS were removed: Cloudflare retires both on 2026-11-20 (ADR 039).
  if (env.AI) out.push(new WorkersAiFluxImage(env.AI));
  // Free stock footage; skipped by routing until the PEXELS_API_KEY secret is set (ADR 041).
  out.push(new PexelsStockVideo(() => secretOf(env, "PEXELS_API_KEY")));
  // Paid: runs only with PAID_PROVIDERS=on, a daily budget and the FAL_KEY secret (ADR 042).
  out.push(new FalWanImageToVideo(() => secretOf(env, "FAL_KEY")));
  return out;
}

/** Has its key (if it needs one) and, if paid, paid generation is switched on. */
export function isUsable(env: Env, provider: MediaProvider): boolean {
  if (provider.credential && !secretOf(env, provider.credential)) return false;
  return provider.tier === "free" || paidSettings(env).enabled;
}

/** True when this deploy has a usable provider for the capability (ignoring health). */
export function hasCodeProvider(env: Env, capability: MediaCapability): boolean {
  return codeProviders(env).some((p) => p.capability === capability && isUsable(env, p));
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

export interface Attempt {
  provider: string;
  outcome:
    | "ok"
    | "quota"
    | "failed"
    | "timeout"
    | "over_daily_limit"
    | "over_budget"
    | "cooling_down"
    | "skipped";
  detail?: string;
}

/** "provider: outcome – why", with the provider's own name trimmed from the reason. */
function describeAttempt(a: Attempt): string {
  const why = a.detail?.replace(new RegExp(`^${a.provider}: `), "").slice(0, 120);
  return `${a.provider}: ${a.outcome}${why && a.outcome !== "ok" ? ` – ${why}` : ""}`;
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
        : `No ${capability} provider could produce it (${attempts.map(describeAttempt).join(", ")}).`,
    );
    this.name = "NoProviderError";
  }
}

const SKIP_OUTCOME: Record<RoutePlan["skipped"][number]["reason"], Attempt["outcome"]> = {
  disabled: "skipped",
  unsupported: "skipped",
  no_credential: "skipped",
  paid_off: "skipped",
  wrong_mode: "skipped",
  over_budget: "over_budget",
  cooling_down: "cooling_down",
  over_daily_limit: "over_daily_limit",
};

/** Gathers the inputs and plans the route for a request (no provider is called). */
export async function routeFor(
  db: D1Database,
  env: Env,
  userId: string,
  request: MediaRequest,
  opts: { mode?: "sync" | "async"; exclude?: ReadonlySet<string>; now?: Date } = {},
): Promise<RoutePlan & { providers: MediaProvider[] }> {
  const now = opts.now ?? new Date();
  const providers = codeProviders(env).filter((p) => p.capability === request.capability);
  await syncRegistry(db, providers);
  const rows = await listProvidersForCapability(db, request.capability);
  const day = startOfUtcDay(now);
  const usedToday = new Map<string, number>();
  for (const p of providers)
    usedToday.set(p.name, (await sumProviderUsageSince(db, p.name, p.capability, day)).units);
  const spend = providers.some((p) => p.tier === "paid")
    ? await paidSpendSince(db, userId, day)
    : { total_usd: 0, user_usd: 0 };
  const plan = planRoute({
    request,
    providers,
    rows,
    usedToday,
    spend,
    paid: paidSettings(env),
    hasCredential: (p) => secretOf(env, p.credential) !== null,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    now,
  });
  return { ...plan, providers };
}

/** How a failure changes the provider's registry state (circuit breaker, ADR 040). */
export async function noteFailure(
  db: D1Database,
  provider: Pick<MediaProvider, "name" | "capability">,
  err: ProviderError,
  now = new Date(),
): Promise<void> {
  if (err.kind === "unsupported") return;
  if (err.kind === "quota")
    // Out of allowance isn't broken: pause until it resets (or 10 minutes), no failure counted.
    return recordProviderFailure(
      db,
      provider.name,
      provider.capability,
      {
        message: err.message,
        countsAsFailure: false,
        pauseUntil: err.retryAt ?? new Date(now.getTime() + 10 * 60_000).toISOString(),
      },
      now,
    );
  return recordProviderFailure(
    db,
    provider.name,
    provider.capability,
    {
      message: err.message,
      countsAsFailure: true,
      // A refused key won't fix itself: pause for an hour.
      ...(err.kind === "auth"
        ? { pauseUntil: new Date(now.getTime() + 60 * 60_000).toISOString() }
        : {}),
    },
    now,
  );
}

const outcomeOf = (err: ProviderError): Attempt["outcome"] =>
  err.kind === "quota" ? "quota" : err.kind === "timeout" ? "timeout" : "failed";

/**
 * Produces media with the first provider that can (sync providers only; long-running providers
 * go through jobs.ts). Providers are tried in route order; each call has a time limit; paid calls
 * reserve their estimated cost within the budget first. Records usage (estimated and actual
 * cost) and health. Throws NoProviderError when none succeed.
 */
export async function generateMedia(
  db: D1Database,
  env: Env,
  owner: { userId: string; projectId: string },
  request: MediaRequest,
): Promise<{ result: MediaResult; provider: string; attempts: Attempt[] }> {
  const plan = await routeFor(db, env, owner.userId, request, { mode: "sync" });
  const attempts: Attempt[] = plan.skipped
    .filter((s) => s.reason !== "wrong_mode")
    .map((s) => ({ provider: s.provider, outcome: SKIP_OUTCOME[s.reason], detail: s.detail }));
  // A pause or a cap ends today or soon, so a later retry may work; other skips won't change.
  let retryable = false;
  const budget = paidSettings(env);
  const day = startOfUtcDay();

  for (const { provider: p, estimated_cost_usd } of plan.candidates) {
    const provider = p as SyncMediaProvider;
    let reservation: string | null = null;
    if (provider.tier === "paid") {
      reservation = await reservePaidSpend(
        db,
        owner.userId,
        owner.projectId,
        {
          provider_name: provider.name,
          capability: provider.capability,
          unit_type: provider.cost.unit,
          estimated_cost_usd,
        },
        { daily_usd: budget.daily_usd, user_daily_usd: budget.user_daily_usd, since: day },
      );
      if (!reservation) {
        attempts.push({ provider: provider.name, outcome: "over_budget" });
        continue;
      }
    }
    try {
      const result = await withTimeout(provider.name, provider.timeoutMs, (signal) =>
        provider.generate(request as never, signal),
      );
      if (reservation)
        await settleUsage(db, reservation, {
          units_used: result.units,
          actual_cost_usd: result.actual_cost_usd ?? null,
        });
      else
        await recordUsage(db, owner.userId, owner.projectId, {
          provider_name: provider.name,
          capability: request.capability,
          units_used: result.units,
          unit_type: result.unit_type,
          estimated_cost_usd,
          actual_cost_usd: result.actual_cost_usd ?? null,
          tier: provider.tier,
        });
      await recordProviderSuccess(db, provider.name, request.capability);
      attempts.push({ provider: provider.name, outcome: "ok" });
      return { result, provider: provider.name, attempts };
    } catch (err) {
      if (reservation) await releaseUsage(db, reservation);
      if (!(err instanceof ProviderError)) throw err;
      attempts.push({ provider: provider.name, outcome: outcomeOf(err), detail: err.message });
      if (err.kind !== "quota" && err.kind !== "unsupported") retryable ||= err.retryable;
      await noteFailure(db, provider, err);
    }
  }
  throw new NoProviderError(request.capability, attempts, retryable);
}
