import { API_PATHS } from "@avs/contracts";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { listAssets, listProviderJobs, requireProject, upsertUserByEmail } from "../src/db";
import { FalWanImageToVideo } from "../src/providers/fal";
import { sniffMedia } from "../src/providers/media-bytes";
import {
  codeProviders,
  hasCodeProvider,
  setMediaProvidersOverride,
} from "../src/providers/registry";
import type {
  AsyncMediaProvider,
  MediaRequest,
  PollResult,
  SyncMediaProvider,
} from "../src/providers/types";
import { fakeFacts, setTextModelOverride } from "./helpers";

afterEach(() => {
  setMediaProvidersOverride(null);
  setTextModelOverride(null);
});

const MP4 = Uint8Array.from(
  atob((JSON.parse(env.TEST_MP4) as Record<string, string>)["sample-2s.mp4"] ?? ""),
  (c) => c.charCodeAt(0),
);
const PNG = (() => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  new DataView(b.buffer).setUint32(16, 64);
  new DataView(b.buffer).setUint32(20, 64);
  return b;
})();
const i2v = (duration = 5): MediaRequest & { capability: "image_to_video" } => ({
  capability: "image_to_video",
  prompt: "A jellyfish drifting",
  aspect_ratio: "9:16",
  duration_seconds: duration,
  image: { bytes: PNG, mime_type: "image/png" },
});
const signal = new AbortController().signal;
const RESPONSE_URL = "https://queue.fal.run/fal-ai/wan-25-preview/requests/req-1";

/** A fetch scripted per URL: the latest matching rule answers. */
function fakeFetch(rules: [RegExp, () => Response][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const rule = rules.find(([re]) => re.test(url));
    if (!rule) throw new Error(`unexpected fetch ${url}`);
    return rule[1]();
  };
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("fal.ai Wan 2.5 image-to-video", () => {
  it("is paid, keyed, long-running and off by default", () => {
    const p = new FalWanImageToVideo(() => "k");
    expect(p).toMatchObject({
      tier: "paid",
      mode: "async",
      capability: "image_to_video",
      credential: "FAL_KEY",
      cost: { unit: "second", usd_per_unit: 0.1 },
    });
    setMediaProvidersOverride(null);
    const live = { ...env, AI_MEDIA_PROVIDER: "workers-ai" } as typeof env;
    expect(codeProviders(live).map((x) => x.name)).toContain("fal-wan25-i2v");
    expect(hasCodeProvider({ ...live, FAL_KEY: "k" } as typeof env, "image_to_video")).toBe(false);
    expect(
      hasCodeProvider(
        { ...live, FAL_KEY: "k", PAID_PROVIDERS: "on", PAID_DAILY_BUDGET_USD: "5" } as typeof env,
        "image_to_video",
      ),
    ).toBe(true);
  });

  it("submits the image as a data URI with the key and keeps the job's response URL", async () => {
    const { f, calls } = fakeFetch([
      [
        /^https:\/\/queue\.fal\.run\/fal-ai\/wan-25-preview\/image-to-video$/,
        () =>
          json({
            request_id: "req-1",
            response_url: RESPONSE_URL,
            status_url: `${RESPONSE_URL}/status`,
          }),
      ],
    ]);
    const p = new FalWanImageToVideo(() => "secret", f);
    expect(await p.submit(i2v(8), signal)).toEqual({ external_id: RESPONSE_URL });
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Key secret");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body).toMatchObject({
      prompt: "A jellyfish drifting",
      resolution: "720p",
      duration: "10",
    });
    expect(body.image_url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it("maps submit failures", async () => {
    const fail = (status: number) =>
      new FalWanImageToVideo(
        () => "k",
        fakeFetch([[/queue/, () => json({ detail: "x" }, status)]]).f,
      );
    await expect(fail(401).submit(i2v(), signal)).rejects.toMatchObject({ kind: "auth" });
    await expect(fail(402).submit(i2v(), signal)).rejects.toMatchObject({ kind: "quota" });
    await expect(fail(503).submit(i2v(), signal)).rejects.toMatchObject({ kind: "unavailable" });
    const odd = new FalWanImageToVideo(
      () => "k",
      fakeFetch([
        [/queue/, () => json({ request_id: "r", response_url: "https://evil.example/r" })],
      ]).f,
    );
    await expect(odd.submit(i2v(), signal)).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("polls status, then fetches and checks the finished video", async () => {
    let status = "IN_QUEUE";
    const { f } = fakeFetch([
      [/\/status$/, () => json({ status })],
      [/requests\/req-1$/, () => json({ video: { url: "https://v3.fal.media/files/out.mp4" } })],
      [/fal\.media/, () => new Response(MP4)],
    ]);
    const p = new FalWanImageToVideo(() => "k", f);
    expect(await p.poll(RESPONSE_URL, signal)).toEqual({ status: "running" });
    status = "IN_PROGRESS";
    expect(await p.poll(RESPONSE_URL, signal)).toEqual({ status: "running" });
    status = "COMPLETED";
    const done = (await p.poll(RESPONSE_URL, signal)) as Extract<
      PollResult,
      { status: "succeeded" }
    >;
    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ mime_type: "video/mp4", units: 5, unit_type: "seconds" });
  });

  it("reports failed jobs and refuses results from unexpected places", async () => {
    const poll = (result: () => Response) =>
      new FalWanImageToVideo(
        () => "k",
        fakeFetch([
          [/\/status$/, () => json({ status: "COMPLETED" })],
          [/requests\/req-1$/, result],
          [/evil|fal\.media/, () => new Response("<html>")],
        ]).f,
      ).poll(RESPONSE_URL, signal);
    expect(await poll(() => json({ detail: "boom" }, 500))).toMatchObject({
      status: "failed",
      retryable: true,
    });
    expect(await poll(() => json({ detail: "bad image" }, 422))).toMatchObject({
      status: "failed",
      retryable: false,
    });
    expect(await poll(() => json({ nothing: true }))).toMatchObject({ status: "failed" });
    expect(await poll(() => json({ video: { url: "https://evil.example/x.mp4" } }))).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/unexpected host/),
    });
    expect(await poll(() => json({ video: { url: "https://v3.fal.media/x.mp4" } }))).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/readable MP4/),
    });
    expect(
      await new FalWanImageToVideo(() => "k", fakeFetch([]).f).poll(
        "https://evil.example/r",
        signal,
      ),
    ).toMatchObject({ status: "failed", retryable: false });
  });
});

