import { API_PATHS } from "@avs/contracts";
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setTextModelOverride } from "../src/ai/factory";
import { ModelError, type TextModel } from "../src/ai/text-model";
import {
  getLatestWorkflowRun,
  listJobs,
  listScenes,
  requireProject,
  upsertUserByEmail,
} from "../src/db";
import { RENDER_EVENT, renderRequestIdFor } from "../src/workflows/production-workflow";

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

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
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
  it("runs director → script → storyboard, waits for the render, then completes", async () => {
    setTextModelOverride(scripted(SCRIPT, BOARD));
    await using introspector = await introspectWorkflow(env.PRODUCTION_WORKFLOW);
    const projectId = await newProject();

    const res = await call(API_PATHS.projectGenerate(projectId), { method: "POST" });
    expect(res.status).toBe(202);
    const { data } = (await res.json()) as { data: { workflow_run_id: string; status: string } };
    expect(data.status).toBe("planning");
    const renderId = await renderRequestIdFor(data.workflow_run_id);
    const [instance] = await introspector.get();
    await instance!.modify(async (m) => {
      await m.mockEvent({
        type: RENDER_EVENT,
        payload: { render_request_id: renderId, asset_id: "a1" },
      });
    });
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toMatchObject({ status: "completed", scenes: 6 });

    const user = await upsertUserByEmail(env.DB, EMAIL);
    const project = await requireProject(env.DB, user.id, projectId);
    expect(project.status).toBe("completed");
    expect(project.production_config).toMatchObject({
      plan: { video_type: "faceless", scene_count: 6 },
      render_request: { id: renderId },
    });
    expect((project.production_config.fallbacks as string[])[0]).toMatch(/No image provider/);

    const jobs = await listJobs(env.DB, user.id, projectId);
    expect(jobs.map((j) => [j.agent_name, j.status])).toEqual([
      ["director", "completed"],
      ["scriptwriter", "completed"],
      ["storyboard", "completed"],
    ]);
    expect(await listScenes(env.DB, user.id, projectId)).toHaveLength(6);
    const run = await getLatestWorkflowRun(env.DB, user.id, projectId);
    expect(run).toMatchObject({ status: "completed", current_step: "done" });

    const usage = await env.DB.prepare(
      "SELECT SUM(units_used) AS n FROM usage_events WHERE project_id = ?",
    )
      .bind(projectId)
      .first<{ n: number }>();
    expect(usage?.n).toBe(300); // two model calls × 150 tokens
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
