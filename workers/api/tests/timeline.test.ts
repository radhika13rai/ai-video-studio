import { API_PATHS } from "@avs/contracts";
import {
  compileTimeline,
  timelineFromProduction,
  timelineSchema,
  type StoredTimeline,
  type Timeline,
} from "@avs/schemas";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAsset,
  deleteAsset,
  getTimeline,
  mergeProductionConfig,
  replaceScenes,
  setProjectStatusIf,
  upsertUserByEmail,
} from "../src/db";
import { prepareMediaStage } from "../src/workflows/media";
import { db, makeProject } from "./helpers";

/* ------------------------------- pure functions ------------------------------- */

const scenes = [
  {
    id: "s2",
    scene_number: 2,
    description: "Two",
    voiceover: "",
    duration_seconds: 4,
    visual_type: "text" as const,
  },
  {
    id: "s1",
    scene_number: 1,
    description: "One",
    voiceover: " Hello. ",
    duration_seconds: 5,
    visual_type: "image" as const,
  },
  {
    id: "s3",
    scene_number: 3,
    description: "Three",
    voiceover: "Bye.",
    duration_seconds: 6,
    visual_type: "image" as const,
  },
];
const assets = [
  { id: "img1", scene_id: "s1", asset_type: "image" },
  { id: "vid3", scene_id: "s3", asset_type: "video" },
  { id: "img3", scene_id: "s3", asset_type: "image" },
  { id: "vo3", scene_id: "s3", asset_type: "voiceover" },
];
const directions = [
  {
    scene_number: 1,
    shot: "close" as const,
    camera: "push_in" as const,
    transition_in: "cut" as const,
    on_screen_text: "Hi",
  },
  {
    scene_number: 2,
    shot: "wide" as const,
    camera: "static" as const,
    transition_in: "whip" as const,
    on_screen_text: null,
  },
  {
    scene_number: 3,
    shot: "medium" as const,
    camera: "orbit" as const,
    transition_in: "zoom" as const,
    on_screen_text: null,
  },
];
const media = (id: string) => ({
  url: `/a/${id}`,
  ...(id.startsWith("vid") ? { credit: "Video by Ann on Pexels" } : {}),
});

