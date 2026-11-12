import {
  PROVIDER_CAPABILITIES,
  PROVIDER_HEALTH_STATUSES,
  type ProviderCapability,
  type ProviderHealthStatus,
} from "@avs/types";
import { z } from "zod";
import { invalidData, notFound } from "./errors";
import { jsonObject, type JsonObject } from "./schemas";
import { fromJson, newId, nowIso, toJson } from "./util";

/** Global provider registry. Holds routing state only; credentials stay in Worker secrets. */
interface ProviderRow {
  id: string;
  provider_name: string;
  capability: string;
  enabled: number;
  priority: number;
  health_status: string;
  quota_metadata: string;
  updated_at: string;
}

export interface Provider {
  id: string;
  provider_name: string;
  capability: ProviderCapability;
  enabled: boolean;
  priority: number;
  health_status: ProviderHealthStatus;
  quota: JsonObject;
  updated_at: string;
}

function toProvider(r: ProviderRow): Provider {
  return {
    id: r.id,
    provider_name: r.provider_name,
    capability: z.enum(PROVIDER_CAPABILITIES).parse(r.capability),
    enabled: r.enabled === 1,
    priority: r.priority,
    health_status: z.enum(PROVIDER_HEALTH_STATUSES).parse(r.health_status),
    quota: fromJson(jsonObject, r.quota_metadata, "quota_metadata"),
    updated_at: r.updated_at,
  };
}

const upsertSchema = z.object({
  provider_name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "provider_name must be a lowercase slug"),
  capability: z.enum(PROVIDER_CAPABILITIES),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  quota: jsonObject.default({}),
});
export type UpsertProviderInput = z.input<typeof upsertSchema>;

const SECRETISH = /(api[_-]?key|secret|token|password|authorization|bearer)/i;

export async function upsertProvider(
  db: D1Database,
  input: UpsertProviderInput,
): Promise<Provider> {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid provider");
  const p = parsed.data;
  // Guard against credentials leaking into D1 (CLAUDE.md rule 3).
  if (Object.keys(p.quota).some((k) => SECRETISH.test(k)))
    throw invalidData("quota metadata may not contain credentials");
  await db
    .prepare(
      `INSERT INTO providers (id, provider_name, capability, enabled, priority, quota_metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_name, capability) DO UPDATE SET
         enabled = excluded.enabled, priority = excluded.priority,
         quota_metadata = excluded.quota_metadata, updated_at = excluded.updated_at`,
    )
    .bind(
      newId(),
      p.provider_name,
      p.capability,
      p.enabled ? 1 : 0,
      p.priority,
      toJson(jsonObject, p.quota, "quota"),
      nowIso(),
    )
    .run();
  const row = await db
    .prepare("SELECT * FROM providers WHERE provider_name = ? AND capability = ?")
    .bind(p.provider_name, p.capability)
    .first<ProviderRow>();
  if (!row) throw new Error("provider upsert failed");
  return toProvider(row);
}

/** Enabled providers for a capability in routing order: healthy first, then by priority. */
export async function listProvidersForCapability(
  db: D1Database,
  capability: ProviderCapability,
  opts: { includeDisabled?: boolean } = {},
): Promise<Provider[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM providers WHERE capability = ? ${opts.includeDisabled ? "" : "AND enabled = 1"}
       ORDER BY CASE health_status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1
                WHEN 'degraded' THEN 2 ELSE 3 END, priority, provider_name`,
    )
    .bind(capability)
    .all<ProviderRow>();
  return results.map(toProvider);
}

export async function setProviderHealth(
  db: D1Database,
  providerName: string,
  capability: ProviderCapability,
  health: ProviderHealthStatus,
): Promise<void> {
  if (!z.enum(PROVIDER_HEALTH_STATUSES).safeParse(health).success)
    throw invalidData("health status is not valid");
  const res = await db
    .prepare(
      "UPDATE providers SET health_status = ?, updated_at = ? WHERE provider_name = ? AND capability = ?",
    )
    .bind(health, nowIso(), providerName, capability)
    .run();
  if (res.meta.changes === 0) throw notFound("provider");
}
