import { API_PATHS } from "@avs/contracts";
import { graphicsLayoutSchema, renderManifestSchema, type RenderManifest } from "@avs/schemas";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { runDirector, runGraphicsLayout } from "../src/agents";
import { wantsMotionGraphics } from "../src/agents/director";
import { normalizeStoryboard } from "../src/agents/storyboard";
import type { TextModel } from "../src/ai/text-model";
import { RENDER_EVENT } from "../src/workflows/production-workflow";
import {
  createAsset,
  listAssets,
  listJobs,
  listScenes,
  replaceScenes,
  requireProject,
  setSceneGraphicsLayouts,
  upsertUserByEmail,
} from "../src/db";
import { makeProject, makeUser, setTextModelOverride } from "./helpers";

const brief = {
  title: "Close deals on autopilot",
  prompt: "A motion graphics explainer: six sales books loaded into one assistant",
  video_type: "explainer" as const,
  aspect_ratio: "9:16" as const,
  duration_seconds: 30,
  target_platform: "instagram_reels" as const,
  style: null,
};

function scripted(...replies: (string | Error)[]): TextModel & { calls: number } {
  const m = {
    name: "fake:model",
    calls: 0,
    async generate() {
      m.calls++;
      const r = replies.shift();
      if (r === undefined) throw new Error("no reply queued");
      if (r instanceof Error) throw r;
      return { text: r, usage: { input_tokens: 10, output_tokens: 10 } };
    },
  };
  return m;
}

afterEach(() => setTextModelOverride(null));

describe("director: motion graphics", () => {
  it("picks the motion_graphics style from the brief and needs no picture provider", () => {
    expect(wantsMotionGraphics(brief)).toBe(true);
    expect(wantsMotionGraphics({ ...brief, prompt: "Facts about whales" })).toBe(false);
    expect(wantsMotionGraphics({ ...brief, prompt: "Whales", style: "kinetic typography" })).toBe(
      true,
    );
    // "Vox style", infographic and flat-2D briefs are motion graphics too.
    for (const prompt of [
      "a person editing video vox style",
      "Vox-style explainer on inflation",
      "Infographic video about rainfall",
      "flat 2D animation of the water cycle",
      "explainer-style video on taxes",
    ])
      expect(wantsMotionGraphics({ ...brief, prompt }), prompt).toBe(true);
    for (const prompt of [
      "A cartoon fox finds a lost star",
      "Voxel art castle tour",
      "Flat earth myths debunked",
    ])
      expect(wantsMotionGraphics({ ...brief, prompt }), prompt).toBe(false);
    // Even with "Animation" chosen as the type, a Vox brief gets graphics scenes.
    const vox = runDirector({
      ...brief,
      title: "how to edit youtube shorts",
      prompt: "a person editing video vox style",
      video_type: "animation",
    }).output;
    expect(vox.visual_style).toBe("motion_graphics");
    expect(vox.capabilities).not.toContain("video");
    const plan = runDirector(brief).output;
    expect(plan.visual_style).toBe("motion_graphics");
    expect(plan.video_type).toBe("explainer");
    expect(plan.capabilities).not.toContain("image");
    expect(plan.capabilities).not.toContain("video");
    expect(runDirector({ ...brief, prompt: "Facts about whales" }).output.visual_style).toBe(
      "image",
    );
  });

  it("makes every storyboard scene a graphics scene", () => {
    const board = normalizeStoryboard(
      [1, 2, 3].map((i) => ({
        description: `Scene ${i}`,
        visual_prompt: "a checklist",
        voiceover: `Line ${i}.`,
        duration_seconds: 10,
        visual_type: i === 2 ? ("graphics" as const) : ("image" as const),
      })),
      30,
      "motion_graphics",
    );
    expect(board.scenes.map((s) => s.visual_type)).toEqual(["graphics", "graphics", "graphics"]);
  });
});