describe("timeline model", () => {
  it("builds the default timeline from a production, in scene order", () => {
    const t = timelineFromProduction({
      aspect_ratio: "9:16",
      scenes,
      assets,
      directions,
      music: { mood: "upbeat", tempo_bpm: 116 },
    });
    expect(timelineSchema.safeParse(t).success).toBe(true);
    expect(t.clips.map((c) => c.scene_id)).toEqual(["s1", "s2", "s3"]);
    expect(t.clips[0]).toMatchObject({
      id: "c_s1",
      image_asset_id: "img1",
      video_asset_id: null,
      duration_s: 5,
      shot: "close",
      transition_in: { kind: "cut" },
      voice: { mode: "kokoro", text: "Hello.", asset_id: null },
      on_screen_text: "Hi",
    });
    expect(t.clips[1]?.voice.mode).toBe("none");
    expect(t.clips[2]).toMatchObject({
      image_asset_id: "img3",
      video_asset_id: "vid3",
      voice: { mode: "asset", asset_id: "vo3" },
    });
    expect(t.music).toMatchObject({ mood: "upbeat", tempo_bpm: 116 });
  });

  it("compiles an unedited timeline into exactly the manifest scenes the renderer had before", () => {
    const t = timelineFromProduction({
      aspect_ratio: "9:16",
      scenes,
      assets,
      directions,
      music: { mood: "upbeat", tempo_bpm: 116 },
    });
    expect(compileTimeline(t, media)).toEqual({
      aspect_ratio: "9:16",
      duration_seconds: 15,
      music: { mood: "upbeat", tempo_bpm: 116 },
      scenes: [
        {
          scene_number: 1,
          start_seconds: 0,
          duration_seconds: 5,
          visual_type: "image",
          caption: "Hello.",
          narration: "Hello.",
          image_url: "/a/img1",
          voice_url: null,
          shot: "close",
          camera: "push_in",
          transition_in: "cut",
          on_screen_text: "Hi",
        },
        {
          scene_number: 2,
          start_seconds: 5,
          duration_seconds: 4,
          visual_type: "text",
          caption: "Two",
          narration: null,
          image_url: null,
          voice_url: null,
          shot: "wide",
          camera: "static",
          transition_in: "whip",
          on_screen_text: null,
        },
        {
          scene_number: 3,
          start_seconds: 9,
          duration_seconds: 6,
          visual_type: "image",
          caption: "Bye.",
          narration: "Bye.",
          image_url: "/a/img3",
          voice_url: "/a/vo3",
          shot: "medium",
          camera: "orbit",
          transition_in: "zoom",
          on_screen_text: null,
          video_url: "/a/vid3",
          credit: "Video by Ann on Pexels",
        },
      ],
    });
  });

  it("without a blueprint, compiles to the plain scenes (no direction, default music)", () => {
    const t = timelineFromProduction({ aspect_ratio: "16:9", scenes, assets });
    const c = compileTimeline(t, media);
    expect(c.music).toBeUndefined();
    expect(Object.keys(c.scenes[0]!)).toEqual([
      "scene_number",
      "start_seconds",
      "duration_seconds",
      "visual_type",
      "caption",
      "narration",
      "image_url",
      "voice_url",
    ]);
  });

  it("an edit reorders, retimes and re-captions; unknown media falls back instead of failing", () => {
    const t = timelineFromProduction({ aspect_ratio: "9:16", scenes, assets, directions });
    const edited: Timeline = {
      ...t,
      clips: [
        { ...t.clips[2]!, duration_s: 3, caption: "Custom" },
        { ...t.clips[0]!, image_asset_id: "gone" },
      ],
      music: { ...t.music, mode: "none", mood: "ambient", tempo_bpm: 80 },
    };
    const c = compileTimeline(edited, (id) => (id === "gone" ? null : media(id)));
    expect(c.scenes.map((s) => [s.scene_number, s.start_seconds, s.duration_seconds])).toEqual([
      [1, 0, 3],
      [2, 3, 5],
    ]);
    expect(c.scenes[0]?.caption).toBe("Custom");
    expect(c.scenes[1]?.image_url).toBeNull();
    expect(c.music).toBeUndefined(); // music switched off
  });

  it("rejects duplicate ids, items past their clip, and videos that are too long", () => {
    const t = timelineFromProduction({ aspect_ratio: "9:16", scenes, assets });
    const c0 = t.clips[0]!;
    const dup = { ...t, clips: [c0, { ...c0 }] };
    expect(timelineSchema.safeParse(dup).error?.issues[0]?.message).toMatch(/duplicate id/);
    const late = {
      ...t,
      clips: [
        {
          ...c0,
          overlays: [
            {
              id: "o1",
              text: "Hi",
              start_s: 9,
              duration_s: 1,
              preset: "label",
              x: 0.5,
              y: 0.5,
              animation: "fade",
            },
          ],
        },
      ],
    };
    expect(timelineSchema.safeParse(late).error?.issues[0]?.message).toMatch(/after its clip ends/);
    const long = {
      ...t,
      clips: Array.from({ length: 5 }, (_, i) => ({ ...c0, id: `c${i}`, duration_s: 30 })),
    };
    expect(timelineSchema.safeParse(long).error?.issues[0]?.message).toMatch(/the most is 120 s/);
    expect(timelineSchema.safeParse({ ...t, clips: [{ ...c0, id: "bad id!" }] }).success).toBe(
      false,
    );
  });
});

/* ------------------------------------ API ------------------------------------ */

const EMAIL = "editor@example.com";
const call = (path: string, init: RequestInit = {}, user = EMAIL) =>
  SELF.fetch(`https://example.test${path}`, {
    ...init,
    headers: { "x-dev-user": user, "content-type": "application/json", ...(init.headers ?? {}) },
  });

/** A project with two scenes and media, ready to render (no workflow needed). */
async function readyProject() {
  const user = await upsertUserByEmail(db(), EMAIL);
  const p = await makeProject(user.id);
  const [a, b] = await replaceScenes(db(), user.id, p.id, [
    {
      scene_number: 1,
      description: "Jellyfish glow",
      voiceover: "They glow.",
      duration_seconds: 5,
    },
    { scene_number: 2, description: "Deep trench", voiceover: "It is deep.", duration_seconds: 5 },
  ]);
  const img = async (sceneId: string, n: number) =>
    createAsset(db(), user.id, p.id, {
      asset_type: "image",
      storage_key: `projects/${p.id}/runs/manual/scene-${n}-image.png`,
      mime_type: "image/png",
      scene_id: sceneId,
    });
  const imgA = await img(a!.id, 1);
  const imgB = await img(b!.id, 2);
  await setProjectStatusIf(db(), user.id, p.id, ["created"], "awaiting_render");
  await mergeProductionConfig(db(), user.id, p.id, { render_request: { id: "rr-1" } });
  return { userId: user.id, projectId: p.id, scenes: [a!, b!], images: [imgA, imgB] };
}

