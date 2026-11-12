import { describe, expect, it } from "vitest";
import { createProjectRequestSchema, healthDataSchema } from "./index";

describe("createProjectRequestSchema", () => {
  it("applies defaults", () => {
    const p = createProjectRequestSchema.parse({ title: " Smart watches ", prompt: "Make an ad" });
    expect(p).toMatchObject({
      title: "Smart watches",
      video_type: "auto",
      aspect_ratio: "9:16",
      duration_seconds: 30,
      target_platform: "youtube_shorts",
    });
  });

  it("rejects unknown video types and over-long videos", () => {
    const base = { title: "t", prompt: "p" };
    expect(createProjectRequestSchema.safeParse({ ...base, video_type: "hologram" }).success).toBe(
      false,
    );
    expect(createProjectRequestSchema.safeParse({ ...base, duration_seconds: 61 }).success).toBe(
      false,
    );
    expect(createProjectRequestSchema.safeParse({ title: "", prompt: "p" }).success).toBe(false);
  });
});

describe("healthDataSchema", () => {
  it("requires an ISO timestamp", () => {
    const bindings = {
      database: { status: "ok", latency_ms: 1 },
      storage: { status: "missing" },
      workflows: { status: "error", detail: "boom" },
    };
    const ok = { status: "degraded", service: "s", version: "1", environment: "test", bindings };
    expect(healthDataSchema.safeParse({ ...ok, timestamp: "yesterday" }).success).toBe(false);
    expect(healthDataSchema.safeParse({ ...ok, timestamp: new Date().toISOString() }).success).toBe(
      true,
    );
  });
});
