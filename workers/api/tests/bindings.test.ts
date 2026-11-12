import { env, introspectWorkflowInstance } from "cloudflare:test";
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

  it("the production workflow runs and completes", async () => {
    await using instance = await introspectWorkflowInstance(env.PRODUCTION_WORKFLOW, "wf-test-1");
    await env.PRODUCTION_WORKFLOW.create({ id: "wf-test-1", params: { projectId: "project-1" } });
    await expect(instance.waitForStepResult({ name: "validate-input" })).resolves.toBe("project-1");
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  });
});