const getTl = async (projectId: string) =>
  ((await (await call(API_PATHS.projectTimeline(projectId))).json()) as { data: StoredTimeline })
    .data;
const put = (projectId: string, base: number, timeline: unknown, user = EMAIL) =>
  call(
    API_PATHS.projectTimeline(projectId),
    { method: "PUT", body: JSON.stringify({ base_revision: base, timeline }) },
    user,
  );

describe("timeline API", () => {
  it("returns the production's timeline as revision 0 before any edit", async () => {
    const { projectId, images } = await readyProject();
    const t = await getTl(projectId);
    expect(t.revision).toBe(0);
    expect(t.updated_at).toBeNull();
    expect(t.timeline.clips.map((c) => c.image_asset_id)).toEqual([images[0]!.id, images[1]!.id]);
  });

  it("saves with optimistic concurrency and refuses a stale save", async () => {
    const { projectId } = await readyProject();
    const t = (await getTl(projectId)).timeline;
    const first = await put(projectId, 0, { ...t, aspect_ratio: "1:1" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: StoredTimeline }).data.revision).toBe(1);
    const second = await put(projectId, 1, { ...t, aspect_ratio: "16:9" });
    expect(((await second.json()) as { data: StoredTimeline }).data.revision).toBe(2);
    // A tab still on revision 1 can't overwrite revision 2.
    const stale = await put(projectId, 1, t);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
    expect((await getTl(projectId)).timeline.aspect_ratio).toBe("16:9");
    // So can a second "first save".
    expect((await put(projectId, 0, t)).status).toBe(409);
  });

  it("validates the timeline and its references", async () => {
    const { projectId } = await readyProject();
    const t = (await getTl(projectId)).timeline;
    expect((await put(projectId, 0, { ...t, clips: [] })).status).toBe(400);
    const other = await readyProject();
    const foreign = {
      ...t,
      clips: [{ ...t.clips[0]!, image_asset_id: other.images[0]!.id }],
    };
    const res = await put(projectId, 0, foreign);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /isn't one of this project's image files/,
    );
    const badScene = { ...t, clips: [{ ...t.clips[0]!, scene_id: "nope" }] };
    expect((await put(projectId, 0, badScene)).status).toBe(400);
  });

  it("is private to the owner and closed while the video is still being produced", async () => {
    const { projectId } = await readyProject();
    expect(
      (await call(API_PATHS.projectTimeline(projectId), {}, "mallory@example.com")).status,
    ).toBe(404);
    const t = (await getTl(projectId)).timeline;
    expect((await put(projectId, 0, t, "mallory@example.com")).status).toBe(404);
    const user = await upsertUserByEmail(db(), EMAIL);
    const fresh = await makeProject(user.id);
    const res = await call(API_PATHS.projectTimeline(fresh.id));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /Generate the video first/,
    );
  });

  it("the render manifest follows the saved edit", async () => {
    const { projectId, images } = await readyProject();
    const t = (await getTl(projectId)).timeline;
    const edited = {
      ...t,
      aspect_ratio: "16:9",
      clips: [
        { ...t.clips[1]!, duration_s: 3.5, caption: "The trench" },
        { ...t.clips[0]!, voice: { ...t.clips[0]!.voice, text: "They really glow." } },
      ],
    };
    expect((await put(projectId, 0, edited)).status).toBe(200);
    const m = (
      (await (await call(API_PATHS.projectRender(projectId), { method: "POST" })).json()) as {
        data: {
          project: { aspect_ratio: string; duration_seconds: number };
          scenes: {
            scene_number: number;
            image_url: string;
            caption: string;
            narration: string;
            duration_seconds: number;
          }[];
        };
      }
    ).data;
    expect(m.project).toMatchObject({ aspect_ratio: "16:9", duration_seconds: 8.5 });
    expect(m.scenes.map((s) => [s.scene_number, s.duration_seconds, s.caption])).toEqual([
      [1, 3.5, "The trench"],
      [2, 5, "They really glow."],
    ]);
    expect(m.scenes[0]?.image_url).toContain(images[1]!.id);
  });

  it("keeps snapshots, restores one, and repairs references to replaced media", async () => {
    const { projectId, userId, scenes: sc, images } = await readyProject();
    const t = (await getTl(projectId)).timeline;
    await put(projectId, 0, { ...t, aspect_ratio: "1:1" });
    const revs = (
      (await (await call(API_PATHS.projectTimelineRevisions(projectId))).json()) as {
        data: { revision: number; reason: string }[];
      }
    ).data;
    expect(revs).toEqual([expect.objectContaining({ revision: 1, reason: "autosave" })]);
    await put(projectId, 1, { ...t, aspect_ratio: "16:9" }); // within 5 min: no new snapshot

    // Scene 1's image is regenerated: the old file is replaced by a new one.
    await deleteAsset(db(), userId, images[0]!.id);
    const replacement = await createAsset(db(), userId, projectId, {
      asset_type: "image",
      storage_key: `projects/${projectId}/runs/manual/scene-1-image-retry.png`,
      mime_type: "image/png",
      scene_id: sc[0]!.id,
    });
    expect((await getTl(projectId)).timeline.clips[0]?.image_asset_id).toBe(replacement.id);

    const restored = await call(API_PATHS.projectTimelineRestore(projectId, 1), {
      method: "POST",
      body: JSON.stringify({ base_revision: 2 }),
    });
    expect(restored.status).toBe(200);
    const body = ((await restored.json()) as { data: StoredTimeline }).data;
    expect(body).toMatchObject({ revision: 3, timeline: { aspect_ratio: "1:1" } });
    expect(body.timeline.clips[0]?.image_asset_id).toBe(replacement.id);
    expect(
      (
        await call(API_PATHS.projectTimelineRestore(projectId, 99), {
          method: "POST",
          body: JSON.stringify({ base_revision: 3 }),
        })
      ).status,
    ).toBe(404);
  });

  it("a new production run forgets the old timeline (its media is replaced)", async () => {
    const { projectId, userId } = await readyProject();
    const t = (await getTl(projectId)).timeline;
    await put(projectId, 0, t);
    expect(await getTimeline(db(), userId, projectId)).not.toBeNull();
    await prepareMediaStage(
      { db: db(), userId, projectId, runId: crypto.randomUUID() },
      {} as never,
    );
    expect(await getTimeline(db(), userId, projectId)).toBeNull();
  });
});

