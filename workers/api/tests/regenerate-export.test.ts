import { API_PATHS } from "@avs/contracts";
import type { StoredTimeline } from "@avs/schemas";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { getLatestQualityReport, listAssets, requireProject, upsertUserByEmail } from "../src/db";
import { sniffMedia } from "../src/providers/media-bytes";
import { setMediaProvidersOverride } from "../src/providers/registry";
import { ProviderError, type MediaRequest, type SyncMediaProvider } from "../src/providers/types";
import { fakeFacts, makeProject, setTextModelOverride } from "./helpers";

afterEach(() => {
  setMediaProvidersOverride(null);
  setTextModelOverride(null);
});

const EMAIL = "regen@example.com";
const call = (path: string, init: RequestInit = {}, user = EMAIL) =>
  SELF.fetch(`https://example.test${path}`, {
    ...init,
    headers: { "x-dev-user": user, "content-type": "application/json", ...(init.headers ?? {}) },
  });
const fixture = (name: string) =>
  Uint8Array.from(atob((JSON.parse(env.TEST_MP4) as Record<string, string>)[name] ?? ""), (c) =>
    c.charCodeAt(0),
  );
const MP4 = fixture("sample-15s.mp4");
const PNG = (() => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  new DataView(b.buffer).setUint32(16, 64);
  new DataView(b.buffer).setUint32(20, 64);
  return b;
})();
const words = (n: number) => Array.from({ length: n }, () => "ocean").join(" ");
const SCRIPT = JSON.stringify({
  title: "Ocean",
  hook: "The ocean hides secrets.",
  segments: [1, 2, 3].map(() => ({ text: words(11) })),
  call_to_action: null,
});
const BOARD = JSON.stringify({
  scenes: [1, 2, 3].map((i) => ({
    description: `Glowing jellyfish ${["alpha", "bravo", "charlie"][i - 1]} in the deep`,
    visual_prompt: `Creature ${i}`,
    voiceover: `Line ${i} is spoken here.`,
    duration_seconds: 5,
    visual_type: "image",
  })),
});
const uniq = (b: string) => `${b}-${crypto.randomUUID().slice(0, 8)}`;

function imageProvider(behave: (req: MediaRequest) => Uint8Array | Error = () => PNG) {
  const p = {
    ...fakeFacts(),
    name: uniq("img"),
    capability: "image" as const,
    defaultPriority: 10,
    defaultDailyLimit: 1000,
    prompts: [] as string[],
    async generate(req: MediaRequest) {
      p.prompts.push((req as { prompt: string }).prompt);
      const r = behave(req);
      if (r instanceof Error) throw r;
      return { bytes: r, model: "fake", units: 1, unit_type: "images", ...sniffMedia(r)! };
    },
  };
  return p as SyncMediaProvider & { prompts: string[] };
}

function stockProvider() {
  let n = 0;
  const p = {
    ...fakeFacts(),
    name: uniq("stock"),
    capability: "video" as const,
    defaultPriority: 10,
    defaultDailyLimit: 1000,
    requests: [] as MediaRequest[],
    async generate(req: MediaRequest) {
      p.requests.push(req);
      n++;
      return {
        bytes: MP4,
        mime_type: "video/mp4",
        extension: "mp4",
        duration_seconds: 15,
        model: `fake:stock:${n}`,
        units: 1,
        unit_type: "clips",
        license: { source: "pexels", credit: `Video ${n}` },
      };
    },
  };
  return p as SyncMediaProvider & { requests: MediaRequest[] };
}

/** Produces a faceless video up to "Ready to render" (no workflow sleeps). */
async function produce(introspector: Awaited<ReturnType<typeof introspectWorkflow>>) {
  const replies = [SCRIPT, BOARD];
  setTextModelOverride({
    name: "fake:model",
    async generate() {
      return { text: replies.shift() ?? "" };
    },
  });
  const created = await call(API_PATHS.projects, {
    method: "POST",
    body: JSON.stringify({
      title: "Deep",
      prompt: "Facts about the deep sea",
      video_type: "faceless",
      duration_seconds: 15,
    }),
  });
  const projectId = ((await created.json()) as { data: { id: string } }).data.id;
  await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
  const [instance] = await introspector.get();
  await instance!.waitForStepResult({ name: "request-render" });
  await waitStatus(projectId, "awaiting_render");
  const user = await upsertUserByEmail(env.DB, EMAIL);
  return { projectId, userId: user.id, instance: instance! };
}