describe("animating scene images in production", () => {
  const EMAIL = "animate@example.com";
  const call = (path: string, init: RequestInit = {}) =>
    SELF.fetch(`https://example.test${path}`, {
      ...init,
      headers: { "x-dev-user": EMAIL, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  const words = (n: number) => Array.from({ length: n }, () => "ocean").join(" ");
  const SCRIPT = JSON.stringify({
    title: "Ocean",
    hook: "The ocean hides secrets.",
    segments: [1, 2, 3].map(() => ({ text: words(11) })),
    call_to_action: null,
  });
  const BOARD = JSON.stringify({
    scenes: [1, 2, 3].map((i) => ({
      description: `Scene ${i} in the deep`,
      visual_prompt: `Creature ${i}`,
      voiceover: `Line ${i}.`,
      duration_seconds: 5,
      visual_type: i === 2 ? "text" : "image",
    })),
  });
  const scripted = (...replies: string[]) => ({
    name: "fake:model",
    async generate() {
      const r = replies.shift();
      if (!r) throw new Error("none");
      return { text: r };
    },
  });
  const uniq = (b: string) => `${b}-${crypto.randomUUID().slice(0, 8)}`;
  const image = (): SyncMediaProvider => ({
    ...fakeFacts(),
    name: uniq("img"),
    capability: "image",
    defaultPriority: 10,
    defaultDailyLimit: 100,
    async generate() {
      return { bytes: PNG, model: "fake", units: 1, unit_type: "images", ...sniffMedia(PNG)! };
    },
  });
  function animator(tier: "free" | "paid"): AsyncMediaProvider & { submitted: MediaRequest[] } {
    const p = {
      ...fakeFacts(),
      mode: "async" as const,
      tier,
      name: uniq("anim"),
      capability: "image_to_video" as const,
      cost: { unit: "second" as const, usd_per_unit: 0.1, source: "t" },
      pollIntervalSeconds: 1,
      maxWaitSeconds: 60,
      defaultPriority: 10,
      defaultDailyLimit: 100,
      submitted: [] as MediaRequest[],
      polls: 0,
      async submit(r: MediaRequest) {
        p.submitted.push(r);
        return { external_id: `ext-${p.submitted.length}` };
      },
      async poll(): Promise<PollResult> {
        return ++p.polls % 2 === 1
          ? { status: "running" }
          : {
              status: "succeeded",
              result: {
                bytes: MP4,
                mime_type: "video/mp4",
                extension: "mp4",
                duration_seconds: 2,
                units: 5,
                unit_type: "seconds",
                model: "fake-i2v",
                license: { source: "generated", provider: p.name, model: "fake-i2v" },
              },
            };
      },
    };
    return p as AsyncMediaProvider & { submitted: MediaRequest[] };
  }

  async function produce(video_type: "cinematic" | "animation" = "cinematic") {
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
    });
    const created = await call(API_PATHS.projects, {
      method: "POST",
      body: JSON.stringify({
        title: "Deep",
        prompt: "Jellyfish film",
        video_type,
        duration_seconds: 15,
      }),
    });
    const projectId = ((await created.json()) as { data: { id: string } }).data.id;
    await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });
    const user = await upsertUserByEmail(env.DB, EMAIL);
    return { projectId, userId: user.id };
  }

  it("animates each generated image as a long-running job and keeps the image as fallback", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    const anim = animator("free");
    setMediaProvidersOverride([image(), anim]);
    const { projectId, userId } = await produce();
    const assets = await listAssets(env.DB, userId, projectId);
    expect(assets.map((a) => a.asset_type).sort()).toEqual(["image", "image", "video", "video"]);
    const clip = assets.find((a) => a.asset_type === "video")!;
    expect(clip.storage_key).toMatch(/scene-\d-video\.mp4$/);
    expect(clip.metadata).toMatchObject({ model: "fake-i2v" });
    expect(anim.submitted).toHaveLength(2);
    expect(anim.submitted[0]).toMatchObject({
      capability: "image_to_video",
      duration_seconds: 5,
      image: { mime_type: "image/png" },
    });
    const jobs = await listProviderJobs(env.DB, userId, projectId);
    expect(jobs.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    expect((await requireProject(env.DB, userId, projectId)).production_config.fallbacks).toEqual(
      [],
    );
    // The render manifest plays the clip, with the image kept as the fallback.
    const manifest = (
      (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
        data: {
          scenes: { video_url?: string; image_url: string | null; credit?: string | null }[];
        };
      }
    ).data;
    expect(manifest.scenes[0]).toMatchObject({
      video_url: expect.stringContaining("/assets/"),
      image_url: expect.stringContaining("/assets/"),
      credit: null,
    });
  }, 30_000);

  it("animates the images of animation-style projects too", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    const anim = animator("free");
    setMediaProvidersOverride([image(), anim]);
    const { projectId, userId } = await produce("animation");
    expect((await requireProject(env.DB, userId, projectId)).production_config.plan).toMatchObject({
      visual_style: "animation",
    });
    expect(anim.submitted).toHaveLength(2);
    const assets = await listAssets(env.DB, userId, projectId);
    expect(assets.map((a) => a.asset_type).sort()).toEqual(["image", "image", "video", "video"]);
    expect((await requireProject(env.DB, userId, projectId)).production_config.fallbacks).toEqual(
      [],
    );
  }, 30_000);

  it("never runs a paid animator while paid generation is off", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    const anim = animator("paid");
    setMediaProvidersOverride([image(), anim]);
    const { projectId, userId } = await produce();
    expect(anim.submitted).toEqual([]);
    expect((await listAssets(env.DB, userId, projectId)).map((a) => a.asset_type)).toEqual([
      "image",
      "image",
    ]);
  }, 30_000);
});

