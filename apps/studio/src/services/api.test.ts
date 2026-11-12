import { describe, expect, it } from "vitest";
import { ApiClientError, getHealth } from "./api";

const respond = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("getHealth", () => {
  it("returns validated health data", async () => {
    const data = {
      status: "ok",
      service: "ai-video-studio-api",
      version: "0.1.0",
      environment: "test",
      timestamp: new Date().toISOString(),
    };
    await expect(getHealth(respond({ success: true, data }))).resolves.toEqual(data);
  });

  it("surfaces API errors with their code", async () => {
    const error = { code: "RATE_LIMITED", message: "Slow down.", retryable: true };
    await expect(getHealth(respond({ success: false, error }, 429))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
  });

  it("rejects malformed and unreachable responses", async () => {
    await expect(getHealth(respond({ hello: "world" }))).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(getHealth(down)).rejects.toBeInstanceOf(ApiClientError);
  });
});
