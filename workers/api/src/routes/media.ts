import { API_PREFIX } from "@avs/contracts";
import type { ProviderCosts, ProviderStatus } from "@avs/schemas";
import { PROVIDER_CAPABILITIES } from "@avs/types";
import { textModelFor } from "../ai/factory";
import {
  costsSince,
  getAsset,
  listProvidersForCapability,
  paidSpendSince,
  requireProject,
  sumProviderUsageSince,
} from "../db";
import { ApiError } from "../lib/errors";
import { jsonOk } from "../lib/http";
import type { Router } from "../lib/router";
import { paidSettings, secretOf, startOfUtcDay } from "../providers/policy";
import { codeProviders, isUsable, syncRegistry } from "../providers/registry";
import type { Ctx } from "./projects";

export function registerMediaRoutes(router: Router<Ctx>): void {
  /** Streams an asset from the private bucket, only to the project's owner. */
  router.on(
    "GET",
    `${API_PREFIX}/projects/:id/assets/:assetId/content`,
    async ({ url, env, db, user }, p) => {
      await requireProject(db, user.id, p.id ?? "");
      const asset = await getAsset(db, user.id, p.assetId ?? "");
      if (!asset || asset.project_id !== p.id)
        throw new ApiError(404, "NOT_FOUND", "Asset not found.");
      if (!env.MEDIA)
        throw new ApiError(503, "INTERNAL_ERROR", "Media storage is not configured.", true);
      const object = await env.MEDIA.get(asset.storage_key);
      if (!object)
        throw new ApiError(404, "NOT_FOUND", "The asset's file is missing from storage.");
      return new Response(object.body, {
        headers: {
          "content-type": asset.mime_type,
          "content-length": String(object.size),
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
          "content-disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${asset.storage_key.split("/").pop() ?? "asset"}"`,
        },
      });
    },
  );

  /** Every capability with its providers, facts, health and today's usage against the cap. */
  router.on("GET", `${API_PREFIX}/providers`, async ({ env, db }) => {
    const code = codeProviders(env);
    await syncRegistry(db, code);
    const byName = new Map(code.map((c) => [c.name, c]));
    const day = startOfUtcDay();
    const out: ProviderStatus[] = [];
    for (const capability of PROVIDER_CAPABILITIES) {
      if (capability === "text") {
        const model = textModelFor(env);
        out.push({
          capability,
          provider_name: model?.name ?? null,
          available: model !== null,
          enabled: model !== null,
          health_status: "unknown",
          priority: null,
          daily_limit: null,
          used_today: model
            ? (await sumProviderUsageSince(db, model.name.split(":")[0] ?? "", "text", day)).units
            : 0,
          note: model ? null : "Text generation is switched off in this environment.",
        });
        continue;
      }
      const rows = (await listProvidersForCapability(db, capability, { includeDisabled: true }))
        // Rows of providers removed from the code (e.g. retired models) aren't shown.
        .filter((r) => byName.has(r.provider_name));
      if (rows.length === 0) {
        out.push({
          capability,
          provider_name: null,
          available: false,
          enabled: false,
          health_status: "unknown",
          priority: null,
          daily_limit: null,
          used_today: 0,
          note: EMPTY_NOTES[capability],
        });
        continue;
      }
      for (const r of rows) {
        const p = byName.get(r.provider_name)!;
        const usable = isUsable(env, p);
        out.push({
          capability,
          provider_name: r.provider_name,
          available: usable,
          enabled: r.enabled,
          health_status: r.health_status,
          priority: r.priority,
          daily_limit: typeof r.quota.daily_limit === "number" ? r.quota.daily_limit : null,
          used_today: (await sumProviderUsageSince(db, r.provider_name, capability, day)).units,
          note: usable
            ? null
            : p.credential && !secretOf(env, p.credential)
              ? `Needs the ${p.credential} secret.`
              : "Paid generation is switched off.",
          tier: p.tier,
          mode: p.mode,
          cost_unit: p.cost.unit,
          usd_per_unit: p.cost.usd_per_unit,
          commercial_use: p.commercialUse,
          credential_set: p.credential ? secretOf(env, p.credential) !== null : null,
          consecutive_failures: r.consecutive_failures,
          cooldown_until: r.cooldown_until,
          last_error: r.last_error,
        });
      }
    }
    return jsonOk(out);
  });

  /** Paid settings, today's spend (overall and yours) and per-provider usage and cost totals. */
  router.on("GET", `${API_PREFIX}/providers/costs`, async ({ env, db, user }) => {
    const now = new Date();
    const day = startOfUtcDay(now);
    const month = startOfUtcDay(new Date(now.getTime() - 30 * 86_400_000));
    const paid = paidSettings(env);
    const spend = await paidSpendSince(db, user.id, day);
    const body: ProviderCosts = {
      paid: {
        enabled: paid.enabled,
        daily_budget_usd: paid.daily_usd,
        user_daily_budget_usd: paid.user_daily_usd,
        spent_today_usd: spend.total_usd,
        you_spent_today_usd: spend.user_usd,
      },
      today: await costsSince(db, day),
      last_30_days: await costsSince(db, month),
    };
    return jsonOk(body);
  });
}

const EMPTY_NOTES: Record<Exclude<ProviderStatus["capability"], "text">, string> = {
  image: "No image provider is available in this environment.",
  video: "No video provider yet; scenes use still images with motion.",
  image_to_video: "No image-to-video provider yet; scenes use still images with motion.",
  voice: "Narration is voiced in your browser (Kokoro) when the video renders.",
  music: "Music is generated in your browser when the video renders.",
  sfx: "No sound-effect provider yet.",
};
