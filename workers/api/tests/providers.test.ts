import { API_PATHS } from "@avs/contracts";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setTextModelOverride } from "../src/ai/factory";
import { listAssets, listJobs, listScenes, requireProject, upsertUserByEmail } from "../src/db";
import { base64ToBytes, sniffMedia, toBytes } from "../src/providers/media-bytes";
import {
  generateMedia,
  NoProviderError,
  setMediaProvidersOverride,
} from "../src/providers/registry";
import { ProviderError, type MediaProvider, type MediaRequest } from "../src/providers/types";
import {
  WorkersAiFluxImage,
  WorkersAiMeloVoice,
  WorkersAiSdxlImage,
} from "../src/providers/workers-ai";
import { db, makeProject, makeUser } from "./helpers";

// Minimal real files: a JPEG header with SOF0 (width 576, height 1024) and a 1-second 8 kHz WAV.
function jpeg(width = 576, height = 1024): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    0,
    0,
    0,
    0xff,
    0xd9,
  ]);
}
function wav(seconds = 1, rate = 8000): Uint8Array {
  const data = rate * seconds;
  const b = new Uint8Array(44 + data);
  const dv = new DataView(b.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  dv.setUint32(4, 36 + data, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  w(36, "data");
  dv.setUint32(40, data, true);
  return b;
}

/** A fake provider whose behaviour is scripted per call. */
// The database persists across tests in a file, so every fake gets a unique registry name.
function fake(
  base: string,
  capability: "image" | "voice",
  behaviour: (req: MediaRequest) => Uint8Array | Error,
  priority = 10,
  limit = 100,
): MediaProvider & { calls: MediaRequest[] } {
  const calls: MediaRequest[] = [];
  const name = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    name,
    capability,
    defaultPriority: priority,
    defaultDailyLimit: limit,
    calls,
    async generate(req) {
      calls.push(req);
      const r = behaviour(req);
      if (r instanceof Error) throw r;
      const s = sniffMedia(r)!;
      return {
        bytes: r,
        model: `fake/${name}`,
        units: 1,
        unit_type: capability === "image" ? "images" : "clips",
        ...s,
      };
    },
  };
}

afterEach(() => {
  setMediaProvidersOverride(null);
  setTextModelOverride(null);
});

describe("media bytes", () => {
  it("identifies JPEG, PNG and WAV from their bytes, with sizes and duration", () => {
    expect(sniffMedia(jpeg())).toEqual({
      mime_type: "image/jpeg",
      extension: "jpg",
      width: 576,
      height: 1024,
    });
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
    new DataView(png.buffer).setUint32(16, 768);
    new DataView(png.buffer).setUint32(20, 1344);
    expect(sniffMedia(png)).toMatchObject({ mime_type: "image/png", width: 768, height: 1344 });
    expect(sniffMedia(wav(2))).toEqual({
      mime_type: "audio/wav",
      extension: "wav",
      duration_seconds: 2,
    });
    expect(sniffMedia(new TextEncoder().encode("<html>not media</html>"))).toBeNull();
  });

  it("accepts the shapes AI bindings return", async () => {
    const b = jpeg();
    const b64 = btoa(String.fromCharCode(...b));
    expect(await toBytes({ image: b64 }, "image")).toEqual(b);
    expect(await toBytes(new Response(b).body)).toEqual(b);
    expect(await toBytes(b.buffer)).toEqual(b);
    expect(base64ToBytes(b64)).toEqual(b);
    expect(await toBytes({ nope: 1 }, "image")).toBeNull();
  });
});

describe("Workers AI adapters", () => {
  const ai = (reply: unknown) => {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    return {
      calls,
      run: async (model: string, inputs: Record<string, unknown>) => (
        calls.push({ model, inputs }),
        reply
      ),
    };
  };

  it("FLUX sends the prompt with a composition hint and returns a sniffed JPEG", async () => {
    const binding = ai({ image: btoa(String.fromCharCode(...jpeg(1024, 1024))) });
    const r = await new WorkersAiFluxImage(binding).generate({
      capability: "image",
      prompt: "A jellyfish",
      aspect_ratio: "9:16",
    });
    expect(r).toMatchObject({
      mime_type: "image/jpeg",
      width: 1024,
      height: 1024,
      units: 1,
      model: WorkersAiFluxImage.MODEL,
    });
    expect(binding.calls[0]?.inputs.prompt).toMatch(/A jellyfish\. Vertical composition/);
    expect(binding.calls[0]?.inputs.steps).toBe(4);
  });

  it("SDXL asks for the native aspect ratio and accepts a binary stream", async () => {
    const binding = ai(new Response(jpeg(768, 1344)).body);
    const r = await new WorkersAiSdxlImage(binding).generate({
      capability: "image",
      prompt: "x",
      aspect_ratio: "9:16",
    });
    expect(binding.calls[0]?.inputs).toMatchObject({ width: 768, height: 1344, num_steps: 8 });
    expect(r.height).toBe(1344);
  });

  it("MeloTTS returns WAV narration with its duration", async () => {
    const binding = ai({ audio: btoa(String.fromCharCode(...wav(3))) });
    const r = await new WorkersAiMeloVoice(binding).generate({
      capability: "voice",
      text: " Hello there. ",
    });
    expect(r).toMatchObject({ mime_type: "audio/wav", duration_seconds: 3 });
    expect(binding.calls[0]?.inputs).toEqual({ prompt: "Hello there.", lang: "en" });
  });

  it("rejects wrong media, missing media and classifies quota errors", async () => {
    await expect(
      new WorkersAiFluxImage(ai({ image: btoa("not an image at all, sorry") })).generate({
        capability: "image",
        prompt: "x",
        aspect_ratio: "1:1",
      }),
    ).rejects.toMatchObject({ kind: "bad_response" });
    await expect(
      new WorkersAiMeloVoice(ai({ audio: btoa(String.fromCharCode(...jpeg())) })).generate({
        capability: "voice",
        text: "hi",
      }),
    ).rejects.toMatchObject({ kind: "bad_response" });
    const quota = {
      run: async () => {
        throw new Error("4006: you have used up your daily free allocation of 10,000 neurons");
      },
    };
    await expect(
      new WorkersAiFluxImage(quota).generate({
        capability: "image",
        prompt: "x",
        aspect_ratio: "1:1",
      }),
    ).rejects.toMatchObject({ kind: "quota", retryable: false });
    await expect(
      new WorkersAiFluxImage(ai({})).generate({ capability: "voice", text: "x" }),
    ).rejects.toMatchObject({ kind: "unsupported" });
  });
});

describe("provider registry", () => {
  const owner = async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    return { userId: u.id, projectId: p.id };
  };
  const req: MediaRequest = { capability: "image", prompt: "x", aspect_ratio: "9:16" };

  it("uses the highest-priority provider and records usage and health", async () => {
    const a = fake("img-a", "image", () => jpeg(), 10);
    const b = fake("img-b", "image", () => jpeg(), 20);
    setMediaProvidersOverride([a, b]);
    const o = await owner();
    const r = await generateMedia(db(), env, o, req);
    expect(r.provider).toBe(a.name);
    expect(b.calls).toHaveLength(0);
    const row = await db()
      .prepare("SELECT health_status FROM providers WHERE provider_name = ?")
      .bind(a.name)
      .first<{ health_status: string }>();
    expect(row?.health_status).toBe("healthy");
    const used = await db()
      .prepare("SELECT units_used, unit_type FROM usage_events WHERE project_id = ?")
      .bind(o.projectId)
      .first();
    expect(used).toEqual({ units_used: 1, unit_type: "images" });
  });

  it("falls back to the next provider when one is out of quota or failing", async () => {
    const a = fake(
      "img-a",
      "image",
      () => new ProviderError("img-a", "allowance used", "quota", false),
      10,
    );
    const b = fake(
      "img-b",
      "image",
      () => new ProviderError("img-b", "503", "unavailable", true),
      20,
    );
    const c = fake("img-c", "image", () => jpeg(), 30);
    setMediaProvidersOverride([a, b, c]);
    const r = await generateMedia(db(), env, await owner(), req);
    expect(r.provider).toBe(c.name);
    expect(r.attempts.map((x) => x.outcome)).toEqual(["quota", "failed", "ok"]);
    const b2 = await db()
      .prepare("SELECT health_status FROM providers WHERE provider_name = ?")
      .bind(b.name)
      .first<{ health_status: string }>();
    expect(b2?.health_status).toBe("degraded");
  });

  it("respects the daily cap and says why nothing ran", async () => {
    const a = fake("img-a", "image", () => jpeg(), 10, 1);
    setMediaProvidersOverride([a]);
    const o = await owner();
    await generateMedia(db(), env, o, req);
    const err = await generateMedia(db(), env, o, req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as NoProviderError).attempts).toEqual([
      { provider: a.name, outcome: "over_daily_limit", detail: "1/1 today" },
    ]);
    expect((err as NoProviderError).retryable).toBe(false);
    expect(a.calls).toHaveLength(1);
  });

  it("honours registry edits: a provider disabled in D1 is never called", async () => {
    const a = fake("img-a", "image", () => jpeg(), 10);
    const b = fake("img-b", "image", () => jpeg(), 20);
    setMediaProvidersOverride([a, b]);
    const o = await owner();
    await generateMedia(db(), env, o, req); // creates the rows
    await db()
      .prepare("UPDATE providers SET enabled = 0 WHERE provider_name = ?")
      .bind(a.name)
      .run();
    expect((await generateMedia(db(), env, o, req)).provider).toBe(b.name);
  });

  it("reports retryable when only transient failures happened", async () => {
    setMediaProvidersOverride([
      fake("img-a", "image", () => new ProviderError("img-a", "503", "unavailable", true)),
    ]);
    const err = (await generateMedia(db(), env, await owner(), req).catch(
      (e: unknown) => e,
    )) as NoProviderError;
    expect(err.retryable).toBe(true);
  });
});