describe("editor fields in the manifest", () => {
  it("are emitted only when they differ from the defaults", () => {
    const t = timelineFromProduction({ aspect_ratio: "9:16", scenes, assets, directions });
    const c0 = t.clips[0]!;
    const edited: Timeline = {
      ...t,
      clips: [
        {
          ...c0,
          overlays: [
            {
              id: "o1",
              text: "Sale!",
              start_s: 0.5,
              duration_s: 2,
              preset: "title",
              x: 0.5,
              y: 0.3,
              animation: "pop",
            },
          ],
          sfx: [{ id: "s1", kind: "boom", at_s: 1, gain_db: -2 }],
          voice: { ...c0.voice, voice_id: "am_michael", speed: 1.1, gain_db: 3 },
          transition_in: { kind: "cut", duration_s: 1 },
          focal: { x: 0.2, y: 0.5 },
          trim_in_s: 1.5,
        },
        ...t.clips.slice(1),
      ],
      captions: { enabled: true, style: "karaoke", position: "top" },
      music: { ...t.music, gain_db: -6 },
    };
    const c = compileTimeline(edited, media);
    expect(c.scenes[0]).toMatchObject({
      overlays: [
        {
          text: "Sale!",
          start_s: 0.5,
          duration_s: 2,
          preset: "title",
          x: 0.5,
          y: 0.3,
          animation: "pop",
        },
      ],
      sfx: [{ kind: "boom", at_s: 1, gain_db: -2 }],
      voice_id: "am_michael",
      voice_speed: 1.1,
      voice_gain_db: 3,
      transition_seconds: 1,
      focal: { x: 0.2, y: 0.5 },
      trim_in_seconds: 1.5,
    });
    expect(c.scenes[1]).not.toHaveProperty("overlays");
    expect(c.captions).toEqual({ enabled: true, style: "karaoke", position: "top" });
    expect(c.audio).toEqual({
      music: true,
      music_gain_db: -6,
      duck_under_voice: true,
      transition_sfx: true,
    });
    // Unedited: none of them.
    const plain = compileTimeline(t, media);
    expect(plain.captions).toBeUndefined();
    expect(plain.audio).toBeUndefined();
    expect(Object.keys(plain.scenes[0]!)).not.toContain("focal");
  });
});