describe("graphics layout agent", () => {
  const scenes = [
    {
      scene_number: 1,
      beat: "Hook",
      narration: "Close deals on autopilot.",
      on_screen_text: "Close deals",
      description: "hook",
    },
    {
      scene_number: 2,
      beat: "Proof",
      narration: "It handles objections, pricing and follow-ups.",
      on_screen_text: null,
      description: "proof",
    },
    {
      scene_number: 3,
      beat: "Call to action",
      narration: "Follow for the script.",
      on_screen_text: null,
      description: "cta",
    },
  ];

  it("falls back to deterministic layouts without a model", async () => {
    const r = await runGraphicsLayout(null, { brief, scenes });
    expect(r.meta.model).toBe("deterministic");
    expect(r.output.layouts.map((l) => [l.layout.preset, l.source])).toEqual([
      ["hook_headline", "fallback"],
      ["checklist", "fallback"],
      ["cta_card", "fallback"],
    ]);
    for (const l of r.output.layouts)
      expect(graphicsLayoutSchema.safeParse(l.layout).success).toBe(true);
  });

  it("uses the model's valid layouts and fills gaps with the fallback", async () => {
    const reply = JSON.stringify({
      scenes: [
        {
          scene_number: 1,
          layout: { preset: "headline_badge", headline: "CLOSE DEALS", badge: "On autopilot" },
        },
        {
          scene_number: 3,
          layout: {
            preset: "cta_card",
            headline: "WANT IT?",
            handle: "@deals",
            button: "Follow",
            line: "Comment SCRIPT",
          },
        },
      ],
    });
    const r = await runGraphicsLayout(scripted(reply), { brief, scenes });
    expect(r.output.layouts.map((l) => [l.layout.preset, l.source])).toEqual([
      ["headline_badge", "model"],
      ["checklist", "fallback"],
      ["cta_card", "model"],
    ]);
  });

  it("falls back when the model's text is too long, twice, or the model is down", async () => {
    const tooLong = JSON.stringify({
      scenes: [
        { scene_number: 1, layout: { preset: "headline_papers", headline: "x".repeat(90) } },
      ],
    });
    const junk = await runGraphicsLayout(scripted(tooLong, tooLong), { brief, scenes });
    expect(junk.output.layouts.every((l) => l.source === "fallback")).toBe(true);
    const down = await runGraphicsLayout(scripted(new Error("network down")), { brief, scenes });
    expect(down.output.layouts.every((l) => l.source === "fallback")).toBe(true);
    const wrongScene = JSON.stringify({
      scenes: [{ scene_number: 9, layout: { preset: "headline_papers", headline: "HI" } }],
    });
    const wrong = await runGraphicsLayout(scripted(wrongScene, wrongScene), { brief, scenes });
    expect(wrong.output.layouts.every((l) => l.source === "fallback")).toBe(true);
  });

  it("rejects invalid input", async () => {
    await expect(runGraphicsLayout(null, { brief, scenes: [] })).rejects.toThrow(/invalid input/);
  });
});

describe("stored layouts", () => {
  it("saves layouts by scene number, reads them back, and refuses invalid ones", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    await replaceScenes(env.DB, u.id, p.id, [
      { scene_number: 1, description: "a", visual_type: "graphics" },
      { scene_number: 2, description: "b", visual_type: "graphics" },
    ]);
    await setSceneGraphicsLayouts(env.DB, u.id, p.id, [
      { scene_number: 1, layout: { preset: "headline_papers", headline: "KEY POINTS" } },
    ]);
    const rows = await listScenes(env.DB, u.id, p.id);
    expect(rows.map((s) => s.graphics_layout)).toEqual([
      { preset: "headline_papers", headline: "KEY POINTS" },
      null,
    ]);
    await expect(
      setSceneGraphicsLayouts(env.DB, u.id, p.id, [
        { scene_number: 2, layout: { preset: "checklist", headline: "X", rows: [] } as never },
      ]),
    ).rejects.toThrow(/layout/);
    // Another user can't write to this project.
    const other = await makeUser("mallory");
    await expect(
      setSceneGraphicsLayouts(env.DB, other.id, p.id, [
        { scene_number: 1, layout: { preset: "headline_papers", headline: "HACKED" } },
      ]),
    ).rejects.toThrow();
    // Malformed stored JSON reads as no layout rather than failing.
    await env.DB.prepare("UPDATE scenes SET graphics_layout = 'not json' WHERE project_id = ?")
      .bind(p.id)
      .run();
    expect((await listScenes(env.DB, u.id, p.id)).every((s) => s.graphics_layout === null)).toBe(
      true,
    );
  });
});

/* ------------------------------------ end to end ------------------------------------ */

const EMAIL = "graphics@example.com";
function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-dev-user", EMAIL);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`https://example.test${path}`, {
    ...init,
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

const words = (n: number) => Array.from({ length: n }, () => "deals").join(" ");
const SCRIPT = JSON.stringify({
  title: "Close deals",
  hook: "Close deals on autopilot.",
  segments: [1, 2, 3, 4, 5].map(() => ({ text: words(13) })),
  call_to_action: "Follow for the script.",
});
const BOARD = JSON.stringify({
  scenes: [1, 2, 3, 4, 5, 6].map((i) => ({
    description: `Scene ${i}`,
    visual_prompt: `A checklist of ${i} items`,
    voiceover: `Line ${i}, with objections, pricing and follow-ups.`,
    duration_seconds: 5,
    visual_type: "graphics",
  })),
});
const LAYOUTS = JSON.stringify({
  scenes: [
    {
      scene_number: 1,
      layout: {
        preset: "hook_headline",
        headline: "CLOSE DEALS ON AUTOPILOT",
        items: ["SPIN Selling"],
      },
    },
    {
      scene_number: 2,
      layout: { preset: "checklist", headline: "LOADED", rows: ["Objections", "Pricing"] },
    },
  ],
});