async function waitStatus(projectId: string, status: string) {
  await expect
    .poll(
      async () =>
        ((await (await call(API_PATHS.project(projectId))).json()) as { data: { status: string } })
          .data.status,
    )
    .toBe(status);
}

/** The browser's part of a render: start, upload the MP4, complete. */
async function renderInBrowser(projectId: string) {
  const m = (
    (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
      data: {
        render_request_id: string;
        render_attempt_token: string;
        scenes: { image_url: string | null; caption: string }[];
      };
    }
  ).data;
  const up = await call(API_PATHS.projectRenderUpload(projectId, m.render_request_id), {
    method: "POST",
    body: MP4,
    headers: { "content-type": "video/mp4", "x-render-attempt": m.render_attempt_token },
  });
  const asset = ((await up.json()) as { data: { id: string } }).data;
  await call(API_PATHS.projectRenderComplete(projectId), {
    method: "POST",
    headers: { "x-render-attempt": m.render_attempt_token },
    body: JSON.stringify({ render_request_id: m.render_request_id, asset_id: asset.id }),
  });
  return m;
}

const regenerate = (projectId: string, sceneId: string, body: unknown, user = EMAIL) =>
  call(
    `${API_PATHS.project(projectId)}/scenes/${sceneId}/regenerate`,
    { method: "POST", body: JSON.stringify(body) },
    user,
  );

describe("regenerating one scene in the editor", () => {
  it("makes a new image from an edited prompt and keeps earlier versions (up to 3, plus the one in use)", async () => {
    const image = imageProvider();
    setMediaProvidersOverride([image]);
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const { projectId, userId } = await produce(introspector);
    const timeline = (
      (await (await call(API_PATHS.projectTimeline(projectId))).json()) as { data: StoredTimeline }
    ).data;
    const clip = timeline.timeline.clips[0]!;
    const original = clip.image_asset_id!;
    // Save the timeline so it explicitly uses the original image.
    await call(API_PATHS.projectTimeline(projectId), {
      method: "PUT",
      body: JSON.stringify({ base_revision: 0, timeline: timeline.timeline }),
    });

    const made: string[] = [];
    for (let k = 1; k <= 4; k++) {
      const res = await regenerate(projectId, clip.scene_id, {
        what: "image",
        prompt: `A brighter jellyfish ${k}`,
      });
      expect(res.status).toBe(201);
      const asset = (
        (await res.json()) as {
          data: { asset: { id: string; asset_type: string; metadata: { prompt: string } } };
        }
      ).data.asset;
      expect(asset).toMatchObject({
        asset_type: "image",
        metadata: { prompt: `A brighter jellyfish ${k}` },
      });
      made.push(asset.id);
    }
    expect(image.prompts.slice(-4)).toEqual([1, 2, 3, 4].map((k) => `A brighter jellyfish ${k}`));
    const images = (await listAssets(env.DB, userId, projectId))
      .filter((a) => a.scene_id === clip.scene_id && a.asset_type === "image")
      .map((a) => a.id);
    // The oldest new version went; the original stays because the saved timeline uses it.
    expect(images.sort()).toEqual([original, made[1]!, made[2]!, made[3]!].sort());
  }, 30_000);

  it("finds another stock clip, skipping the ones the scene already has", async () => {
    const stock = stockProvider();
    setMediaProvidersOverride([imageProvider(), stock]);
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const { projectId } = await produce(introspector);
    const sceneId = (
      (await (await call(API_PATHS.projectTimeline(projectId))).json()) as { data: StoredTimeline }
    ).data.timeline.clips[1]!.scene_id;
    expect((await regenerate(projectId, sceneId, { what: "footage" })).status).toBe(201);
    expect((await regenerate(projectId, sceneId, { what: "footage" })).status).toBe(201);
    expect(stock.requests.map((r) => (r as { avoid?: string[] }).avoid)).toEqual([
      [],
      ["fake:stock:1"],
    ]);
    expect((stock.requests[0] as { prompt: string }).prompt).toBe("glowing jellyfish bravo deep");
  }, 30_000);

  it("explains failures, and is closed to others and before production", async () => {
    let fail = false;
    setMediaProvidersOverride([
      imageProvider(() =>
        fail ? new ProviderError("img", "allowance used up", "quota", false) : PNG,
      ),
    ]);
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const { projectId } = await produce(introspector);
    const sceneId = (
      (await (await call(API_PATHS.projectTimeline(projectId))).json()) as { data: StoredTimeline }
    ).data.timeline.clips[0]!.scene_id;
    fail = true;
    const res = await regenerate(projectId, sceneId, { what: "image" });
    expect(res.status).toBe(502);
    expect(
      ((await res.json()) as { error: { code: string; message: string } }).error,
    ).toMatchObject({
      code: "GENERATION_FAILED",
      message: expect.stringMatching(/quota – .*allowance used up/),
    });
    expect(
      (await regenerate(projectId, sceneId, { what: "image" }, "mallory@example.com")).status,
    ).toBe(404);
    expect((await regenerate(projectId, "nope", { what: "image" })).status).toBe(404);
    expect((await regenerate(projectId, sceneId, { what: "music" })).status).toBe(400);
    const user = await upsertUserByEmail(env.DB, EMAIL);
    const fresh = await makeProject(user.id);
    expect((await regenerate(fresh.id, sceneId, { what: "image" })).status).toBe(409);
  }, 30_000);
});

