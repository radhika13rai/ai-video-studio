import { API_PATHS } from "@avs/contracts";
import type { Timeline } from "@avs/schemas";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, makeProject, ok, route, stubApi } from "../test/fake-api";
import { sampleTimeline } from "./commands.test";
import { memoryDraftStore } from "./drafts";
import { EditorPage } from "./EditorPage";
import { LOCAL_SAVE_MS, SERVER_SAVE_MS } from "./useTimelineEditor";

const project = makeProject({ id: "p1", status: "completed", title: "Ocean facts" });

function api(
  opts: {
    revision?: number;
    timeline?: Timeline;
    put?: (body: { base_revision: number; timeline: Timeline }) => ReturnType<typeof ok>;
  } = {},
) {
  let server = { revision: opts.revision ?? 0, timeline: opts.timeline ?? sampleTimeline() };
  const puts: { base_revision: number; timeline: Timeline }[] = [];
  const calls = stubApi(
    route("GET", API_PATHS.project("p1"), () => ok(project)),
    route("GET", /\/assets$/, () => ok([])),
    route("GET", API_PATHS.projectTimeline("p1"), () =>
      ok({
        project_id: "p1",
        revision: server.revision,
        timeline: server.timeline,
        updated_at: null,
      }),
    ),
    route("PUT", API_PATHS.projectTimeline("p1"), (_u, init) => {
      const body = JSON.parse(String(init.body)) as { base_revision: number; timeline: Timeline };
      puts.push(body);
      if (opts.put) return opts.put(body);
      server = { revision: server.revision + 1, timeline: body.timeline };
      return ok({
        project_id: "p1",
        revision: server.revision,
        timeline: body.timeline,
        updated_at: "now",
      });
    }),
  );
  return {
    calls,
    puts,
    setServer: (t: Timeline, revision: number) => (server = { timeline: t, revision }),
  };
}

function stubExtra(_h: ReturnType<typeof api>, extra: ReturnType<typeof route>[]) {
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    for (const handler of extra) {
      const r = handler(url, init);
      if (r) return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    return base(input, init);
  });
}

