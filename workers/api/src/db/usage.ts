import {
  PROVIDER_CAPABILITIES,
  PROVIDER_TIERS,
  type ProviderCapability,
  type ProviderTier,
} from "@avs/types";
import { z } from "zod";
import { invalidData, notFound } from "./errors";
import { newId, nowIso, OWNED } from "./util";

export interface UsageEvent {
  id: string;
  project_id: string | null;
  provider_name: string;
  capability: ProviderCapability;
  units_used: number;
  unit_type: string;
  estimated_cost_usd: number;
  /** What the provider reported charging; null when its API doesn't say. */
  actual_cost_usd: number | null;
  tier: ProviderTier;
  user_id: string | null;
  job_id: string | null;
  created_at: string;
}

const usageSchema = z.object({
  provider_name: z.string().min(1).max(64),
  capability: z.enum(PROVIDER_CAPABILITIES),
  units_used: z.number().nonnegative().finite(),
  unit_type: z.string().min(1).max(32),
  estimated_cost_usd: z.number().nonnegative().finite().default(0),
  actual_cost_usd: z.number().nonnegative().finite().nullable().default(null),
  tier: z.enum(PROVIDER_TIERS).default("free"),
  job_id: z.string().max(64).nullable().default(null),
});
export type RecordUsageInput = z.input<typeof usageSchema>;

/** Records provider usage for a project the user owns. */
export async function recordUsage(
  db: D1Database,
  userId: string,
  projectId: string,
  input: RecordUsageInput,
): Promise<UsageEvent> {
  const parsed = usageSchema.safeParse(input);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid usage");
  const u = parsed.data;
  const row = await db
    .prepare(
      `INSERT INTO usage_events (id, project_id, user_id, provider_name, capability, units_used,
         unit_type, estimated_cost_usd, actual_cost_usd, tier, job_id, created_at)
       SELECT ?, id, user_id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM projects WHERE id = ? AND user_id = ?
       RETURNING *`,
    )
    .bind(
      newId(),
      u.provider_name,
      u.capability,
      u.units_used,
      u.unit_type,
      u.estimated_cost_usd,
      u.actual_cost_usd,
      u.tier,
      u.job_id,
      nowIso(),
      projectId,
      userId,
    )
    .first<UsageEvent>();
  if (!row) throw notFound("project");
  return row;
}

export async function listUsageForProject(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<UsageEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM usage_events WHERE project_id = ? AND ${OWNED("project_id")}
       ORDER BY created_at, id`,
    )
    .bind(projectId, userId)
    .all<UsageEvent>();
  return results;
}

/**
 * Total units a provider has used for a capability since `sinceIso`, across all users. Used to
 * stay inside free-tier quotas (global, not per user, so it is not ownership-scoped).
 */
export async function sumProviderUsageSince(
  db: D1Database,
  providerName: string,
  capability: ProviderCapability,
  sinceIso: string,
): Promise<{ units: number; cost_usd: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(units_used), 0) AS units, COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd
       FROM usage_events WHERE provider_name = ? AND capability = ? AND created_at >= ?`,
    )
    .bind(providerName, capability, sinceIso)
    .first<{ units: number; cost_usd: number }>();
  return row ?? { units: 0, cost_usd: 0 };
}

/** Money counted against budgets: the actual cost when known, else the estimate. */
const SPEND = "COALESCE(actual_cost_usd, estimated_cost_usd)";