describe("motion notes", () => {
  it("counts scenes with real motion from footage or animation, and says why the rest don't", async () => {
    const { summarizeFallbacks } = await import("../src/workflows/media");
    const ok = { status: "ok" as const, asset_id: "a", provider: "p" };
    const skip = { status: "skipped" as const, reason: "-" };
    const notes = summarizeFallbacks("video", false, [
      {
        scene: 1,
        image: ok,
        voice: skip,
        video: { status: "fallback", reason: "no stock clip" },
        animated: ok,
      },
      { scene: 2, image: ok, voice: skip, video: ok, animated: skip },
      {
        scene: 3,
        image: ok,
        voice: skip,
        video: { status: "fallback", reason: "no stock clip" },
        animated: { status: "fallback", reason: "over today's budget" },
      },
    ]);
    expect(notes).toEqual([
      "2 of 3 scenes have real motion (stock footage or an animated image); the others use generated still images with motion effects (over today's budget).",
    ]);
  });

  it("reports animation-style motion and says how to get free motion when none is on", async () => {
    const { summarizeFallbacks } = await import("../src/workflows/media");
    const ok = { status: "ok" as const, asset_id: "a", provider: "p" };
    const skip = { status: "skipped" as const, reason: "-" };
    expect(
      summarizeFallbacks("animation", false, [
        { scene: 1, image: ok, voice: skip, video: skip, animated: ok },
        {
          scene: 2,
          image: ok,
          voice: skip,
          video: skip,
          animated: { status: "fallback", reason: "over today's budget" },
        },
      ]),
    ).toEqual([
      "1 of 2 scenes have real motion (an animated image); the others use generated still images with motion effects (over today's budget).",
    ]);
    expect(summarizeFallbacks("animation", false, [{ scene: 1, image: ok, voice: skip }])).toEqual([
      "No animation generator is switched on (paid image-to-video is off); scenes use generated still images with motion effects instead. For free real motion, ask for motion graphics or a Vox-style explainer.",
    ]);
    expect(
      summarizeFallbacks("animation", false, [{ scene: 1, image: ok, voice: skip, animated: ok }]),
    ).toEqual([]);
  });
});
