import { API_PREFIX } from "@avs/contracts";
import type { ProviderStatus } from "@avs/schemas";
import { PROVIDER_CAPABILITIES } from "@avs/types";
import { textModelFor } from "../ai/factory";
import { getAsset, listProvidersForCapability, requireProject, sumProviderUsageSince } from "../db";
import { ApiError } from "../lib/errors";
import { jsonOk } from "../lib/http";
import type { Router } from "../lib/router";
import { codeProviders, syncRegistry } from "../providers/registry";
import type { Ctx } from "./projects";

export function registerMediaRoutes(router: Router<Ctx>): void {
  /** Streams an asset from the private bucket, only to the project's owner. */
  router.on(
    "GET",
    `${API_PREFIX}/projects/:id/assets/:assetId/content`,
    async ({ env, db, user }, p) => {
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
          "content-disposition": `inline; filename="${asset.storage_key.split("/").pop() ?? "asset"}"`,
        },
      });
    },
  );

  /** Every capability with its providers, availability and today's usage against the daily cap. */
  router.on("GET", `${API_PREFIX}/providers`, async ({ env, db }) => {
    const code = codeProviders(env);
    await syncRegistry(db, code);
    const names = new Set(code.map((c) => c.name));
    const day = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
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
      const rows = await listProvidersForCapability(db, capability, { includeDisabled: true });
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
          note:
            capability === "video" || capability === "music"
              ? `No free ${capability} provider is integrated yet.`
              : `No ${capability} provider is available in this environment.`,
        });
        continue;
      }
      for (const r of rows)
        out.push({
          capability,
          provider_name: r.provider_name,
          available: names.has(r.provider_name),
          enabled: r.enabled,
          health_status: r.health_status,
          priority: r.priority,
          daily_limit: typeof r.quota.daily_limit === "number" ? r.quota.daily_limit : null,
          used_today: (await sumProviderUsageSince(db, r.provider_name, capability, day)).units,
          note: names.has(r.provider_name) ? null : "Not available in this environment.",
        });
    }
    return jsonOk(out);
  });
}
