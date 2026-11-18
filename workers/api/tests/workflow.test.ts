import { API_PATHS } from "@avs/contracts";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setTextModelOverride as setRawTextModelOverride } from "../src/ai/factory";
import { setTextModelOverride } from "./helpers";
import { ModelError, type TextModel } from "../src/ai/text-model";
import {
  createWorkflowRun,
  terminateWorkflowRunIfLatest,
  createAsset,
  getLatestQualityReport,
  getLatestWorkflowRun,
  listJobs,
  listScenes,
  requireProject,
  upsertUserByEmail,
} from "../src/db";
import {
  WORKFLOW_NAME,
  MAX_RENDER_ATTEMPTS,
  RENDER_EVENT,
  renderRequestIdFor,
} from "../src/workflows/production-workflow";

const url = (p: string) => `https://example.test${p}`;
const EMAIL = "producer@example.com";

function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-dev-user", EMAIL);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(url(path), {
    ...init,
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

// Realistic word lengths: segment text has a minimum length in characters.
const words = (n: number) => Array.from({ length: n }, () => "ocean").join(" ");
const SCRIPT = JSON.stringify({
  title: "Ocean",
  hook: "The ocean hides secrets.",
  segments: [1, 2, 3, 4, 5].map(() => ({ text: words(13) })),
  call_to_action: null,
});
const BOARD = JSON.stringify({
  scenes: [1, 2, 3, 4, 5, 6].map((i) => ({
    description: `Scene ${i}`,
    visual_prompt: `Deep sea creature ${i}, bioluminescent, dark water`,
    voiceover: `Line ${i}.`,
    duration_seconds: 5,
    visual_type: "image",
  })),
});

/** Replies in order; anything thrown is passed through. */
function scripted(...replies: (string | Error)[]): TextModel & { calls: number } {
  const m = {
    name: "fake:model",
    calls: 0,
    async generate() {
      m.calls++;
      const r = replies.shift();
      if (r === undefined) throw new Error("no reply queued");
      if (r instanceof Error) throw r;
      return { text: r, usage: { input_tokens: 100, output_tokens: 50 } };
    },
  };
  return m;
}

async function newProject() {
  const res = await call(API_PATHS.projects, {
    method: "POST",
    json: {
      title: "Deep ocean",
      prompt: "Five facts about the deep ocean",
      video_type: "faceless",
    },
  });
  return ((await res.json()) as { data: { id: string } }).data.id;
}

afterEach(() => setTextModelOverride(null));

