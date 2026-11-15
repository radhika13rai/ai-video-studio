import { API_PATHS, RENDER_ATTEMPT_HEADER } from "@avs/contracts";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setTextModelOverride } from "./helpers";
import { listAssets, listJobs, listScenes, requireProject, upsertUserByEmail } from "../src/db";
import { sniffMedia } from "../src/providers/media-bytes";
import { setMediaProvidersOverride } from "../src/providers/registry";
import { ProviderError, type MediaProvider } from "../src/providers/types";
import { plausibleRenderPlan, runQualityChecks } from "../src/quality/check";
import { bytesReader, inspectMp4, Mp4Error, r2Reader } from "../src/quality/mp4";

const fixture = (name: string) =>
  Uint8Array.from(atob((JSON.parse(env.TEST_MP4) as Record<string, string>)[name] ?? ""), (c) =>
    c.charCodeAt(0),
  );

describe("MP4 inspection", () => {
  it("reads tracks, codecs, size, duration and fast start from a real render", async () => {
    const b = fixture("sample-2s.mp4");
    const info = await inspectMp4(bytesReader(b), b.length);
    expect(info.brand).toBe("isom");
    expect(info.durationSeconds).toBeCloseTo(2, 1);
    expect(info.fastStart).toBe(true);
    expect(info.hasMdat).toBe(true);
    expect(info.tracks.find((t) => t.kind === "video")).toMatchObject({
      codec: "avc1",
      width: 720,
      height: 1280,
    });
    expect(info.tracks.find((t) => t.kind === "audio")).toMatchObject({
      codec: "mp4a",
      sampleRate: 48000,
      channels: 2,
    });
  });

  it("notices a missing audio track and an index at the end", async () => {
    const silent = fixture("sample-noaudio.mp4");
    expect(
      (await inspectMp4(bytesReader(silent), silent.length)).tracks.map((t) => t.kind),
    ).toEqual(["video"]);
    const late = fixture("sample-moov-end.mp4");
    expect((await inspectMp4(bytesReader(late), late.length)).fastStart).toBe(false);
  });

  it("reads from R2 with ranged reads", async () => {
    const b = fixture("sample-2s.mp4");
    await env.MEDIA.put("qc/test.mp4", b);
    const info = await inspectMp4(r2Reader(env.MEDIA, "qc/test.mp4"), b.length);
    expect(info.tracks).toHaveLength(2);
  });

  it("rejects files that aren't MP4s or are truncated", async () => {
    const junk = new TextEncoder().encode("this is definitely not a video file at all");
    await expect(inspectMp4(bytesReader(junk), junk.length)).rejects.toBeInstanceOf(Mp4Error);
    const b = fixture("sample-moov-end.mp4");
    const cut = b.subarray(0, b.length - 2000); // moov is at the end, so cutting breaks it
    await expect(inspectMp4(bytesReader(cut), cut.length)).rejects.toBeInstanceOf(Mp4Error);
  });
});