describe("a motion-graphics project end to end", () => {
  it("lays out graphics scenes, generates no pictures, and renders them with the theme", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD, LAYOUTS));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const created = await call(API_PATHS.projects, {
      method: "POST",
      json: {
        title: "Close deals on autopilot",
        prompt: "A motion graphics explainer about six sales books in one AI assistant",
        video_type: "explainer",
        duration_seconds: 30,
      },
    });
    const projectId = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await call(API_PATHS.projectGenerate(projectId), { method: "POST" })).status).toBe(202);
    const [run] = await introspector.get();
    await run!.waitForStepResult({ name: "request-render" });

    const user = await upsertUserByEmail(env.DB, EMAIL);
    const project = await requireProject(env.DB, user.id, projectId);
    expect(project.production_config.plan).toMatchObject({ visual_style: "motion_graphics" });
    expect(project.graphics_theme).toMatchObject({ anchor: "folder", mascot: true });
    const scenes = await listScenes(env.DB, user.id, projectId);
    expect(scenes.length).toBe(6);
    expect(scenes.every((s) => s.visual_type === "graphics")).toBe(true);
    expect(scenes.map((s) => s.graphics_layout?.preset)).toEqual([
      "hook_headline",
      "checklist",
      ...scenes.slice(2).map((s) => s.graphics_layout?.preset),
    ]);
    expect(scenes.every((s) => graphicsLayoutSchema.safeParse(s.graphics_layout).success)).toBe(
      true,
    );
    // No AI pictures or footage, no image jobs, and no fallback note about missing images.
    const assets = await listAssets(env.DB, user.id, projectId);
    expect(assets.filter((a) => a.asset_type === "image" || a.asset_type === "video")).toEqual([]);
    const jobs = await listJobs(env.DB, user.id, projectId);
    expect(jobs.some((j) => j.agent_name === "visual-artist")).toBe(false);
    expect(jobs.find((j) => j.agent_name === "graphics-layout")?.status).toBe("completed");
    expect((project.production_config.fallbacks as string[]).join(" ")).not.toMatch(/image/i);

    // The render manifest carries every layout and the theme.
    const res = await call(API_PATHS.projectRender(projectId), { method: "POST" });
    expect(res.status).toBe(200);
    const manifest = renderManifestSchema.parse(
      ((await res.json()) as { data: RenderManifest }).data,
    );
    expect(manifest.graphics_theme).toMatchObject({ anchor: "folder" });
    expect(
      manifest.scenes.every((s) => s.visual_type === "graphics" && s.graphics && !s.image_url),
    ).toBe(true);
    expect(manifest.scenes[0]!.graphics).toMatchObject({ preset: "hook_headline" });

    // The browser's render comes back (a real MP4) and the run finishes.
    const mp4 = Uint8Array.from(
      atob((JSON.parse(env.TEST_MP4) as Record<string, string>)["sample-15s.mp4"] ?? ""),
      (c) => c.charCodeAt(0),
    );
    const key = `projects/${projectId}/graphics-final.mp4`;
    await env.MEDIA.put(key, mp4);
    const video = await createAsset(env.DB, user.id, projectId, {
      asset_type: "render",
      storage_key: key,
      mime_type: "video/mp4",
      file_size: mp4.length,
      metadata: { reported_duration_seconds: 15 },
    });
    const requestId = (project.production_config.render_request as { id: string }).id;
    await run!.modify(async (m) => {
      await m.mockEvent({
        type: RENDER_EVENT,
        payload: { render_request_id: requestId, asset_id: video.id },
      });
    });
    await run!.waitForStatus("complete");
    expect((await requireProject(env.DB, user.id, projectId)).status).toBe("completed");
  });

  it("refuses to regenerate a picture for a graphics scene", async () => {
    const u = await upsertUserByEmail(env.DB, EMAIL);
    const p = await makeProject(u.id);
    const [scene] = await replaceScenes(env.DB, u.id, p.id, [
      { scene_number: 1, description: "a", visual_type: "graphics" },
    ]);
    await env.DB.prepare("UPDATE projects SET status = 'completed' WHERE id = ?").bind(p.id).run();
    const res = await call(`${API_PATHS.project(p.id)}/scenes/${scene!.id}/regenerate`, {
      method: "POST",
      json: { what: "image" },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Graphics scenes are drawn by the renderer/);
  });
});