describe("production workflow", () => {
  it("does not let an older workflow run cancel or fail a newer run", async () => {
    const projectId = await newProject();
    const user = await upsertUserByEmail(env.DB, EMAIL);
    const olderId = crypto.randomUUID();
    const newerId = crypto.randomUUID();
    await createWorkflowRun(env.DB, user.id, projectId, {
      id: olderId,
      workflow_name: WORKFLOW_NAME,
      workflow_instance_id: olderId,
    });
    await createWorkflowRun(env.DB, user.id, projectId, {
      id: newerId,
      workflow_name: WORKFLOW_NAME,
      workflow_instance_id: newerId,
    });

    const projectStatuses = [
      "created",
      "planning",
      "generating",
      "awaiting_render",
      "rendering",
      "quality_check",
    ] as const;
    expect(
      await terminateWorkflowRunIfLatest(
        env.DB,
        user.id,
        projectId,
        olderId,
        "cancelled",
        projectStatuses,
        "Stale cancellation.",
      ),
    ).toBe(false);
    expect(
      await terminateWorkflowRunIfLatest(
        env.DB,
        user.id,
        projectId,
        olderId,
        "failed",
        projectStatuses,
        "Stale failure.",
      ),
    ).toBe(false);

    expect(await getLatestWorkflowRun(env.DB, user.id, projectId)).toMatchObject({
      id: newerId,
      status: "running",
    });
    expect(await requireProject(env.DB, user.id, projectId)).toMatchObject({ status: "created" });
  });

  it("runs director → script → storyboard, waits for the render, then quality-checks it", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();

    const res = await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    expect(res.status).toBe(202);
    const { data } = (await res.json()) as { data: { workflow_run_id: string; status: string } };
    expect(data.status).toBe("planning");
    // The finish step checks that the event points at a real render of this project. Create it
    // once the media stage has run (that stage clears media left over from earlier runs).
    const [running] = await introspector.get();
    await running!.waitForStepResult({ name: "request-render" });
    const owner = await upsertUserByEmail(env.DB, EMAIL);
    // A real MP4, but 15 s long for a project planned at 30 s: QC must catch the mismatch.
    const mp4 = Uint8Array.from(
      atob((JSON.parse(env.TEST_MP4) as Record<string, string>)["sample-15s.mp4"] ?? ""),
      (c) => c.charCodeAt(0),
    );
    await env.MEDIA.put(`projects/${projectId}/final-test.mp4`, mp4);
    const video = await createAsset(env.DB, owner.id, projectId, {
      asset_type: "render",
      storage_key: `projects/${projectId}/final-test.mp4`,
      mime_type: "video/mp4",
      file_size: mp4.length,
    });
    const [instance] = await introspector.get();
    // Every attempt fails the length check (a 15 s file, planned 30 s, no render plan
    // reported), so the run uses all its render attempts, then fails.
    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
      const sfx = attempt === 1 ? "" : `-${attempt}`;
      if (attempt > 1) await instance!.waitForStepResult({ name: `request-render${sfx}` });
      const id = await renderRequestIdFor(data.workflow_run_id, attempt);
      await instance!.modify(async (m) => {
        await m.mockEvent({
          type: RENDER_EVENT,
          payload: { render_request_id: id, asset_id: video.id },
        });
      });
      await instance!.waitForStepResult({ name: `finish${sfx}` });
    }
    await instance!.waitForStatus("complete");
    const user = await upsertUserByEmail(env.DB, EMAIL);
    const project = await requireProject(env.DB, user.id, projectId);
    expect(project.status).toBe("failed");
    expect(project.production_config).toMatchObject({
      plan: { video_type: "faceless", scene_count: 6 },
      render_request: {
        id: await renderRequestIdFor(data.workflow_run_id, MAX_RENDER_ATTEMPTS),
        attempt: MAX_RENDER_ATTEMPTS,
        last_failure: expect.stringMatching(/^Quality check failed/),
      },
    });
    const notes = project.production_config.fallbacks as string[];
    expect(notes[0]).toMatch(
      /6 of 6 scenes have no generated image \(No image provider is configured\)/,
    );
    // No server voice provider: narration is left to the browser, so it isn't a fallback.
    expect(notes).toHaveLength(1);

    const jobs = await listJobs(env.DB, user.id, projectId);
    expect(jobs.slice(0, 4).map((j) => [j.agent_name, j.status])).toEqual([
      ["director", "completed"],
      ["creative-director", "completed"],
      ["scriptwriter", "completed"],
      ["storyboard", "completed"],
    ]);
    // The Creative Director's blueprint is saved, and scene prompts carry the shared style
    // and the recurring character's description.
    const blueprint = project.production_config.blueprint as {
      blueprint_version: number;
      source: { interpretation: string };
      narrative: { structure: string; beats: unknown[] };
      characters: { id: string }[];
      scenes: { visual_prompt: string; transition_in: string }[];
    };
    expect(blueprint).toMatchObject({
      blueprint_version: 1,
      source: { interpretation: "model" },
      narrative: { structure: "listicle" },
      characters: [{ id: "diver" }],
    });
    expect(blueprint.scenes).toHaveLength(6);
    expect(blueprint.scenes[0]?.transition_in).toBe("cut");
    const saved = await listScenes(env.DB, user.id, projectId);
    expect(saved[0]?.visual_prompt).toMatch(/Style: bioluminescent/);
    expect(saved[0]?.visual_prompt).toMatch(/Avoid: text overlays/);
    // One image job per scene, completed with a recorded fallback; no server narration jobs.
    expect(jobs.filter((j) => j.agent_name === "visual-artist")).toHaveLength(6);
    expect(jobs.filter((j) => j.agent_name === "voice-director")).toHaveLength(0);
    expect(jobs.every((j) => j.status === "completed")).toBe(true);
    expect(await listScenes(env.DB, user.id, projectId)).toHaveLength(6);
    const run = await getLatestWorkflowRun(env.DB, user.id, projectId);
    expect(run).toMatchObject({ status: "failed" });
    expect(run?.error_message).toMatch(/^Quality check failed: 15\.00 s \(planned 30 s\)\./);
    expect(run?.error_message).toMatch(/after 3 render attempts/);
    // Media was generated once: retries never re-run the image or narration steps.
    expect(jobs.filter((j) => j.agent_name === "visual-artist")).toHaveLength(6);
    const report = await getLatestQualityReport(env.DB, user.id, projectId);
    expect(report).toMatchObject({ overall_status: "failed" });

    const usage = await env.DB.prepare(
      "SELECT SUM(units_used) AS n FROM usage_events WHERE project_id = ?",
    )
      .bind(projectId)
      .first<{ n: number }>();
    expect(usage?.n).toBe(400); // interpretation (100) + script and storyboard (150 each)
  });

  it("after a failed quality check, asks for another render without regenerating media", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();
    const res = await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const runId = ((await res.json()) as { data: { workflow_run_id: string } }).data
      .workflow_run_id;
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });
    const owner = await upsertUserByEmail(env.DB, EMAIL);
    const mp4 = Uint8Array.from(
      atob((JSON.parse(env.TEST_MP4) as Record<string, string>)["sample-15s.mp4"] ?? ""),
      (c) => c.charCodeAt(0),
    );
    const render = async (key: string, metadata: Record<string, unknown>) => {
      await env.MEDIA.put(key, mp4);
      return createAsset(env.DB, owner.id, projectId, {
        asset_type: "render",
        storage_key: key,
        mime_type: "video/mp4",
        file_size: mp4.length,
        metadata,
      });
    };

    // Attempt 1: no render plan reported, 15 s against 30 s planned → fails.
    const first = await render(`projects/${projectId}/a1.mp4`, {});
    await instance!.modify(async (m) => {
      await m.mockEvent({
        type: RENDER_EVENT,
        payload: { render_request_id: await renderRequestIdFor(runId), asset_id: first.id },
      });
    });
    await instance!.waitForStepResult({ name: "request-render-2" });
    let project = await requireProject(env.DB, owner.id, projectId);
    expect(project.status).toBe("awaiting_render");
    expect(project.production_config.render_request).toMatchObject({
      id: await renderRequestIdFor(runId, 2),
      attempt: 2,
      max_attempts: MAX_RENDER_ATTEMPTS,
      last_failure: expect.stringMatching(/15\.00 s \(planned 30 s\)/),
    });
    expect(await getLatestWorkflowRun(env.DB, owner.id, projectId)).toMatchObject({
      status: "waiting",
    });
    const jobsBefore = await listJobs(env.DB, owner.id, projectId);
    const scenesBefore = await listScenes(env.DB, owner.id, projectId);

    // Attempt 2: the renderer reports it planned 15 s (its own timing) → only a warning.
    const second = await render(`projects/${projectId}/a2.mp4`, {
      reported_duration_seconds: 15,
    });
    await instance!.modify(async (m) => {
      await m.mockEvent({
        type: RENDER_EVENT,
        payload: { render_request_id: await renderRequestIdFor(runId, 2), asset_id: second.id },
      });
    });
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toMatchObject({ status: "completed", quality: "warning" });
    project = await requireProject(env.DB, owner.id, projectId);
    expect(project.status).toBe("completed");
    // Nothing was regenerated: same jobs and the same scenes as before the retry.
    expect((await listJobs(env.DB, owner.id, projectId)).length).toBe(jobsBefore.length);
    expect((await listScenes(env.DB, owner.id, projectId)).map((s) => s.id)).toEqual(
      scenesBefore.map((s) => s.id),
    );
    const report = await getLatestQualityReport(env.DB, owner.id, projectId);
    expect(report?.checks).toMatchObject({ attempt: 2 });
  });

  it("keeps going on templates when the Creative Director's model output is unusable", async () => {
    // No helper here: the first two replies go to the interpretation and are invalid.
    setRawTextModelOverride(scripted("not json", '{"subject": 1}', SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();
    await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });
    const user = await upsertUserByEmail(env.DB, EMAIL);
    const project = await requireProject(env.DB, user.id, projectId);
    expect(project.status).toBe("awaiting_render");
    expect(project.production_config.interpretation).toMatchObject({ source: "rules" });
    expect(project.production_config.blueprint).toMatchObject({
      source: { interpretation: "rules" },
      characters: [],
    });
  });

  it("runs started before the Creative Director skip its steps (replay compatibility)", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();
    const user = await upsertUserByEmail(env.DB, EMAIL);
    // Start a run the old way: no `blueprint` parameter.
    await env.DB.prepare("UPDATE projects SET status = 'planning' WHERE id = ?")
      .bind(projectId)
      .run();
    const runId = crypto.randomUUID();
    await createWorkflowRun(env.DB, user.id, projectId, {
      id: runId,
      workflow_name: WORKFLOW_NAME,
      workflow_instance_id: runId,
    });
    await env.PRODUCTION_WORKFLOW.create({
      id: runId,
      params: { projectId, userId: user.id, runId },
    });
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });
    const jobs = await listJobs(env.DB, user.id, projectId);
    expect(jobs.map((j) => j.agent_name)).not.toContain("creative-director");
    const project = await requireProject(env.DB, user.id, projectId);
    expect(project.production_config.blueprint).toBeUndefined();
    expect(project.production_config.interpretation).toBeUndefined();
    expect(await listScenes(env.DB, user.id, projectId)).toHaveLength(6);
  });

  it("stops at 'Ready to render' until the browser finishes", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();
    await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });
    await expect
      .poll(async () => {
        const r = await call(API_PATHS.project(projectId));
        return ((await r.json()) as { data: { status: string } }).data.status;
      })
      .toBe("awaiting_render");
    const run = (await (await call(API_PATHS.projectRun(projectId))).json()) as {
      data: { status: string };
    };
    expect(run.data.status).toBe("waiting");
  });

  it("fails the project when the render never arrives", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "wait-for-render" });
    });
    const projectId = await newProject();
    await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const [instance] = await introspector.get();
    await instance!.waitForStatus("errored");
    const user = await upsertUserByEmail(env.DB, EMAIL);
    expect((await requireProject(env.DB, user.id, projectId)).status).toBe("failed");
    const run = await getLatestWorkflowRun(env.DB, user.id, projectId);
    expect(run?.error_message).toMatch(/wasn't rendered within 7 days/);
  });

  it("does not retry when the AI quota is used up, and records why", async () => {
    setTextModelOverride(
      scripted(new ModelError("Workers AI daily free allowance is used up.", "quota", false)),
    );
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();
    await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const [instance] = await introspector.get();
    await instance!.waitForStatus("errored");
    const user = await upsertUserByEmail(env.DB, EMAIL);
    const jobs = await listJobs(env.DB, user.id, projectId);
    expect(jobs.find((j) => j.agent_name === "scriptwriter")).toMatchObject({
      status: "failed",
      retry_count: 0,
      error_message: expect.stringMatching(/allowance is used up/),
    });
    expect((await requireProject(env.DB, user.id, projectId)).status).toBe("failed");
    expect((await getLatestWorkflowRun(env.DB, user.id, projectId))?.error_message).toMatch(
      /allowance/,
    );
  });

  it("retries a transient model failure and the job shows the retry", async () => {
    const model = scripted(
      new ModelError("Workers AI request failed: 503", "unavailable", true),
      SCRIPT,
      BOARD,
    );
    setTextModelOverride(model);
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
    });
    const projectId = await newProject();
    const res = await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const { data } = (await res.json()) as { data: { workflow_run_id: string } };
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "storyboard" });
    const user = await upsertUserByEmail(env.DB, EMAIL);
    const writer = (await listJobs(env.DB, user.id, projectId)).find(
      (j) => j.agent_name === "scriptwriter",
    );
    expect(writer).toMatchObject({ status: "completed", retry_count: 1 });
    expect(model.calls).toBe(3);
    expect(data.workflow_run_id).toBeTruthy();
  }, 20_000);

  it("can be cancelled, and cancelled projects can start again", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD, SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();
    await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });

    const cancel = await call(API_PATHS.projectCancel(projectId), { method: "POST" });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { data: { status: string } }).data.status).toBe("cancelled");
    const user = await upsertUserByEmail(env.DB, EMAIL);
    expect((await getLatestWorkflowRun(env.DB, user.id, projectId))?.status).toBe("cancelled");

    const again = await call(API_PATHS.projectCancel(projectId), { method: "POST" });
    expect(again.status).toBe(409);
    const restart = await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    expect(restart.status).toBe(202);
  });
});

describe("generate endpoint guards", () => {
  it("refuses while production is running", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();
    expect((await call(API_PATHS.projectGenerate(projectId), { method: "POST" })).status).toBe(202);
    const second = await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("INVALID_STATE");
    const [instance] = await introspector.get();
    await instance!.waitForStepResult({ name: "request-render" });
  });

  it("explains when no AI model is available", async () => {
    const projectId = await newProject();
    const res = await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    const status = (
      (await (await call(API_PATHS.project(projectId))).json()) as { data: { status: string } }
    ).data.status;
    expect(status).toBe("created");
  });

  it("hides other users' projects", async () => {
    setTextModelOverride(scripted());
    const projectId = await newProject();
    const res = await SELF.fetch(url(API_PATHS.projectGenerate(projectId)), {
      method: "POST",
      headers: { "x-dev-user": "mallory@example.com" },
    });
    expect(res.status).toBe(404);
  });
});
