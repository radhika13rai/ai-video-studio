import { API_PATHS, API_PREFIX } from "@avs/contracts";
import type { Env } from "./env";
import { jsonError } from "./lib/http";
import { handleHealth } from "./routes/health";

async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === API_PATHS.health) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError(405, "METHOD_NOT_ALLOWED", "Use GET for this endpoint.", false, {
        allow: "GET, HEAD",
      });
    }
    return handleHealth(env);
  }
  return jsonError(404, "NOT_FOUND", `No API route matches ${pathname}.`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        if (!pathname.startsWith(`${API_PREFIX}/`)) {
          return jsonError(404, "NOT_FOUND", `Unknown API version. Use ${API_PREFIX}.`);
        }
        return await handleApi(request, env, pathname);
      }
      // Everything else is the built frontend (served by the ASSETS binding when deployed).
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("Unhandled error", err);
      return jsonError(500, "INTERNAL_ERROR", "Unexpected server error.", true);
    }
  },
} satisfies ExportedHandler<Env>;
