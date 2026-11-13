import { API_PATHS, API_PREFIX } from "@avs/contracts";
import { authenticate } from "./auth/middleware";
import type { KeyFetcher } from "./auth/access";
import type { Env } from "./env";
import { ApiError, toErrorResponse } from "./lib/errors";
import { Router } from "./lib/router";
import { handleHealth } from "./routes/health";
import { registerMediaRoutes } from "./routes/media";
import { registerProductionRoutes } from "./routes/production";
import { registerProjectRoutes, type Ctx } from "./routes/projects";

export { ProductionWorkflow } from "./workflows/production-workflow";

const router = new Router<Ctx>();
registerProjectRoutes(router);
registerProductionRoutes(router);
registerMediaRoutes(router);

async function handleApi(request: Request, env: Env, url: URL, getKeys?: KeyFetcher) {
  // Health is public so uptime checks work without signing in.
  if (url.pathname === API_PATHS.health) {
    if (request.method !== "GET" && request.method !== "HEAD")
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.", false, {
        allow: "GET, HEAD",
      });
    return handleHealth(env);
  }
  const { handler, params } = router.match(request.method, url.pathname);
  if (!env.DB) throw new ApiError(503, "INTERNAL_ERROR", "The database is not configured.", true);
  const user = await authenticate(request, env, env.DB, getKeys);
  return handler({ request, env, db: env.DB, user, url }, params);
}

/** Builds the Worker. Tests inject a key fetcher; production uses Cloudflare's published keys. */
export function createWorker(deps: { getKeys?: KeyFetcher } = {}) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          if (!url.pathname.startsWith(`${API_PREFIX}/`))
            throw new ApiError(404, "NOT_FOUND", `Unknown API version. Use ${API_PREFIX}.`);
          return await handleApi(request, env, url, deps.getKeys);
        }
        // Everything else is the built frontend (served by the ASSETS binding when deployed).
        if (env.ASSETS) return await env.ASSETS.fetch(request);
        return new Response("Not found", { status: 404 });
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
