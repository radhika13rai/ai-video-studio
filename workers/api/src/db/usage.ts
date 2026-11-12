import { PROVIDER_CAPABILITIES, type ProviderCapability } from "@avs/types";
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
  created_at: string;
}

const usageSchema = z.object({
  provider_name: z.string().min(1).max(64),
  capability: z.enum(PROVIDER_CAPABILITIES),
  units_used: z.number().nonnegative().finite(),
  unit_type: z.string().min(1).max(32),
  estimated_cost_usd: z.number().nonnegative().finite().default(0),
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
      `INSERT INTO usage_events (id, project_id, provider_name, capability, units_used, unit_type,
         estimated_cost_usd, created_at)
       SELECT ?, id, ?, ?, ?, ?, ?, ? FROM projects WHERE id = ? AND user_id = ?
       RETURNING *`,
    )
    .bind(
      newId(),
      u.provider_name,
      u.capability,
      u.units_used,
      u.unit_type,
      u.estimated_cost_usd,
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
