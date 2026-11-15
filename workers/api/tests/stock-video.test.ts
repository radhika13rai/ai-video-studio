import { API_PATHS } from "@avs/contracts";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { listAssets, listJobs, requireProject, upsertUserByEmail } from "../src/db";
import { sniffMedia } from "../src/providers/media-bytes";
import { pickFile, PexelsStockVideo, rankVideos, stockQuery } from "../src/providers/pexels";
import { setMediaProvidersOverride } from "../src/providers/registry";
import type { MediaRequest, SyncMediaProvider } from "../src/providers/types";
import { fakeFacts, setTextModelOverride } from "./helpers";

afterEach(() => {
  setMediaProvidersOverride(null);
  setTextModelOverride(null);
});

const fixture = (name: string) =>
  Uint8Array.from(atob((JSON.parse(env.TEST_MP4) as Record<string, string>)[name] ?? ""), (c) =>
    c.charCodeAt(0),
  );
const MP4 = fixture("sample-2s.mp4");

const pexelsVideo = (over: Record<string, unknown> = {}) => ({
  id: 42,
  width: 1080,
  height: 1920,
  duration: 8,
  url: "https://www.pexels.com/video/jellyfish-42/",
  user: { name: "Ann Diver", url: "https://www.pexels.com/@ann" },
  video_files: [
    { file_type: "video/mp4", width: 2160, height: 3840, link: "https://videos.pexels.com/4k.mp4" },
    { file_type: "video/mp4", width: 720, height: 1280, link: "https://videos.pexels.com/hd.mp4" },
    { file_type: "video/mp4", width: 360, height: 640, link: "https://videos.pexels.com/sd.mp4" },
  ],
  ...over,
});

const req: MediaRequest & { capability: "video" } = {
  capability: "video",
  prompt: "jellyfish ocean",
  aspect_ratio: "9:16",
  duration_seconds: 5,
};

/** A fetch that answers the search and the download from scripted responses. */
function fakeFetch(search: unknown, opts: { status?: number; download?: Response } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.startsWith("https://api.pexels.com/"))
      return new Response(JSON.stringify(search), { status: opts.status ?? 200 });
    const r =
      opts.download ?? new Response(MP4, { headers: { "content-length": String(MP4.length) } });
    return r;
  };
  return { f, calls };
}

const signal = new AbortController().signal;

