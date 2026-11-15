import type { Provider } from "../db";
import type { Env } from "../env";
import { estimateCostUsd, unsupportedReason, type MediaProvider, type MediaRequest } from "./types";

/**
 * Deterministic routing (ADR 040). Given the code providers, their registry rows, today's usage
 * and the paid-generation settings, decides which providers may take a request and in what
 * order, and records why each other one was skipped. No I/O: the registry gathers the inputs.
 */

export interface PaidSettings {
  /** PAID_PROVIDERS="on". Off by default: paid providers never run unless switched on. */
  enabled: boolean;
  /** Most that all paid calls may cost per UTC day, in USD. */
  daily_usd: number;
  /** Most that one user's paid calls may cost per UTC day, in USD. */
  user_daily_usd: number;
}

const usd = (raw: string | undefined): number => {
  const n = Number(raw ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Paid-generation settings from plain (non-secret) Worker variables. */
export function paidSettings(env: Env): PaidSettings {
  const daily = usd(env.PAID_DAILY_BUDGET_USD);
  const perUser =
    env.PAID_USER_DAILY_BUDGET_USD === undefined ? daily : usd(env.PAID_USER_DAILY_BUDGET_USD);
  return {
    enabled: env.PAID_PROVIDERS === "on" && daily > 0,
    daily_usd: daily,
    user_daily_usd: Math.min(daily, perUser),
  };
}

/** A provider's key, read from Worker secrets by name. Never logged or returned. */
export function secretOf(env: Env, name: string | null): string | null {
  if (!name) return null;
  const v = (env as unknown as Record<string, unknown>)[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export type SkipReason =
  | "disabled"
  | "unsupported"
  | "no_credential"
  | "paid_off"
  | "over_budget"
  | "cooling_down"
  | "over_daily_limit"
  | "wrong_mode";

export interface Candidate {
  provider: MediaProvider;
  row: Provider;
  estimated_cost_usd: number;
}

export interface RoutePlan {
  candidates: Candidate[];
  skipped: { provider: string; reason: SkipReason; detail: string }[];
}

const HEALTH_ORDER: Record<string, number> = { healthy: 0, unknown: 1, degraded: 2, down: 3 };

export function planRoute(input: {
  request: MediaRequest;
  providers: MediaProvider[];
  rows: Provider[];
  /** Units each provider used today (for the registry's daily_limit). */
  usedToday: Map<string, number>;
  /** Paid spend today, overall and for this user. */
  spend: { total_usd: number; user_usd: number };
  paid: PaidSettings;
  hasCredential: (provider: MediaProvider) => boolean;
  mode?: "sync" | "async";
  /** Providers already tried for this piece of work. */
  exclude?: ReadonlySet<string>;
  now: Date;
}): RoutePlan {
  const { request, now } = input;
  const byName = new Map(input.providers.map((p) => [p.name, p]));
  const skipped: RoutePlan["skipped"] = [];
  const candidates: Candidate[] = [];
  const skip = (provider: string, reason: SkipReason, detail: string) =>
    skipped.push({ provider, reason, detail });

  for (const row of input.rows) {
    const provider = byName.get(row.provider_name);
    if (!provider || row.capability !== request.capability) continue;
    if (input.exclude?.has(provider.name)) continue;
    if (!row.enabled) {
      skip(provider.name, "disabled", "switched off in the registry");
      continue;
    }
    if (input.mode && provider.mode !== input.mode) {
      skip(provider.name, "wrong_mode", `${provider.mode} provider`);
      continue;
    }
    const why = unsupportedReason(provider, request);
    if (why) {
      skip(provider.name, "unsupported", why);
      continue;
    }
    if (provider.credential && !input.hasCredential(provider)) {
      skip(provider.name, "no_credential", `the ${provider.credential} secret isn't set`);
      continue;
    }
    if (row.cooldown_until && new Date(row.cooldown_until) > now) {
      skip(provider.name, "cooling_down", `paused until ${row.cooldown_until}`);
      continue;
    }
    const limit = typeof row.quota.daily_limit === "number" ? row.quota.daily_limit : Infinity;
    const used = input.usedToday.get(provider.name) ?? 0;
    if (used >= limit) {
      skip(provider.name, "over_daily_limit", `${used}/${limit} today`);
      continue;
    }
    const estimated = estimateCostUsd(provider, request);
    if (provider.tier === "paid") {
      if (!input.paid.enabled) {
        skip(provider.name, "paid_off", "paid generation is switched off");
        continue;
      }
      const s = input.spend;
      if (
        s.total_usd + estimated > input.paid.daily_usd ||
        s.user_usd + estimated > input.paid.user_daily_usd
      ) {
        skip(
          provider.name,
          "over_budget",
          `$${estimated.toFixed(2)} would pass today's budget ($${s.total_usd.toFixed(2)} of $${input.paid.daily_usd.toFixed(2)} used)`,
        );
        continue;
      }
    }
    candidates.push({ provider, row, estimated_cost_usd: estimated });
  }

  candidates.sort(
    (a, b) =>
      (HEALTH_ORDER[a.row.health_status] ?? 9) - (HEALTH_ORDER[b.row.health_status] ?? 9) ||
      a.row.priority - b.row.priority ||
      a.estimated_cost_usd - b.estimated_cost_usd ||
      a.provider.name.localeCompare(b.provider.name),
  );
  return { candidates, skipped };
}

/** Start of the current UTC day, when daily caps and budgets reset. */
export const startOfUtcDay = (now = new Date()) =>
  `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

/** Start of the next UTC day (Workers AI's free allocation resets then). */
export const nextUtcMidnight = (now = new Date()) => {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
};