const clipLabels = () =>
  screen.getAllByRole("button", { name: /^Scene \d, / }).map((b) => b.getAttribute("aria-label"));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("timeline editor", () => {
  it("loads the timeline and reorders scenes with buttons, with undo and redo", async () => {
    api();
    render(<EditorPage id="p1" store={memoryDraftStore()} />);
    expect(await screen.findByRole("heading", { name: "Ocean facts" })).toBeTruthy();
    expect(clipLabels()).toHaveLength(3);
    // Scene 1 is selected; move it right.
    fireEvent.click(screen.getByRole("button", { name: "Move right ▶" }));
    fireEvent.click(screen.getByRole("tab", { name: "Voice" }));
    // The selected clip (the old scene 1) is now second.
    expect(screen.getByRole("button", { name: /^Scene 2, / }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect((screen.getByLabelText("What is said") as HTMLTextAreaElement).value).toBe("Line 1.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: /^Scene 1, / }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getByRole("button", { name: /^Scene 2, / }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // Keyboard undo.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByRole("button", { name: /^Scene 1, / }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("autosaves to the device, then to the server with the base revision", async () => {
    const { puts } = api({ revision: 4 });
    const store = memoryDraftStore();
    render(<EditorPage id="p1" store={store} />);
    await screen.findByRole("heading", { name: "Ocean facts" });
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("slider", { name: "Length" }), { target: { value: "7.5" } });
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toBe("Unsaved changes");
    expect(screen.getByRole("button", { name: /^Scene 1, 7\.5 seconds/ })).toBeTruthy();
    await advance(LOCAL_SAVE_MS);
    expect(store.drafts.get("p1")).toMatchObject({ baseRevision: 4 });
    expect(puts).toHaveLength(0);
    await advance(SERVER_SAVE_MS);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.base_revision).toBe(4);
    expect(puts[0]!.timeline.clips[0]!.duration_s).toBe(7.5);
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toBe(
      "All changes saved",
    );
    expect(store.drafts.has("p1")).toBe(false);
  });

  it("offers to restore unsaved edits found on the device", async () => {
    const restored = { ...sampleTimeline(), aspect_ratio: "1:1" as const };
    api();
    const store = memoryDraftStore();
    store.put({
      projectId: "p1",
      baseRevision: 0,
      timeline: restored,
      savedAt: "2026-11-15T08:00:00Z",
    });
    render(<EditorPage id="p1" store={store} />);
    expect(
      await screen.findByText(/Unsaved edits from .* were found on this device\./),
    ).toBeTruthy();
    expect((screen.getByLabelText("Aspect ratio") as HTMLSelectElement).value).toBe("9:16");
    fireEvent.click(screen.getByRole("button", { name: "Restore them" }));
    expect((screen.getByLabelText("Aspect ratio") as HTMLSelectElement).value).toBe("1:1");
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toBe("Unsaved changes");
    // Restoring can be undone.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByLabelText("Aspect ratio") as HTMLSelectElement).value).toBe("9:16");
  });

  it("says when another device saved first, and can load the other version", async () => {
    const other = { ...sampleTimeline(), aspect_ratio: "16:9" as const };
    const h = api({ put: () => err("CONFLICT", "changed elsewhere", 409) });
    render(<EditorPage id="p1" store={memoryDraftStore()} />);
    await screen.findByRole("heading", { name: "Ocean facts" });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Aspect ratio"), { target: { value: "1:1" } });
    await advance(SERVER_SAVE_MS);
    expect(screen.getByText(/saved from another tab or device/)).toBeTruthy();
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toBe(
      "Changed elsewhere",
    );
    h.setServer(other, 7);
    fireEvent.click(screen.getByRole("button", { name: "Load the other version" }));
    await advance(0);
    expect((screen.getByLabelText("Aspect ratio") as HTMLSelectElement).value).toBe("16:9");
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toBe(
      "All changes saved",
    );
  });

  it("keeps edits on the device while offline and retries", async () => {
    let online = false;
    const h = api({
      put: (body) => {
        if (!online) throw new Error("offline");
        return ok({ project_id: "p1", revision: 1, timeline: body.timeline, updated_at: "now" });
      },
    });
    const store = memoryDraftStore();
    render(<EditorPage id="p1" store={store} />);
    await screen.findByRole("heading", { name: "Ocean facts" });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await advance(SERVER_SAVE_MS);
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toBe(
      "Offline: changes kept on this device",
    );
    expect(store.drafts.get("p1")?.timeline.clips).toHaveLength(4);
    online = true;
    await advance(10_000);
    expect(screen.getByRole("status", { name: "Save status" }).textContent).toBe(
      "All changes saved",
    );
    expect(h.puts.at(-1)!.timeline.clips).toHaveLength(4);
  });

  it("refuses an impossible edit with a reason, and edits text, sound and music", async () => {
    const t = sampleTimeline();
    const long: Timeline = { ...t, clips: t.clips.map((c) => ({ ...c, duration_s: 30 })) };
    const { puts } = api({ timeline: long });
    render(<EditorPage id="p1" store={memoryDraftStore()} />);
    await screen.findByRole("heading", { name: "Ocean facts" });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(screen.getByText(/the most is 120 s/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add text" }));
    expect((screen.getByLabelText("Text 1") as HTMLInputElement).value).toBe("Your text");
    fireEvent.click(screen.getByRole("tab", { name: "Audio" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add sound" }));
    fireEvent.change(screen.getByLabelText("Sound 1"), { target: { value: "boom" } });
    fireEvent.click(screen.getByLabelText("Background music"));
    await advance(SERVER_SAVE_MS);
    const saved = puts.at(-1)!.timeline;
    expect(saved.clips).toHaveLength(4);
    expect(saved.clips[0]!.overlays[0]).toMatchObject({ text: "Your text", preset: "title" });
    expect(saved.clips[0]!.sfx[0]).toMatchObject({ kind: "boom" });
    expect(saved.music.mode).toBe("none");
  });
});

describe("regenerating and exporting from the editor", () => {
  it("puts a regenerated image on the scene (undoable) and saves it", async () => {
    const h = api();
    stubExtra(h, [
      route("POST", /\/scenes\/s1\/regenerate$/, (_u, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ what: "image", prompt: "A brighter reef" });
        return ok(
          {
            scene_id: "s1",
            asset: {
              id: "img9",
              project_id: "p1",
              scene_id: "s1",
              asset_type: "image",
              storage_key: "k",
              mime_type: "image/png",
              file_size: 1,
              source_provider: "x",
              license: null,
              metadata: {},
              created_at: "",
            },
          },
          201,
        );
      }),
    ]);
    render(<EditorPage id="p1" store={memoryDraftStore()} />);
    await screen.findByRole("heading", { name: "Ocean facts" });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Describe the new picture"), {
      target: { value: "A brighter reef" },
    });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "New image" })));
    await advance(SERVER_SAVE_MS);
    expect(h.puts.at(-1)!.timeline.clips[0]!.image_asset_id).toBe("img9");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await advance(SERVER_SAVE_MS);
    expect(h.puts.at(-1)!.timeline.clips[0]!.image_asset_id).toBe("img1");
  });

  it("exports a finished video again and goes to the project page", async () => {
    const h = api();
    let exported = false;
    stubExtra(h, [
      route("POST", "/api/v1/projects/p1/export", () => {
        exported = true;
        return ok({ project_id: "p1", workflow_run_id: "r2", status: "generating" }, 202);
      }),
    ]);
    history.replaceState(null, "", "/projects/p1/edit");
    render(<EditorPage id="p1" store={memoryDraftStore()} />);
    await screen.findByRole("heading", { name: "Ocean facts" });
    await act(
      async () => void fireEvent.click(await screen.findByRole("button", { name: "Export video" })),
    );
    expect(exported).toBe(true);
    expect(location.pathname).toBe("/projects/p1");
  });
});

