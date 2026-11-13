import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("local Cloudflare bindings", () => {
  it("D1 runs queries", async () => {
    const row = await env.DB.prepare("SELECT 40 + 2 AS answer").first<{ answer: number }>();
    expect(row?.answer).toBe(42);
  });

  it("R2 stores and returns objects", async () => {
    await env.MEDIA.put("tests/hello.txt", "hello", {
      httpMetadata: { contentType: "text/plain" },
    });
    const obj = await env.MEDIA.get("tests/hello.txt");
    expect(await obj?.text()).toBe("hello");
    expect(obj?.httpMetadata?.contentType).toBe("text/plain");
  });
  // The production workflow itself is covered in tests/workflow.test.ts.
});
