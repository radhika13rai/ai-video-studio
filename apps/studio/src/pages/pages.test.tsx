import { API_PATHS } from "@avs/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { err, makeProject, ok, route, stubApi } from "../test/fake-api";

const me = route("GET", API_PATHS.me, () =>
  ok({
    id: "u1",
    email: "dev@example.com",
    display_name: "dev",
    created_at: "2026-11-13T00:00:00Z",
  }),
);
const goTo = (path: string) => history.replaceState(null, "", path);
const progressRoutes = () =>
  route("GET", /\/(scenes|jobs|run|assets)$/, (url) =>
    ok(url.pathname.endsWith("/run") ? null : []),
  );

describe("projects list", () => {
  it("shows an empty state that links to the form", async () => {
    stubApi(
      me,
      route("GET", API_PATHS.projects, () => ok({ items: [], next_cursor: null })),
    );
    render(<App />);
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Create your first video" }));
    expect(location.pathname).toBe("/projects/new");
    expect(await screen.findByRole("heading", { name: "New video" })).toBeTruthy();
  });

  it("renders project cards with status badges and loads more pages", async () => {
    const a = makeProject({ title: "Alpha", status: "completed" });
    const b = makeProject({ title: "Beta", status: "failed" });
    const c = makeProject({ title: "Gamma" });
    const calls = stubApi(
      me,
      route("GET", API_PATHS.projects, (url) =>
        url.searchParams.get("cursor")
          ? ok({ items: [c], next_cursor: null })
          : ok({ items: [a, b], next_cursor: "next-1" }),
      ),
    );
    render(<App />);
    const alpha = await screen.findByRole("link", { name: /Alpha/ });
    expect(within(alpha).getByText("Completed")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Beta/ })).getByText("Failed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: /Gamma/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(calls.some((c) => c.url.searchParams.get("cursor") === "next-1")).toBe(true);
  });

  it("filters by status", async () => {
    const calls = stubApi(
      me,
      route("GET", API_PATHS.projects, (url) =>
        ok({
          items:
            url.searchParams.get("status") === "failed"
              ? [makeProject({ title: "Broken", status: "failed" })]
              : [],
          next_cursor: null,
        }),
      ),
    );
    render(<App />);
    await screen.findByText("No projects yet");
    await userEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(await screen.findByRole("link", { name: /Broken/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(calls.at(-1)?.url.searchParams.get("status")).toBe("failed");
  });

  it("shows a retryable error", async () => {
    let fail = true;
    stubApi(
      me,
      route("GET", API_PATHS.projects, () =>
        fail
          ? err("INTERNAL_ERROR", "Database is down.", 500)
          : ok({ items: [], next_cursor: null }),
      ),
    );
    render(<App />);
    expect(await screen.findByText("Database is down.")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No projects yet")).toBeTruthy();
  });
});

describe("new project form", () => {
  it("validates before sending anything", async () => {
    const calls = stubApi(me);
    goTo("/projects/new");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));
    expect(screen.getByText("Give your video a title.")).toBeTruthy();
    expect(screen.getByText("Describe your video.")).toBeTruthy();
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(0);
  });

  it("creates the project with an idempotency key and opens it", async () => {
    const created = makeProject({ title: "Mars", aspect_ratio: "16:9" });
    const calls = stubApi(
      me,
      route("POST", API_PATHS.projects, () => ok(created, 201)),
      route("GET", API_PATHS.project(created.id), () => ok(created)),
      progressRoutes(),
    );
    goTo("/projects/new");
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Title"), "Mars");
    await userEvent.type(
      screen.getByLabelText("What should the video be about?"),
      "Three facts about Mars",
    );
    await userEvent.click(screen.getByLabelText(/16:9/));
    await userEvent.type(screen.getByLabelText(/Style/), "documentary");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(location.pathname).toBe(`/projects/${created.id}`));
    const post = calls.find((c) => c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toMatchObject({
      title: "Mars",
      prompt: "Three facts about Mars",
      aspect_ratio: "16:9",
      style: "documentary",
      duration_seconds: 30,
    });
    expect((post?.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(await screen.findByRole("heading", { name: /Mars/ })).toBeTruthy();
  });

  it("shows the server's error message", async () => {
    stubApi(
      me,
      route("POST", API_PATHS.projects, () => err("VALIDATION_ERROR", "prompt: Too long", 400)),
    );
    goTo("/projects/new");
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Title"), "T");
    await userEvent.type(screen.getByLabelText("What should the video be about?"), "P");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("prompt: Too long")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create project" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("project page", () => {
  it("shows details, renames and deletes", async () => {
    const p = makeProject({ title: "Old name", production_config: { style: "noir" } });
    const calls = stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      progressRoutes(),
      route("PATCH", API_PATHS.project(p.id), (_u, init) =>
        ok({ ...p, ...(JSON.parse(String(init.body)) as object) }),
      ),
      route("DELETE", API_PATHS.project(p.id), () =>
        ok({ id: p.id, deleted: true, media_deleted: 0 }),
      ),
      route("GET", API_PATHS.projects, () => ok({ items: [], next_cursor: null })),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: /Old name/ })).toBeTruthy();
    expect(screen.getByText("noir")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate video" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("list", { name: "Production steps" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Project title");
    await userEvent.clear(input);
    await userEvent.type(input, "New name");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: /New name/ })).toBeTruthy();
    expect(JSON.parse(String(calls.find((c) => c.init.method === "PATCH")?.init.body))).toEqual({
      title: "New name",
    });

    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(location.pathname).toBe("/"));
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(true);
  });

  it("keeps the project when delete is not confirmed", async () => {
    const p = makeProject();
    const calls = stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      progressRoutes(),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Delete project" }));
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });

  it("says when a project doesn't exist", async () => {
    stubApi(
      me,
      route("GET", /\/(scenes|jobs|run|assets)$/, () =>
        err("PROJECT_NOT_FOUND", "Project not found.", 404),
      ),
    );
    goTo("/projects/missing-id");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeTruthy();
  });

  it("polls while the project is in production", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const p = makeProject({ status: "generating" });
    let status = "generating";
    stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok({ ...p, status })),
      progressRoutes(),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    expect(await screen.findByText("Generating")).toBeTruthy();
    status = "completed";
    await vi.advanceTimersByTimeAsync(5100);
    expect(await screen.findByText("Completed")).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("navigation", () => {
  it("shows the signed-in user and a not-found page", async () => {
    stubApi(me);
    goTo("/nowhere");
    render(<App />);
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(await screen.findByText("dev")).toBeTruthy();
  });
});