describe("quality checks", () => {
  const scenes = [
    {
      id: "s1",
      scene_number: 1,
      visual_type: "image" as const,
      voiceover: "One.",
      duration_seconds: 1,
    },
    {
      id: "s2",
      scene_number: 2,
      visual_type: "text" as const,
      voiceover: "Two.",
      duration_seconds: 1,
    },
  ];
  const assets = [
    { scene_id: "s1", asset_type: "image" as const },
    { scene_id: "s1", asset_type: "voiceover" as const },
    { scene_id: "s2", asset_type: "voiceover" as const },
  ];
  const video = (name: string) => {
    const b = fixture(name);
    return { read: bytesReader(b), size: b.length };
  };

  it("passes a good render (only the tiny test file's low bitrate is flagged)", async () => {
    const r = await runQualityChecks({
      project: { aspect_ratio: "9:16", duration_seconds: 2 },
      scenes,
      assets,
      narrationPlanned: true,
      video: video("sample-2s.mp4"),
    });
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({
      file: "pass",
      codec: "pass",
      resolution: "pass",
      audio: "pass",
      duration: "pass",
      faststart: "pass",
      images: "pass",
      narration: "pass",
    });
    expect(r.overall_status).toBe("warning"); // bitrate of a 30 KB test clip
    expect(r.score).toBe(92);
  });

  it("fails a silent video when narration was generated, and a wrong length", async () => {
    const silent = await runQualityChecks({
      project: { aspect_ratio: "9:16", duration_seconds: 2 },
      scenes,
      assets,
      narrationPlanned: true,
      video: video("sample-noaudio.mp4"),
    });
    expect(silent.overall_status).toBe("failed");
    expect(silent.checks.find((c) => c.id === "audio")).toMatchObject({ status: "fail" });
    const short = await runQualityChecks({
      project: { aspect_ratio: "9:16", duration_seconds: 30 },
      scenes,
      assets,
      narrationPlanned: true,
      video: video("sample-2s.mp4"),
    });
    expect(short.checks.find((c) => c.id === "duration")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/planned 30 s/),
    });
  });

  it("doesn't fail a render whose scenes were lengthened to fit the narration", async () => {
    // 15 s file, brief planned 10 s, renderer planned 15 s after fitting the voice.
    const r = await runQualityChecks({
      project: { aspect_ratio: "9:16", duration_seconds: 10 },
      scenes,
      assets,
      narrationPlanned: true,
      renderPlanSeconds: 15,
      video: video("sample-15s.mp4"),
    });
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId.render_length).toMatchObject({ status: "pass" });
    expect(byId.duration).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/lengthened to fit the narration/),
    });
    expect(r.overall_status).not.toBe("failed");
  });

  it("still fails a truncated render against what the renderer planned", async () => {
    // 2 s file, but the renderer planned 4 s (within 2× of the 3 s brief): truncated.
    const r = await runQualityChecks({
      project: { aspect_ratio: "9:16", duration_seconds: 3 },
      scenes,
      assets,
      narrationPlanned: true,
      renderPlanSeconds: 4,
      video: video("sample-2s.mp4"),
    });
    expect(r.checks.find((c) => c.id === "render_length")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/the render planned 4\.00 s/),
    });
    expect(r.overall_status).toBe("failed");
  });

  it("ignores an implausible reported plan and falls back to the brief", async () => {
    expect(plausibleRenderPlan(undefined, 30)).toBeNull();
    expect(plausibleRenderPlan(Number.NaN, 30)).toBeNull();
    expect(plausibleRenderPlan(10, 30)).toBeNull(); // under half the brief
    expect(plausibleRenderPlan(75, 30)).toBeNull(); // over twice the brief
    expect(plausibleRenderPlan(95, 60)).toBeNull(); // over 1.5× the maximum video length
    expect(plausibleRenderPlan(36, 30)).toBe(36);
    const r = await runQualityChecks({
      project: { aspect_ratio: "9:16", duration_seconds: 30 },
      scenes,
      assets,
      narrationPlanned: true,
      renderPlanSeconds: 2, // a client claiming it planned 2 s doesn't excuse a 2 s video
      video: video("sample-2s.mp4"),
    });
    expect(r.checks.find((c) => c.id === "render_length")).toBeUndefined();
    expect(r.checks.find((c) => c.id === "duration")).toMatchObject({ status: "fail" });
  });

  it("warns on wrong resolution, no fast start and missing scene media, with advice", async () => {
    const r = await runQualityChecks({
      project: { aspect_ratio: "16:9", duration_seconds: 2 },
      scenes,
      assets: [{ scene_id: "s2", asset_type: "voiceover" }],
      narrationPlanned: true,
      video: video("sample-moov-end.mp4"),
    });
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({
      resolution: "warn",
      faststart: "warn",
      images: "warn",
      narration: "warn",
    });
    expect(r.recommendations).toEqual(
      expect.arrayContaining([expect.stringMatching(/Scene 1 has no image; use "Retry media"/)]),
    );
  });

  it("fails when there is no video at all", async () => {
    const r = await runQualityChecks({
      project: { aspect_ratio: "9:16", duration_seconds: 2 },
      scenes,
      assets,
      narrationPlanned: false,
      video: null,
    });
    expect(r).toMatchObject({ overall_status: "failed", score: 70 });
  });
});

