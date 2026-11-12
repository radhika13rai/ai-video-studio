import { API_PATHS } from "@avs/contracts";
import { errorEnvelopeSchema, healthDataSchema, successEnvelopeSchema } from "@avs/schemas";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const url = (path: string) => `https://example.test${path}`;
const healthBody = successEnvelopeSchema(healthDataSchema);

describe("GET /api/v1/health", () => {
  it("probes the local D1, R2 and workflow bindings", async () => {
    const res = await SELF.fetch(url(API_PATHS.health));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const { data } = healthBody.parse(await res.json());
    expect(data.status).toBe("ok");
    expect(data.environment).toBe("development");
    expect(data.bindings.database.status).toBe("ok");
    expect(data.bindings.storage.status).toBe("ok");
    expect(data.bindings.workflows.status).toBe("ok");
  });

  it("reports degraded, not a crash, when bindings are missing", async () => {
    const res = await worker.fetch(new Request(url(API_PATHS.health)), { APP_ENV: "test" });
    expect(res.status).toBe(200);
    const { data } = healthBody.parse(await res.json());
    expect(data.status).toBe("degraded");
    expect(data.bindings).toEqual({
      database: { status: "missing" },
      storage: { status: "missing" },
      workflows: { status: "missing" },
    });
  });

  it("reports a failing binding with its error", async () => {
    const brokenDb = {
      prepare: () => ({
        first: async () => {
          throw new Error("D1_ERROR: no such database");
        },
      }),
    } as unknown as D1Database;
    const res = await worker.fetch(new Request(url(API_PATHS.health)), { ...env, DB: brokenDb });
    const { data } = healthBody.parse(await res.json());
    expect(data.status).toBe("degraded");
    expect(data.bindings.database).toEqual({
      status: "error",
      detail: "D1_ERROR: no such database",
    });
  });

  it("rejects other methods with the standard error envelope", async () => {
    const res = await SELF.fetch(url(API_PATHS.health), { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("routing", () => {
  it("returns a JSON 404 for unknown API routes and versions", async () => {
    for (const path of ["/api/v1/nope", "/api/v2/health", "/api"]) {
      const res = await SELF.fetch(url(path));
      expect(res.status).toBe(404);
      expect(errorEnvelopeSchema.parse(await res.json()).error.code).toBe("NOT_FOUND");
    }
  });

  it("hands non-API requests to the static assets binding", async () => {
    const assets = { fetch: async () => new Response("<html>studio</html>") } as unknown as Fetcher;
    const res = await worker.fetch(new Request(url("/projects")), { ASSETS: assets });
    expect(await res.text()).toBe("<html>studio</html>");
  });
});