describe("exporting an edited video again", () => {
  it("renders a finished project's edited timeline in a render-only run, with its media", async () => {
    setMediaProvidersOverride([imageProvider()]);
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const { projectId, userId, instance } = await produce(introspector);
    expect((await call(`${API_PATHS.project(projectId)}/export`, { method: "POST" })).status).toBe(
      409,
    ); // render it directly
    await renderInBrowser(projectId);
    await instance.waitForStatus("complete");
    await waitStatus(projectId, "completed");

    // Edit: reverse the scenes and re-caption the first.
    const stored = (
      (await (await call(API_PATHS.projectTimeline(projectId))).json()) as { data: StoredTimeline }
    ).data;
    const clips = [...stored.timeline.clips].reverse();
    clips[0] = { ...clips[0]!, caption: "Edited opening" };
    const put = await call(API_PATHS.projectTimeline(projectId), {
      method: "PUT",
      body: JSON.stringify({ base_revision: 0, timeline: { ...stored.timeline, clips } }),
    });
    expect(put.status).toBe(200);

    await env.DB.prepare(
      `
      CREATE TRIGGER fail_workflow_run_insert
      BEFORE INSERT ON workflow_runs
      BEGIN
        SELECT RAISE(FAIL, 'simulated workflow run insert failure');
      END
    `,
    ).run();
    try {
      const failed = await call(`${API_PATHS.project(projectId)}/export`, {
        method: "POST",
      });
      expect(failed.status).toBe(503);
      expect((await requireProject(env.DB, userId, projectId)).status).toBe("completed");
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_workflow_run_insert").run();
    }

    const exp = await call(`${API_PATHS.project(projectId)}/export`, { method: "POST" });
    expect(exp.status).toBe(202);
    expect((await requireProject(env.DB, userId, projectId)).status).toBe("generating");
    // A second click while it runs is refused.
    expect((await call(`${API_PATHS.project(projectId)}/export`, { method: "POST" })).status).toBe(
      409,
    );
    const runs = await introspector.get();
    const exportRun = runs[runs.length - 1]!;
    await exportRun.waitForStepResult({ name: "request-render" });
    await waitStatus(projectId, "awaiting_render");

    // The new run made no media, but the manifest still has the scenes' pictures, in the edit's order.
    const m = await renderInBrowser(projectId);
    expect(m.scenes.map((s) => s.caption)[0]).toBe("Edited opening");
    expect(m.scenes.every((s) => s.image_url)).toBe(true);
    await exportRun.waitForStatus("complete");
    await waitStatus(projectId, "completed");
    const runCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM workflow_runs WHERE project_id = ?",
    )
      .bind(projectId)
      .first<{ n: number }>();
    expect(runCount?.n).toBe(2);
    const report = await getLatestQualityReport(env.DB, userId, projectId);
    expect(report?.overall_status).not.toBe("failed");
    // The edit survived the export (render-only runs don't reset the timeline).
    const after = (
      (await (await call(API_PATHS.projectTimeline(projectId))).json()) as { data: StoredTimeline }
    ).data;
    expect(after.revision).toBe(1);
  }, 60_000);
});