describe("graphics scenes", () => {
  function graphicsTimeline(): Timeline {
    const t = sampleTimeline();
    return {
      ...t,
      clips: t.clips.map((c, i) =>
        i === 0
          ? {
              ...c,
              visual_type: "graphics" as const,
              graphics: {
                preset: "checklist" as const,
                headline: "LOADED",
                rows: ["Objections", "Pricing"],
              },
            }
          : c,
      ),
    };
  }

  it("edits the layout's text and preset, with undo, and saves it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = api({ timeline: graphicsTimeline() });
    render(<EditorPage id="p1" store={memoryDraftStore()} />);
    const headline = (await screen.findByLabelText("Headline")) as HTMLInputElement;
    expect(headline.value).toBe("LOADED");
    // Picture-only settings are hidden for graphics scenes.
    expect(screen.queryByLabelText("Camera")).toBeNull();
    expect(screen.queryByRole("button", { name: "New image" })).toBeNull();

    fireEvent.change(headline, { target: { value: "ALL LOADED" } });
    const items = screen.getByLabelText("Checklist items (one per line)") as HTMLTextAreaElement;
    fireEvent.change(items, { target: { value: "Objections\nPricing\nFollow-ups\n" } });
    // The trailing newline stays while typing.
    expect(items.value).toBe("Objections\nPricing\nFollow-ups\n");
    await advance(LOCAL_SAVE_MS + SERVER_SAVE_MS + 50);
    expect(h.puts.at(-1)?.timeline.clips[0]?.graphics).toEqual({
      preset: "checklist",
      headline: "ALL LOADED",
      rows: ["Objections", "Pricing", "Follow-ups"],
    });

    // An empty required headline isn't saved, and says why.
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "" } });
    expect(screen.getByText(/Not saved/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Layout preset"), { target: { value: "cta_card" } });
    expect((screen.getByLabelText("Handle") as HTMLInputElement).value).toBe("@yourhandle");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByLabelText("Layout preset") as HTMLSelectElement).value).toBe("checklist");
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("ALL LOADED");
  });
});