// --- Workflow-level: QC report after render, and retrying a single scene ---------------------

const EMAIL = "qc@example.com";
// Like the browser, remember the attempt token from the last render start and send it on
// upload/complete/abort. A test can override it by passing the header itself.
let attemptToken = "";
const call = async (path: string, init: RequestInit = {}, user = EMAIL) => {
  const res = await SELF.fetch(`https://example.test${path}`, {
    ...init,
    headers: {
      "x-dev-user": user,
      ...(attemptToken ? { [RENDER_ATTEMPT_HEADER]: attemptToken } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (init.method === "POST" && /\/render(\?|$)/.test(path) && res.ok) {
    const body = (await res.clone().json()) as { data?: { render_attempt_token?: string } };
    attemptToken = body.data?.render_attempt_token ?? attemptToken;
  }
  return res;
};
const jpeg = () =>
  new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 4, 0, 4, 0, 3, 0, 0, 0, 0xff, 0xd9,
  ]);
const wav = () => {
  const b = new Uint8Array(844);
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
function provider(
  capability: "image" | "voice",
  behave: () => Uint8Array | Error,
): MediaProvider & { calls: number } {
  const p = {
    name: `${capability}-${crypto.randomUUID().slice(0, 6)}`,
    capability,
    defaultPriority: 10,
    defaultDailyLimit: 100,
    calls: 0,
    async generate() {
      p.calls++;
      const r = behave();
      if (r instanceof Error) throw r;
      return { bytes: r, model: "fake", units: 1, unit_type: "x", ...sniffMedia(r)! };
    },
  };
  return p;
}
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
    visual_type: "image",
  })),
});

afterEach(() => {
  setTextModelOverride(null);
  setMediaProvidersOverride(null);
});

