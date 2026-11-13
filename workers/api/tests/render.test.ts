import { API_PATHS, FFMPEG_CORE_BASE } from "@avs/contracts";
import { renderManifestSchema } from "@avs/schemas";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setTextModelOverride } from "../src/ai/factory";
import { getLatestWorkflowRun, listAssets, requireProject, upsertUserByEmail } from "../src/db";
import { sniffMedia } from "../src/providers/media-bytes";
import { setMediaProvidersOverride } from "../src/providers/registry";
import type { MediaProvider } from "../src/providers/types";

const EMAIL = "renderer@example.com";
const call = (path: string, init: RequestInit = {}, user = EMAIL) =>
  SELF.fetch(`https://example.test${path}`, {
    ...init,
    headers: { "x-dev-user": user, ...(init.headers as Record<string, string> | undefined) },
  });
const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

const jpeg = () =>
  new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 4, 0, 4, 0, 3, 0, 0, 0, 0xff, 0xd9,
  ]);
const wav = () => {
  const b = new Uint8Array(44 + 800);
  const dv = new DataView(b.buffer);
  [..."RIFF"].forEach((c, i) => (b[i] = c.charCodeAt(0)));
  [..."WAVEfmt "].forEach((c, i) => (b[8 + i] = c.charCodeAt(0)));
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, 8000, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  [..."data"].forEach((c, i) => (b[36 + i] = c.charCodeAt(0)));
  dv.setUint32(40, 800, true);
  return b;
};
const provider = (
  name: string,
  capability: "image" | "voice",
  bytes: () => Uint8Array,
): MediaProvider => ({
  name: `${name}-${crypto.randomUUID().slice(0, 6)}`,
  capability,
  defaultPriority: 10,
  defaultDailyLimit: 100,
  async generate() {
    const b = bytes();
    return { bytes: b, model: "fake", units: 1, unit_type: "x", ...sniffMedia(b)! };
  },
});
// A tiny but real MP4 header: size + "ftyp" + brand.
const mp4 = () =>
  new Uint8Array([
    0,
    0,
    0,
    24,
    ...[..."ftypisom"].map((c) => c.charCodeAt(0)),
    0,
    0,
    2,
    0,
    ...[..."isomiso2"].map((c) => c.charCodeAt(0)),
    1,
    2,
    3,
  ]);

const words = (n: number) => Array.from({ length: n }, () => "ocean").join(" ");
const SCRIPT = JSON.stringify({
  title: "O",
  hook: "The ocean hides secrets.",
  segments: [1, 2, 3].map(() => ({ text: words(11) })),
  call_to_action: null,
});
const BOARD = JSON.stringify({
  scenes: [1, 2, 3].map((i) => ({
    description: `Scene ${i}`,
    visual_prompt: `Creature ${i}`,
    voiceover: `Line ${i} is spoken here.`,
    duration_seconds: 5,
    visual_type: i === 3 ? "text" : "image",
  })),
});

async function readyProject(user = EMAIL) {
  const replies = [SCRIPT, BOARD];
  setTextModelOverride({
    name: "fake:model",
    async generate() {
      return { text: replies.shift() ?? "" };
    },
  });
  setMediaProvidersOverride([provider("img", "image", jpeg), provider("voice", "voice", wav)]);
  const introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
  const created = await call(
    API_PATHS.projects,
    json({
      title: "Deep",
      prompt: "Facts about the deep sea",
      video_type: "faceless",
      duration_seconds: 15,
    }),
    user,
  );
  const projectId = ((await created.json()) as { data: { id: string } }).data.id;
  await call(API_PATHS.projectGenerate(projectId), { method: "POST" }, user);
  const [instance] = await introspector.get();
  await instance!.waitForStepResult({ name: "request-render" });
  await expect
    .poll(
      async () =>
        (
          (await (await call(API_PATHS.project(projectId), {}, user)).json()) as {
            data: { status: string };
          }
        ).data.status,
    )
    .toBe("awaiting_render");
  return { projectId, introspector, instance: instance! };
}