/** Paid spend since `sinceIso`, overall and for one user. */
export async function paidSpendSince(
  db: D1Database,
  userId: string,
  sinceIso: string,
): Promise<{ total_usd: number; user_usd: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(${SPEND}), 0) AS total_usd,
              COALESCE(SUM(CASE WHEN user_id = ? THEN ${SPEND} ELSE 0 END), 0) AS user_usd
       FROM usage_events WHERE tier = 'paid' AND created_at >= ?`,
    )
    .bind(userId, sinceIso)
    .first<{ total_usd: number; user_usd: number }>();
  return row ?? { total_usd: 0, user_usd: 0 };
}

/**
 * Reserves a paid call's estimated cost as a usage row, atomically: the row is written only if
 * today's paid spend plus this estimate stays within both budgets, so concurrent calls can't
 * overspend together. Returns the reservation id, or null when the budget doesn't allow it.
 * The row is settled with the real units and cost on success, or released on failure.
 */
export async function reservePaidSpend(
  db: D1Database,
  userId: string,
  projectId: string,
  input: {
    provider_name: string;
    capability: ProviderCapability;
    unit_type: string;
    estimated_cost_usd: number;
    job_id?: string | null;
  },
  budget: { daily_usd: number; user_daily_usd: number; since: string },
): Promise<string | null> {
  const id = newId();
  const row = await db
    .prepare(
      `INSERT INTO usage_events (id, project_id, user_id, provider_name, capability, units_used,
         unit_type, estimated_cost_usd, tier, job_id, created_at)
       SELECT ?, p.id, p.user_id, ?, ?, 0, ?, ?, 'paid', ?, ?
       FROM projects p
       WHERE p.id = ? AND p.user_id = ?
         AND (SELECT COALESCE(SUM(${SPEND}), 0) FROM usage_events
              WHERE tier = 'paid' AND created_at >= ?) + ? <= ?
         AND (SELECT COALESCE(SUM(${SPEND}), 0) FROM usage_events
              WHERE tier = 'paid' AND user_id = ? AND created_at >= ?) + ? <= ?
       RETURNING id`,
    )
    .bind(
      id,
      input.provider_name,
      input.capability,
      input.unit_type,
      input.estimated_cost_usd,
      input.job_id ?? null,
      nowIso(),
      projectId,
      userId,
      budget.since,
      input.estimated_cost_usd,
      budget.daily_usd,
      userId,
      budget.since,
      input.estimated_cost_usd,
      budget.user_daily_usd,
    )
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Fills in a reservation after the call: real units and, when reported, the actual cost. */
export async function settleUsage(
  db: D1Database,
  usageId: string,
  input: { units_used: number; actual_cost_usd: number | null; job_id?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE usage_events SET units_used = ?, actual_cost_usd = ?, job_id = COALESCE(?, job_id)
       WHERE id = ?`,
    )
    .bind(input.units_used, input.actual_cost_usd, input.job_id ?? null, usageId)
    .run();
}

/** Removes a reservation for a call that failed (nothing was produced or charged). */
export async function releaseUsage(db: D1Database, usageId: string): Promise<void> {
  await db.prepare("DELETE FROM usage_events WHERE id = ?").bind(usageId).run();
}

export interface CostLine {
  provider_name: string;
  capability: ProviderCapability;
  tier: ProviderTier;
  calls: number;
  units: number;
  estimated_usd: number;
  actual_usd: number | null;
}

/** Per-provider totals since `sinceIso` (all users; for the operator's cost view). */
export async function costsSince(db: D1Database, sinceIso: string): Promise<CostLine[]> {
  const { results } = await db
    .prepare(
      `SELECT provider_name, capability, tier, COUNT(*) AS calls,
              COALESCE(SUM(units_used), 0) AS units,
              COALESCE(SUM(estimated_cost_usd), 0) AS estimated_usd,
              SUM(actual_cost_usd) AS actual_usd
       FROM usage_events WHERE created_at >= ?
       GROUP BY provider_name, capability, tier ORDER BY provider_name, capability`,
    )
    .bind(sinceIso)
    .all<CostLine>();
  return results;
}

/** Settles the reservation made for a provider job (see reservePaidSpend). */
export async function settleJobUsage(
  db: D1Database,
  jobId: string,
  input: { units_used: number; actual_cost_usd: number | null },
): Promise<void> {
  await db
    .prepare("UPDATE usage_events SET units_used = ?, actual_cost_usd = ? WHERE job_id = ?")
    .bind(input.units_used, input.actual_cost_usd, jobId)
    .run();
}

/**
 * Releases a failed job's reservation. A provider that reports charging for the failure keeps
 * a row with that actual cost instead.
 */
export async function releaseJobUsage(
  db: D1Database,
  jobId: string,
  chargedUsd: number | null = null,
): Promise<void> {
  if (chargedUsd && chargedUsd > 0)
    await db
      .prepare("UPDATE usage_events SET actual_cost_usd = ? WHERE job_id = ?")
      .bind(chargedUsd, jobId)
      .run();
  else await db.prepare("DELETE FROM usage_events WHERE job_id = ?").bind(jobId).run();
}