describe("Pexels stock video", () => {
  it("turns scene descriptions into short search terms", () => {
    expect(stockQuery("A glowing jellyfish drifts through the dark deep ocean at night!")).toBe(
      "glowing jellyfish drifts through dark deep",
    );
    expect(stockQuery("the of and")).toBe("");
  });

  it("prefers the right orientation, a long enough clip and a ~720p file", () => {
    const wide = pexelsVideo({ id: 1, width: 1920, height: 1080 });
    const short = pexelsVideo({ id: 2, duration: 3 });
    const good = pexelsVideo({ id: 3 });
    expect(rankVideos([wide, short, good] as never, "9:16", 5).map((v) => v.id)).toEqual([3, 2, 1]);
    expect(pickFile(good as never)?.link).toBe("https://videos.pexels.com/hd.mp4");
  });

  it("searches with the key, downloads the clip and records the credit", async () => {
    const { f, calls } = fakeFetch({ videos: [{ broken: true }, pexelsVideo()] });
    const p = new PexelsStockVideo(() => "test-key", f);
    const r = await p.generate(req, signal);
    const search = new URL(calls[0]!.url);
    expect(search.searchParams.get("query")).toBe("jellyfish ocean");
    expect(search.searchParams.get("orientation")).toBe("portrait");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe("test-key");
    expect(calls[1]!.url).toBe("https://videos.pexels.com/hd.mp4");
    expect(r).toMatchObject({
      mime_type: "video/mp4",
      extension: "mp4",
      width: 720,
      height: 1280,
      units: 1,
      model: "pexels:42",
      license: {
        source: "pexels",
        author: "Ann Diver",
        credit: "Video by Ann Diver on Pexels",
        page_url: "https://www.pexels.com/video/jellyfish-42/",
      },
    });
    expect(r.duration_seconds).toBeCloseTo(2, 0);
  });

  it("refuses unknown hosts, oversized or broken clips, and maps errors", async () => {
    const offsite = pexelsVideo({
      video_files: [
        { file_type: "video/mp4", width: 720, height: 1280, link: "https://evil.example/x.mp4" },
      ],
    });
    await expect(
      new PexelsStockVideo(() => "k", fakeFetch({ videos: [offsite] }).f).generate(req, signal),
    ).rejects.toMatchObject({ kind: "unsupported" });

    const huge = new Response(MP4, { headers: { "content-length": String(40 * 1024 * 1024) } });
    await expect(
      new PexelsStockVideo(
        () => "k",
        fakeFetch({ videos: [pexelsVideo()] }, { download: huge }).f,
      ).generate(req, signal),
    ).rejects.toMatchObject({ kind: "bad_response", message: expect.stringMatching(/too large/) });

    const junk = new Response("<html>not a video</html>");
    await expect(
      new PexelsStockVideo(
        () => "k",
        fakeFetch({ videos: [pexelsVideo()] }, { download: junk }).f,
      ).generate(req, signal),
    ).rejects.toMatchObject({ kind: "bad_response" });

    await expect(
      new PexelsStockVideo(() => "k", fakeFetch({}, { status: 401 }).f).generate(req, signal),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
    await expect(
      new PexelsStockVideo(() => "k", fakeFetch({}, { status: 429 }).f).generate(req, signal),
    ).rejects.toMatchObject({ kind: "quota" });
    await expect(
      new PexelsStockVideo(() => "k", fakeFetch({ videos: [] }).f).generate(req, signal),
    ).rejects.toMatchObject({
      kind: "unsupported",
      message: expect.stringMatching(/no stock clip/),
    });
  });

  it("declares itself free, keyed, commercial-use and video-only", () => {
    const p = new PexelsStockVideo(() => null);
    expect(p).toMatchObject({
      tier: "free",
      capability: "video",
      credential: "PEXELS_API_KEY",
      commercialUse: true,
    });
  });
});

describe("video-style productions use stock footage", () => {
  const EMAIL = "footage@example.com";
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
      description: `Glowing jellyfish ${["alpha", "bravo", "charlie"][i - 1]} in the deep sea`,
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
  const PNG = (() => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
    new DataView(b.buffer).setUint32(16, 64);
    new DataView(b.buffer).setUint32(20, 64);
    return b;
  })();
  const imageFake = (): SyncMediaProvider & { calls: number } => {
    const p = {
      ...fakeFacts(),
      name: uniq("img"),
      capability: "image" as const,
      defaultPriority: 10,
      defaultDailyLimit: 100,
      calls: 0,
      async generate() {
        p.calls++;
        return { bytes: PNG, model: "fake", units: 1, unit_type: "images", ...sniffMedia(PNG)! };
      },
    };
    return p as SyncMediaProvider & { calls: number };
  };
  const videoFake = (
    ok: (prompt: string) => boolean,
  ): SyncMediaProvider & { prompts: string[] } => {
    const p = {
      ...fakeFacts(),
      name: uniq("stock"),
      capability: "video" as const,
      defaultPriority: 10,
      defaultDailyLimit: 100,
      prompts: [] as string[],
      async generate(r: MediaRequest) {
        const prompt = (r as { prompt: string }).prompt;
        p.prompts.push(prompt);
        if (!ok(prompt)) {
          const { ProviderError } = await import("../src/providers/types");
          throw new ProviderError(
            p.name,
            `no stock clip found for "${prompt}"`,
            "unsupported",
            false,
          );
        }
        return {
          bytes: MP4,
          mime_type: "video/mp4",
          extension: "mp4",
          width: 720,
          height: 1280,
          duration_seconds: 2,
          model: "fake:stock",
          units: 1,
          unit_type: "clips",
          license: { source: "pexels", credit: "Video by Ann Diver on Pexels" },
        };
      },
    };
    return p as SyncMediaProvider & { prompts: string[] };
  };

  async function produce(videoType: string) {
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const created = await call(API_PATHS.projects, {
      method: "POST",
      body: JSON.stringify({
        title: "Deep",
        prompt: "Jellyfish ad",
        video_type: videoType,
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

  it("finds a clip per picture scene instead of generating an image, with credit in the manifest", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    const image = imageFake();
    const video = videoFake(() => true);
    setMediaProvidersOverride([image, video]);
    const { projectId, userId } = await produce("advertisement");

    const assets = await listAssets(env.DB, userId, projectId);
    expect(assets.map((a) => a.asset_type).sort()).toEqual(["video", "video"]); // scene 2 is a text card
    expect(assets[0]!.storage_key).toMatch(/scene-\d-video\.mp4$/);
    expect(assets[0]!.license).toMatchObject({ credit: "Video by Ann Diver on Pexels" });
    expect(image.calls).toBe(0);
    expect(video.prompts[0]).toBe("glowing jellyfish alpha deep sea");
    const jobs = await listJobs(env.DB, userId, projectId);
    expect(jobs.filter((j) => j.agent_name === "footage-scout").map((j) => j.job_type)).toEqual([
      "find_stock_video",
      "find_stock_video",
    ]);
    expect((await requireProject(env.DB, userId, projectId)).production_config.fallbacks).toEqual(
      [],
    );

    const manifest = (
      (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
        data: {
          scenes: { video_url?: string | null; credit?: string | null; image_url: string | null }[];
        };
      }
    ).data;
    expect(manifest.scenes[0]).toMatchObject({
      image_url: null,
      credit: "Video by Ann Diver on Pexels",
      video_url: expect.stringContaining("/assets/"),
    });
    expect(manifest.scenes[1]?.video_url).toBeUndefined();
  }, 30_000);

  it("falls back to a generated image when no clip is found, and says so", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    const image = imageFake();
    const video = videoFake((q) => q.includes("alpha"));
    setMediaProvidersOverride([image, video]);
    const { projectId, userId } = await produce("cinematic");
    const types = (await listAssets(env.DB, userId, projectId)).map((a) => a.asset_type).sort();
    expect(types).toEqual(["image", "video"]);
    expect(image.calls).toBe(1);
    const notes = (await requireProject(env.DB, userId, projectId)).production_config
      .fallbacks as string[];
    expect(notes[0]).toMatch(/1 of 2 scenes use stock footage from Pexels; .*no stock clip found/);
  }, 30_000);

  it("image-style projects never look for footage", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    const image = imageFake();
    const video = videoFake(() => true);
    setMediaProvidersOverride([image, video]);
    const { projectId, userId } = await produce("faceless");
    expect(video.prompts).toEqual([]);
    expect((await listAssets(env.DB, userId, projectId)).map((a) => a.asset_type)).toEqual([
      "image",
      "image",
    ]);
  }, 30_000);
});