afterEach(() => {
  setTextModelOverride(null);
  setMediaProvidersOverride(null);
});

describe("browser render API", () => {
  it("serves a manifest, accepts the MP4 and resumes the workflow to completion", async () => {
    const { projectId, introspector, instance } = await readyProject();
    try {
      const start = await call(API_PATHS.projectRender(projectId), { method: "POST" });
      expect(start.status).toBe(200);
      const manifest = renderManifestSchema.parse(((await start.json()) as { data: unknown }).data);
      expect(manifest.project).toMatchObject({
        id: projectId,
        aspect_ratio: "9:16",
        duration_seconds: 15,
      });
      expect(manifest.scenes.map((s) => s.start_seconds)).toEqual([0, 5, 10]);
      expect(manifest.scenes[0]).toMatchObject({
        visual_type: "image",
        caption: "Line 1 is spoken here.",
      });
      expect(manifest.scenes[0]?.image_url).toMatch(/\/assets\/[0-9a-f-]+\/content$/);
      expect(manifest.scenes[2]?.image_url).toBeNull(); // text card
      expect(manifest.scenes[2]?.voice_url).toMatch(/content$/);
      // The manifest's media URLs work for the owner.
      const img = await call(manifest.scenes[0]!.image_url!);
      expect(img.headers.get("content-type")).toBe("image/jpeg");
      expect(
        (await requireProject(env.DB, (await upsertUserByEmail(env.DB, EMAIL)).id, projectId))
          .status,
      ).toBe("rendering");

      const upload = await call(
        API_PATHS.projectRenderUpload(projectId, manifest.render_request_id),
        {
          method: "POST",
          body: mp4(),
          headers: {
            "content-type": "video/mp4",
            "x-video-duration": "15",
            "x-video-encoder": "webcodecs",
          },
        },
      );
      expect(upload.status).toBe(201);
      const asset = (
        (await upload.json()) as {
          data: {
            id: string;
            asset_type: string;
            storage_key: string;
            metadata: Record<string, unknown>;
          };
        }
      ).data;
      expect(asset).toMatchObject({
        asset_type: "render",
        metadata: { duration_seconds: 15, encoder: "webcodecs" },
      });
      expect(asset.storage_key).toMatch(/\/final-[0-9a-f]{8}\.mp4$/);

      const complete = await call(
        API_PATHS.projectRenderComplete(projectId),
        json({ render_request_id: manifest.render_request_id, asset_id: asset.id }),
      );
      expect(complete.status).toBe(202);
      await instance.waitForStatus("complete");
      const user = await upsertUserByEmail(env.DB, EMAIL);
      expect((await requireProject(env.DB, user.id, projectId)).status).toBe("completed");
      expect((await getLatestWorkflowRun(env.DB, user.id, projectId))?.status).toBe("completed");

      const download = await call(`${API_PATHS.assetContent(projectId, asset.id)}?download=1`);
      expect(download.headers.get("content-type")).toBe("video/mp4");
      expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(mp4());
    } finally {
      await introspector.dispose();
    }
  }, 30_000);

  it("rejects uploads that aren't MP4, are for an old request, or come before the render starts", async () => {
    const { projectId, introspector } = await readyProject();
    try {
      const early = await call(API_PATHS.projectRenderUpload(projectId, "x"), {
        method: "POST",
        body: mp4(),
        headers: { "content-type": "video/mp4" },
      });
      expect(early.status).toBe(409);
      const manifest = (
        (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
          data: { render_request_id: string };
        }
      ).data;
      const wrongId = await call(API_PATHS.projectRenderUpload(projectId, "old-request"), {
        method: "POST",
        body: mp4(),
        headers: { "content-type": "video/mp4" },
      });
      expect(wrongId.status).toBe(409);
      const notMp4 = await call(
        API_PATHS.projectRenderUpload(projectId, manifest.render_request_id),
        { method: "POST", body: jpeg(), headers: { "content-type": "video/mp4" } },
      );
      expect(notMp4.status).toBe(400);
      const wrongType = await call(
        API_PATHS.projectRenderUpload(projectId, manifest.render_request_id),
        { method: "POST", body: mp4(), headers: { "content-type": "application/octet-stream" } },
      );
      expect(wrongType.status).toBe(415);
      const tooBig = await call(
        API_PATHS.projectRenderUpload(projectId, manifest.render_request_id),
        {
          method: "POST",
          body: mp4(),
          headers: { "content-type": "video/mp4", "content-length": String(200 * 1024 * 1024) },
        },
      );
      expect([413, 400]).toContain(tooBig.status);
      const badComplete = await call(
        API_PATHS.projectRenderComplete(projectId),
        json({ render_request_id: manifest.render_request_id, asset_id: "nope" }),
      );
      expect(badComplete.status).toBe(400);
      const mallory = await call(
        API_PATHS.projectRender(projectId),
        { method: "POST" },
        "mallory@example.com",
      );
      expect(mallory.status).toBe(404);
    } finally {
      await introspector.dispose();
    }
  }, 30_000);

  it("abort returns the project to 'Ready to render', and a new upload replaces the old video", async () => {
    const { projectId, introspector } = await readyProject();
    try {
      const m = (
        (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
          data: { render_request_id: string };
        }
      ).data;
      const up = (
        await call(API_PATHS.projectRenderUpload(projectId, m.render_request_id), {
          method: "POST",
          body: mp4(),
          headers: { "content-type": "video/mp4" },
        })
      ).status;
      expect(up).toBe(201);
      const abort = await call(API_PATHS.projectRenderAbort(projectId), { method: "POST" });
      expect(((await abort.json()) as { data: { status: string } }).data.status).toBe(
        "awaiting_render",
      );
      await call(API_PATHS.projectRender(projectId), { method: "POST" });
      await call(API_PATHS.projectRenderUpload(projectId, m.render_request_id), {
        method: "POST",
        body: mp4(),
        headers: { "content-type": "video/mp4" },
      });
      const user = await upsertUserByEmail(env.DB, EMAIL);
      expect(
        (await listAssets(env.DB, user.id, projectId)).filter((a) => a.asset_type === "render"),
      ).toHaveLength(1);
    } finally {
      await introspector.dispose();
    }
  }, 30_000);

  it("refuses to start a render for a project that isn't ready", async () => {
    const created = await call(API_PATHS.projects, json({ title: "T", prompt: "P" }));
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await call(API_PATHS.projectRender(id), { method: "POST" })).status).toBe(409);
  });
});

describe("FFmpeg core route", () => {
  it("serves the core from R2 publicly with long caching, and 404s otherwise", async () => {
    const missing = await SELF.fetch(`https://example.test${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`);
    expect(missing.status).toBe(404);
    await env.MEDIA.put(
      `vendor${FFMPEG_CORE_BASE.slice("/vendor".length)}/ffmpeg-core.wasm`,
      new Uint8Array([0, 97, 115, 109]),
    );
    const ok = await SELF.fetch(`https://example.test${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/wasm");
    expect(ok.headers.get("cache-control")).toMatch(/immutable/);
    // "../" is normalised away by the URL parser before routing, so it can't escape the folder:
    // the request no longer matches the FFmpeg route and gets the normal app page instead.
    const escaped = await SELF.fetch(`https://example.test${FFMPEG_CORE_BASE}/../../secret`);
    expect(escaped.headers.get("content-type")).not.toBe("application/wasm");
    expect((await SELF.fetch(`https://example.test${FFMPEG_CORE_BASE}/other.js`)).status).toBe(404);
  });
});