describe("workflow with media providers", () => {
  const EMAIL = "media@example.com";
  const call = (path: string, init: RequestInit = {}, user = EMAIL) =>
    SELF.fetch(`https://example.test${path}`, {
      ...init,
      headers: { "x-dev-user": user, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  // Realistic word lengths: segment text has a minimum length in characters.
  const words = (n: number) => Array.from({ length: n }, () => "ocean").join(" ");
  const SCRIPT = JSON.stringify({
    title: "Ocean",
    hook: "The ocean hides secrets.",
    // 15 s videos fit ~38 words (30–45 accepted): 4 + 3 × 11 = 37.
    segments: [1, 2, 3].map(() => ({ text: words(11) })),
    call_to_action: null,
  });
  const BOARD = JSON.stringify({
    scenes: [1, 2, 3].map((i) => ({
      description: `Scene ${i}`,
      visual_prompt: `Creature ${i}`,
      voiceover: i === 3 ? "" : `Line ${i}.`,
      duration_seconds: 5,
      visual_type: i === 2 ? "text" : "image",
    })),
  });

  function scripted(...replies: string[]) {
    return {
      name: "fake:model",
      async generate() {
        const r = replies.shift();
        if (!r) throw new Error("none");
        return { text: r };
      },
    };
  }

  it("stores each scene's image and narration in R2 and serves them only to the owner", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    let imageCalls = 0;
    const image = fake("img-a", "image", () =>
      ++imageCalls === 1 ? new ProviderError("img-a", "503", "unavailable", true) : jpeg(),
    );
    const voice = fake("voice-a", "voice", () => wav(2));
    setMediaProvidersOverride([image, voice]);
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
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
    expect((await call(API_PATHS.projectGenerate(projectId), { method: "POST" })).status).toBe(202);
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });

    const user = await upsertUserByEmail(env.DB, EMAIL);
    const assets = await listAssets(env.DB, user.id, projectId);
    // Scene 1: image + voice. Scene 2: text card (no image) + voice. Scene 3: image, no narration text.
    expect(assets.map((a) => [a.asset_type, a.mime_type]).sort()).toEqual([
      ["image", "image/jpeg"],
      ["image", "image/jpeg"],
      ["voiceover", "audio/wav"],
      ["voiceover", "audio/wav"],
    ]);
    const img = assets.find((a) => a.asset_type === "image")!;
    expect(img.storage_key).toMatch(
      new RegExp(`^projects/${projectId}/runs/[0-9a-f-]+/scene-\\d-image\\.jpg$`),
    );
    expect(img.metadata).toMatchObject({ width: 576, height: 1024, model: `fake/${image.name}` });
    expect(img.license).toMatchObject({ source: "generated", provider: image.name });
    expect(image.calls.length).toBe(3); // first attempt failed transiently, then retried

    const scenes = await listScenes(env.DB, user.id, projectId);
    expect(scenes.every((s) => s.status === "ready")).toBe(true);
    const project = await requireProject(env.DB, user.id, projectId);
    expect(project.production_config.fallbacks).toEqual([]);
    const jobs = await listJobs(env.DB, user.id, projectId);
    const firstImageJob = jobs.find((j) => j.agent_name === "visual-artist" && j.retry_count === 1);
    expect(firstImageJob?.status).toBe("completed");

    const content = await call(API_PATHS.assetContent(projectId, img.id));
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(jpeg());
    expect(
      (await call(API_PATHS.assetContent(projectId, img.id), {}, "mallory@example.com")).status,
    ).toBe(404);
    const other = await makeProject((await makeUser()).id);
    expect((await call(API_PATHS.assetContent(other.id, img.id))).status).toBe(404);
  }, 30_000);

  it("keeps going with a recorded fallback when images run out of quota", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    setMediaProvidersOverride([
      fake(
        "img-a",
        "image",
        () =>
          new ProviderError("img-a", "Workers AI daily free allowance is used up.", "quota", false),
      ),
      fake("voice-a", "voice", () => wav(1)),
    ]);
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const created = await call(API_PATHS.projects, {
      method: "POST",
      body: JSON.stringify({
        title: "Deep",
        prompt: "Facts about the deep sea",
        video_type: "advertisement",
        duration_seconds: 15,
      }),
    });
    const projectId = ((await created.json()) as { data: { id: string } }).data.id;
    await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });
    const user = await upsertUserByEmail(env.DB, EMAIL);
    const project = await requireProject(env.DB, user.id, projectId);
    expect(project.status).toBe("awaiting_render");
    const notes = project.production_config.fallbacks as string[];
    expect(notes[0]).toMatch(/No video generator is available on the free tier/);
    expect(notes[1]).toMatch(/2 of 3 scenes have no generated image .*quota.*styled text cards/);
  }, 30_000);
});

describe("GET /providers", () => {
  it("lists every capability, honest about what isn't integrated", async () => {
    const img = fake("img-a", "image", () => jpeg());
    setMediaProvidersOverride([img, fake("voice-a", "voice", () => wav())]);
    const res = await SELF.fetch(`https://example.test${API_PATHS.providers}`, {
      headers: { "x-dev-user": "p@example.com" },
    });
    const { data } = (await res.json()) as {
      data: {
        capability: string;
        provider_name: string | null;
        available: boolean;
        note: string | null;
        daily_limit: number | null;
      }[];
    };
    expect([...new Set(data.map((d) => d.capability))]).toEqual([
      "text",
      "image",
      "video",
      "voice",
      "music",
    ]);
    expect(data.find((d) => d.provider_name === img.name)).toMatchObject({
      available: true,
      daily_limit: 100,
    });
    expect(data.find((d) => d.capability === "video")).toMatchObject({
      available: false,
      note: "No free video provider is integrated yet.",
    });
    expect(data.find((d) => d.capability === "text")).toMatchObject({ available: false });
  });
});