describe("production controls", () => {
  const job = (agent: string, status: string) => ({
    id: crypto.randomUUID(),
    project_id: "p",
    scene_id: null,
    agent_name: agent,
    job_type: "t",
    status,
    error_message: null,
    retry_count: 0,
    max_retries: 2,
    started_at: null,
    completed_at: null,
    created_at: "2026-11-13T00:00:00Z",
  });

  it("starts production with an idempotency key and shows the steps live", async () => {
    let p = makeProject();
    let jobs: unknown[] = [];
    const calls = stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      route("POST", API_PATHS.projectGenerate(p.id), () => {
        p = { ...p, status: "planning" };
        jobs = [job("director", "completed"), job("scriptwriter", "running")];
        return ok({ project_id: p.id, workflow_run_id: "r1", status: "planning" }, 202);
      }),
      route("GET", /\/jobs$/, () => ok(jobs)),
      route("GET", /\/(scenes|run|assets)$/, (url) =>
        ok(url.pathname.endsWith("/run") ? null : []),
      ),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Generate video" }));
    expect(await screen.findByText("Planning")).toBeTruthy();
    const post = calls.find((c) => c.init.method === "POST");
    expect((post?.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await waitFor(() => {
      const steps = screen.getByRole("list", { name: "Production steps" }).querySelectorAll("li");
      expect([...steps].map((li) => li.getAttribute("data-state")).slice(0, 3)).toEqual([
        "done",
        "active",
        "pending",
      ]);
    });
    expect(screen.getByRole("button", { name: "Cancel production" })).toBeTruthy();
  });

  it("shows why production failed and lets you try again", async () => {
    const p = makeProject({ status: "failed" });
    stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      route("GET", /\/jobs$/, () =>
        ok([
          job("director", "completed"),
          { ...job("scriptwriter", "failed"), error_message: "quota" },
        ]),
      ),
      route("GET", /\/(scenes|assets)$/, () => ok([])),
      route("GET", /\/run$/, () =>
        ok({
          id: "r1",
          project_id: p.id,
          workflow_name: "production-workflow",
          workflow_instance_id: "r1",
          current_step: "scriptwriter",
          status: "failed",
          error_message: "Workers AI daily free allowance is used up.",
          started_at: null,
          completed_at: null,
          created_at: "2026-11-13T00:00:00Z",
        }),
      ),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    expect(await screen.findByText("Workers AI daily free allowance is used up.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate again" })).toBeTruthy();
    const states = [
      ...screen.getByRole("list", { name: "Production steps" }).querySelectorAll("li"),
    ].map((li) => li.getAttribute("data-state"));
    expect(states.slice(0, 2)).toEqual(["done", "failed"]);
  });

  it("shows the storyboard, fallback notes and a cancel button while waiting to render", async () => {
    const p = makeProject({
      status: "awaiting_render",
      production_config: {
        fallbacks: [
          "No image provider is configured yet; scenes will render as styled text cards.",
        ],
      },
    });
    const scene = (n: number) => ({
      id: `s${n}`,
      project_id: p.id,
      scene_number: n,
      description: "d",
      visual_prompt: `Jellyfish ${n}`,
      voiceover: `Line ${n}.`,
      duration_seconds: 5,
      visual_type: "image",
      status: "pending",
      created_at: "2026-11-13T00:00:00Z",
    });
    const calls = stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      route("GET", /\/scenes$/, () => ok([scene(1), scene(2)])),
      route("GET", /\/(jobs|run|assets)$/, (url) => ok(url.pathname.endsWith("/run") ? null : [])),
      route("POST", API_PATHS.projectCancel(p.id), () => ok({ ...p, status: "cancelled" })),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    expect(await screen.findByText("“Line 2.”")).toBeTruthy();
    expect(screen.getByText(/2 scenes · 10s/)).toBeTruthy();
    expect(screen.getByText(/styled text cards/)).toBeTruthy();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel production" }));
    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(calls.some((c) => c.init.method === "POST" && c.url.pathname.endsWith("/cancel"))).toBe(
      true,
    );
  });
});

describe("scene media and providers", () => {
  it("shows each scene's generated image and narration player", async () => {
    const p = makeProject({ status: "awaiting_render" });
    const scene = {
      id: "s1",
      project_id: p.id,
      scene_number: 1,
      description: "d",
      visual_prompt: "A glowing jellyfish",
      voiceover: "Line one.",
      duration_seconds: 5,
      visual_type: "image",
      status: "ready",
      created_at: "2026-11-13T00:00:00Z",
    };
    const asset = (id: string, asset_type: string, mime_type: string) => ({
      id,
      project_id: p.id,
      scene_id: "s1",
      asset_type,
      storage_key: `projects/${p.id}/runs/r/scene-1.${mime_type.split("/")[1]}`,
      mime_type,
      file_size: 10,
      source_provider: "workers-ai-flux",
      license: null,
      metadata: {},
      created_at: "2026-11-13T00:00:00Z",
    });
    stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      route("GET", /\/scenes$/, () => ok([scene])),
      route("GET", /\/assets$/, () =>
        ok([asset("a1", "image", "image/jpeg"), asset("a2", "voiceover", "audio/wav")]),
      ),
      route("GET", /\/(jobs|run)$/, (url) => ok(url.pathname.endsWith("/run") ? null : [])),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    const img = await screen.findByRole("img", { name: "A glowing jellyfish" });
    expect(img.getAttribute("src")).toBe(API_PATHS.assetContent(p.id, "a1"));
    const audio = screen.getByLabelText("Narration for scene 1");
    expect(audio.getAttribute("src")).toBe(API_PATHS.assetContent(p.id, "a2"));
  });

  it("lists providers with today's usage on the status page", async () => {
    stubApi(
      me,
      route("GET", API_PATHS.health, () =>
        ok({
          status: "ok",
          service: "s",
          version: "1",
          environment: "test",
          timestamp: new Date().toISOString(),
          bindings: {
            database: { status: "ok" },
            storage: { status: "ok" },
            workflows: { status: "ok" },
          },
        }),
      ),
      route("GET", API_PATHS.providers, () =>
        ok([
          {
            capability: "image",
            provider_name: "workers-ai-flux",
            available: true,
            enabled: true,
            health_status: "healthy",
            priority: 10,
            daily_limit: 60,
            used_today: 7,
            note: null,
          },
          {
            capability: "video",
            provider_name: null,
            available: false,
            enabled: false,
            health_status: "unknown",
            priority: null,
            daily_limit: null,
            used_today: 0,
            note: "No free video provider is integrated yet.",
          },
        ]),
      ),
    );
    goTo("/status");
    render(<App />);
    expect(await screen.findByText("workers-ai-flux")).toBeTruthy();
    expect(screen.getByText("7 / 60")).toBeTruthy();
    expect(screen.getByText("No free video provider is integrated yet.")).toBeTruthy();
  });
});

describe("quality report and scene retry", () => {
  const scene = (n: number, extra: object = {}) => ({
    id: `s${n}`,
    project_id: "p",
    scene_number: n,
    description: "d",
    visual_prompt: `Prompt ${n}`,
    voiceover: `Line ${n}.`,
    duration_seconds: 5,
    visual_type: "image",
    status: "ready",
    created_at: "2026-11-13T00:00:00Z",
    ...extra,
  });

  it("shows the quality report on a completed project", async () => {
    const p = makeProject({ status: "completed" });
    stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      route("GET", /\/(scenes|jobs|assets)$/, () => ok([])),
      route("GET", /\/run$/, () => ok(null)),
      route("GET", /\/quality$/, () =>
        ok({
          id: "q1",
          project_id: p.id,
          overall_status: "warning",
          score: 92,
          checks: {
            items: [
              {
                id: "file",
                label: "Video file",
                status: "pass",
                detail: "Valid MP4 (isom), 6.2 MB.",
              },
              {
                id: "images",
                label: "Scene images",
                status: "warn",
                detail: "5 of 6 image scenes have a generated image.",
              },
            ],
          },
          recommendations: ['Scene 4 has no image; use "Retry media" on it, then render again.'],
          created_at: "2026-11-13T00:00:00Z",
        }),
      ),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    expect(await screen.findByText("Passed with warnings · 92/100")).toBeTruthy();
    expect(screen.getByText("5 of 6 image scenes have a generated image.")).toBeTruthy();
    expect(screen.getByText(/Scene 4 has no image/)).toBeTruthy();
  });

  it("offers Retry media only on scenes missing media, and retries just that scene", async () => {
    const p = makeProject({ status: "awaiting_render" });
    let images: unknown[] = [];
    const calls = stubApi(
      me,
      route("GET", API_PATHS.project(p.id), () => ok(p)),
      route("GET", /\/scenes$/, () =>
        ok([scene(1), scene(2, { visual_type: "text", visual_prompt: null, voiceover: "Words." })]),
      ),
      route("GET", /\/assets$/, () => ok(images)),
      route("GET", /\/(jobs|run|quality)$/, (url) =>
        ok(url.pathname.endsWith("/jobs") ? [] : null),
      ),
      route("POST", /\/retry-media$/, () => {
        images = ["image", "voiceover"].map((t, i) => ({
          id: `a${i}`,
          project_id: p.id,
          scene_id: "s1",
          asset_type: t,
          storage_key: `k${i}`,
          mime_type: t === "image" ? "image/jpeg" : "audio/wav",
          file_size: 1,
          source_provider: "x",
          license: null,
          metadata: {},
          created_at: "2026-11-13T00:00:00Z",
        }));
        return ok({
          scene_id: "s1",
          image: { status: "ok" },
          voice: { status: "ok" },
          fallbacks: [],
        });
      }),
    );
    goTo(`/projects/${p.id}`);
    render(<App />);
    const buttons = await screen.findAllByRole("button", { name: "Retry media" });
    // Scene 2 is a text card; its narration is voiced in the browser, so nothing to retry.
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry media" })).toBeNull());
    expect(
      calls.filter((c) => c.url.pathname.endsWith("/retry-media")).map((c) => c.url.pathname),
    ).toEqual([API_PATHS.sceneRetryMedia(p.id, "s1")]);
  });
});