async function toReadyToRender(imageBehaviour: () => Uint8Array | Error) {
  const replies = [SCRIPT, BOARD];
  setTextModelOverride({
    name: "fake:model",
    async generate() {
      return { text: replies.shift() ?? "" };
    },
  });
  const image = provider("image", imageBehaviour);
  setMediaProvidersOverride([image, provider("voice", wav)]);
  const introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
  const created = await call(API_PATHS.projects, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  await expect
    .poll(
      async () =>
        ((await (await call(API_PATHS.project(projectId))).json()) as { data: { status: string } })
          .data.status,
    )
    .toBe("awaiting_render");
  return { projectId, introspector, instance: instance!, image };
}

describe("quality report and scene retry in production", () => {
  it("writes a quality report after the render and completes", async () => {
    const { projectId, introspector, instance } = await toReadyToRender(jpeg);
    try {
      const m = (
        (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
          data: { render_request_id: string };
        }
      ).data;
      const up = await call(API_PATHS.projectRenderUpload(projectId, m.render_request_id), {
        method: "POST",
        body: fixture("sample-15s.mp4"),
        headers: { "content-type": "video/mp4" },
      });
      const asset = (
        (await up.json()) as { data: { id: string; metadata: { duration_seconds: number } } }
      ).data;
      expect(asset.metadata.duration_seconds).toBe(15); // measured from the file, not trusted from the client
      await call(API_PATHS.projectRenderComplete(projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ render_request_id: m.render_request_id, asset_id: asset.id }),
      });
      await instance.waitForStatus("complete");
      expect(await instance.getOutput()).toMatchObject({ status: "completed" });
      const q = (
        (await (await call(API_PATHS.projectQuality(projectId))).json()) as {
          data: {
            overall_status: string;
            score: number;
            checks: { items: { id: string; status: string }[] };
          };
        }
      ).data;
      expect(["passed", "warning"]).toContain(q.overall_status);
      const byId = Object.fromEntries(q.checks.items.map((c) => [c.id, c.status]));
      expect(byId).toMatchObject({
        file: "pass",
        duration: "pass",
        audio: "pass",
        images: "pass",
        narration: "pass",
      });
    } finally {
      await introspector.dispose();
    }
  }, 30_000);

  it("rejects an upload whose MP4 structure is broken", async () => {
    const { projectId, introspector } = await toReadyToRender(jpeg);
    try {
      const m = (
        (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
          data: { render_request_id: string };
        }
      ).data;
      const b = fixture("sample-moov-end.mp4");
      const res = await call(API_PATHS.projectRenderUpload(projectId, m.render_request_id), {
        method: "POST",
        body: b.subarray(0, b.length - 2000),
        headers: { "content-type": "video/mp4" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /damaged/,
      );
    } finally {
      await introspector.dispose();
    }
  }, 30_000);

  it("retries only the failed scene's media and clears the fallback note", async () => {
    let quota = true;
    const { projectId, introspector, image } = await toReadyToRender(() =>
      quota
        ? new ProviderError("img", "Workers AI daily free allowance is used up.", "quota", false)
        : jpeg(),
    );
    try {
      const user = await upsertUserByEmail(env.DB, EMAIL);
      let project = await requireProject(env.DB, user.id, projectId);
      expect((project.production_config.fallbacks as string[])[0]).toMatch(
        /3 of 3 scenes have no generated image/,
      );
      const scenes = await listScenes(env.DB, user.id, projectId);
      const voiceBefore = (await listAssets(env.DB, user.id, projectId))
        .filter((a) => a.asset_type === "voiceover")
        .map((a) => a.id)
        .sort();

      quota = false; // quota is back
      const callsBefore = image.calls;
      const res = await call(API_PATHS.sceneRetryMedia(projectId, scenes[1]!.id), {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { image: { status: string }; fallbacks: string[] };
      };
      expect(body.data.image.status).toBe("ok");
      expect(body.data.fallbacks[0]).toMatch(/2 of 3 scenes have no generated image/);
      expect(image.calls - callsBefore).toBe(1); // only this scene was regenerated

      const assets = await listAssets(env.DB, user.id, projectId);
      expect(assets.filter((a) => a.asset_type === "image").map((a) => a.scene_id)).toEqual([
        scenes[1]!.id,
      ]);
      // Scene 2's narration was regenerated too; the other scenes' narration is untouched.
      const voiceAfter = assets.filter((a) => a.asset_type === "voiceover");
      expect(
        voiceAfter
          .filter((a) => voiceBefore.includes(a.id))
          .map((a) => a.scene_id)
          .sort(),
      ).toEqual([scenes[0]!.id, scenes[2]!.id].sort());
      project = await requireProject(env.DB, user.id, projectId);
      expect(project.status).toBe("awaiting_render");
      const retryJobs = (await listJobs(env.DB, user.id, projectId)).filter((j) =>
        j.job_type.startsWith("regenerate_"),
      );
      expect(retryJobs.map((j) => j.status)).toEqual(["completed", "completed"]);

      expect(
        (
          await call(
            API_PATHS.sceneRetryMedia(projectId, scenes[1]!.id),
            { method: "POST" },
            "mallory@example.com",
          )
        ).status,
      ).toBe(404);
      expect(
        (await call(API_PATHS.sceneRetryMedia(projectId, "no-such-scene"), { method: "POST" }))
          .status,
      ).toBe(404);
    } finally {
      await introspector.dispose();
    }
  }, 30_000);

  it("refuses to retry scenes outside 'Ready to render'", async () => {
    const created = await call(API_PATHS.projects, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "T", prompt: "P" }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await call(API_PATHS.sceneRetryMedia(id, "x"), { method: "POST" })).status).toBe(409);
  });
});
