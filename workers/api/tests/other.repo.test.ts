import { describe, expect, it } from "vitest";
import {
  createAsset,
  createQualityReport,
  createWorkflowRun,
  deleteAsset,
  getAsset,
  getLatestQualityReport,
  getLatestWorkflowRun,
  listAssets,
  listProvidersForCapability,
  listUsageForProject,
  recordUsage,
  replaceScenes,
  setProviderHealth,
  sumProviderUsageSince,
  updateWorkflowRun,
  upsertProvider,
} from "../src/db";
import { db, makeProject, makeUser } from "./helpers";

describe("assets", () => {
  it("records metadata under the project's R2 prefix, with ownership", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    const p = await makeProject(alice.id);
    const [scene] = await replaceScenes(db(), alice.id, p.id, [
      { scene_number: 1, description: "x" },
    ]);
    const a = await createAsset(db(), alice.id, p.id, {
      asset_type: "image",
      storage_key: `projects/${p.id}/scene-1.png`,
      mime_type: "image/png",
      file_size: 1234,
      scene_id: scene!.id,
      license: { source: "generated" },
    });
    expect(a).toMatchObject({
      asset_type: "image",
      license: { source: "generated" },
      metadata: {},
    });

    await expect(
      createAsset(db(), alice.id, p.id, {
        asset_type: "image",
        storage_key: `projects/${p.id}/scene-1.png`,
        mime_type: "image/png",
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    for (const bad of [
      `projects/other/x.png`,
      `projects/${p.id}/../x.png`,
      `projects/${p.id}/a b.png`,
    ]) {
      await expect(
        createAsset(db(), alice.id, p.id, {
          asset_type: "image",
          storage_key: bad,
          mime_type: "image/png",
        }),
      ).rejects.toMatchObject({ kind: "invalid_data" });
    }
    await expect(
      createAsset(db(), mallory.id, p.id, {
        asset_type: "image",
        storage_key: `projects/${p.id}/evil.png`,
        mime_type: "image/png",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(await getAsset(db(), mallory.id, a.id)).toBeNull();
    expect(await listAssets(db(), mallory.id, p.id)).toEqual([]);
    await expect(deleteAsset(db(), mallory.id, a.id)).rejects.toMatchObject({ kind: "not_found" });

    expect(await deleteAsset(db(), alice.id, a.id)).toEqual({ storage_key: a.storage_key });
    expect(await listAssets(db(), alice.id, p.id)).toEqual([]);
  });
});

describe("providers", () => {
  it("upserts and routes healthy-first then by priority", async () => {
    await upsertProvider(db(), { provider_name: "workers-ai", capability: "image", priority: 50 });
    await upsertProvider(db(), { provider_name: "alt", capability: "image", priority: 10 });
    await upsertProvider(db(), { provider_name: "off", capability: "image", enabled: false });
    expect((await listProvidersForCapability(db(), "image")).map((p) => p.provider_name)).toEqual([
      "alt",
      "workers-ai",
    ]);
    await setProviderHealth(db(), "workers-ai", "image", "healthy");
    await setProviderHealth(db(), "alt", "image", "down");
    expect((await listProvidersForCapability(db(), "image")).map((p) => p.provider_name)).toEqual([
      "workers-ai",
      "alt",
    ]);
    const again = await upsertProvider(db(), {
      provider_name: "alt",
      capability: "image",
      priority: 5,
      quota: { daily_limit: 100 },
    });
    expect(again).toMatchObject({
      priority: 5,
      quota: { daily_limit: 100 },
      health_status: "down",
    });
    expect(await listProvidersForCapability(db(), "image", { includeDisabled: true })).toHaveLength(
      3,
    );
  });

  it("refuses credentials in quota metadata", async () => {
    await expect(
      upsertProvider(db(), {
        provider_name: "x",
        capability: "text",
        quota: { api_key: "sk-123" },
      }),
    ).rejects.toMatchObject({ kind: "invalid_data" });
    await expect(setProviderHealth(db(), "nope", "text", "healthy")).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("workflow runs", () => {
  it("tracks steps, closes on a terminal status, and enforces ownership", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    const p = await makeProject(alice.id);
    const run = await createWorkflowRun(db(), alice.id, p.id, {
      workflow_name: "production-workflow",
      workflow_instance_id: "inst-1",
    });
    expect(run).toMatchObject({ status: "running", completed_at: null });
    const step = await updateWorkflowRun(db(), alice.id, run.id, { current_step: "storyboard" });
    expect(step).toMatchObject({ current_step: "storyboard", status: "running" });
    const failed = await updateWorkflowRun(db(), alice.id, run.id, {
      status: "failed",
      error_message: "provider down",
    });
    expect(failed).toMatchObject({ status: "failed", error_message: "provider down" });
    expect(failed.completed_at).not.toBeNull();
    await expect(
      updateWorkflowRun(db(), alice.id, run.id, { status: "running" }),
    ).rejects.toMatchObject({ kind: "invalid_state" });
    expect((await getLatestWorkflowRun(db(), alice.id, p.id))?.id).toBe(run.id);

    expect(await getLatestWorkflowRun(db(), mallory.id, p.id)).toBeNull();
    await expect(
      createWorkflowRun(db(), mallory.id, p.id, { workflow_name: "w" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("usage", () => {
  it("records per project and sums per provider for quotas", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const pa = await makeProject(alice.id);
    const pb = await makeProject(bob.id);
    const since = new Date(Date.now() - 1000).toISOString();
    await recordUsage(db(), alice.id, pa.id, {
      provider_name: "workers-ai",
      capability: "image",
      units_used: 2,
      unit_type: "images",
    });
    await recordUsage(db(), bob.id, pb.id, {
      provider_name: "workers-ai",
      capability: "image",
      units_used: 3,
      unit_type: "images",
    });
    expect(await sumProviderUsageSince(db(), "workers-ai", "image", since)).toEqual({
      units: 5,
      cost_usd: 0,
    });
    expect(await sumProviderUsageSince(db(), "workers-ai", "text", since)).toEqual({
      units: 0,
      cost_usd: 0,
    });
    expect(await listUsageForProject(db(), alice.id, pa.id)).toHaveLength(1);
    expect(await listUsageForProject(db(), bob.id, pa.id)).toEqual([]);
    await expect(
      recordUsage(db(), bob.id, pa.id, {
        provider_name: "x",
        capability: "text",
        units_used: 1,
        unit_type: "t",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      recordUsage(db(), alice.id, pa.id, {
        provider_name: "x",
        capability: "text",
        units_used: -1,
        unit_type: "t",
      }),
    ).rejects.toMatchObject({ kind: "invalid_data" });
  });
});

describe("quality reports", () => {
  it("stores validated JSON and returns the latest, with ownership", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    const p = await makeProject(alice.id);
    await createQualityReport(db(), alice.id, p.id, { overall_status: "warning", score: 60 });
    await new Promise((r) => setTimeout(r, 2));
    const r2 = await createQualityReport(db(), alice.id, p.id, {
      overall_status: "passed",
      score: 92.5,
      checks: { audio_levels: "ok" },
      recommendations: ["Shorten scene 3"],
    });
    expect(await getLatestQualityReport(db(), alice.id, p.id)).toEqual(r2);
    expect(await getLatestQualityReport(db(), mallory.id, p.id)).toBeNull();
    await expect(
      createQualityReport(db(), alice.id, p.id, { overall_status: "passed", score: 101 }),
    ).rejects.toMatchObject({ kind: "invalid_data" });
    await expect(
      createQualityReport(db(), mallory.id, p.id, { overall_status: "passed" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});
