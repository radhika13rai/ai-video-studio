import { API_PATHS } from "@avs/contracts";
import { errorEnvelopeSchema, healthDataSchema, successEnvelopeSchema } from "@avs/schemas";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const call = (path: string, init?: RequestInit, env = { APP_ENV: "test" }) =>
  worker.fetch(new Request(`https://example.test${path}`, init), env);

describe("GET /api/v1/health", () => {
  it("returns a valid success envelope", async () => {
    const res = await call(API_PATHS.health);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = successEnvelopeSchema(healthDataSchema).parse(await res.json());
    expect(body.data).toMatchObject({ status: "ok", environment: "test" });
  });

  it("rejects other methods with the standard error envelope", async () => {
    const res = await call(API_PATHS.health, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    const body = errorEnvelopeSchema.parse(await res.json());
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("routing", () => {
  it("returns a JSON 404 for unknown API routes and versions", async () => {
    for (const path of ["/api/v1/nope", "/api/v2/health", "/api"]) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe("NOT_FOUND");
    }
  });

  it("hands non-API requests to the static assets binding", async () => {
    const env = {
      APP_ENV: "test",
      ASSETS: { fetch: async () => new Response("<html>studio</html>") } as unknown as Fetcher,
    };
    const res = await call("/projects", undefined, env);
    expect(await res.text()).toBe("<html>studio</html>");
  });
});
