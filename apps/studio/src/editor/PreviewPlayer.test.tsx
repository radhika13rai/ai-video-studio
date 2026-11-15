import type { Asset } from "@avs/contracts";
import type { PreviewState } from "@avs/renderer";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleTimeline } from "./commands.test";
import { PreviewPlayer, previewManifest, REBUILD_MS } from "./PreviewPlayer";

const controller = {
  state: { seconds: 0, duration: 15, playing: false, voiced: 1, narrated: 3 } as PreviewState,
  play: vi.fn(async () => undefined),
  pause: vi.fn(),
  seek: vi.fn(),
  sceneStart: vi.fn((i: number) => i * 5),
  update: vi.fn(async (_m: unknown) => undefined),
  voice: vi.fn(async (progress?: (d: number, t: number) => void) => progress?.(0, 2)),
  destroy: vi.fn(),
};
const createPreview = vi.fn(
  async (_c: HTMLCanvasElement, _m: unknown, _o: unknown, onState?: (s: PreviewState) => void) => {
    onState?.(controller.state);
    return controller;
  },
);
vi.mock("@avs/renderer", () => ({
  createPreview: (...a: Parameters<typeof createPreview>) => createPreview(...a),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const asset = (
  id: string,
  type: string,
  license: Record<string, unknown> | null = null,
): Asset => ({
  id,
  project_id: "p1",
  scene_id: null,
  asset_type: type as Asset["asset_type"],
  storage_key: "k",
  mime_type: "x/y",
  file_size: 1,
  source_provider: null,
  license,
  metadata: {},
  created_at: "",
});

describe("preview manifest", () => {
  it("compiles the timeline in the browser with asset URLs and footage credit", () => {
    const t = sampleTimeline();
    const withClip = {
      ...t,
      clips: [{ ...t.clips[0]!, video_asset_id: "v1" }, ...t.clips.slice(1)],
    };
    const m = previewManifest("p1", "Ocean", withClip, [
      asset("img1", "image"),
      asset("v1", "video", { credit: "Video by Ann on Pexels" }),
    ]);
    expect(m.project).toMatchObject({
      id: "p1",
      title: "Ocean",
      aspect_ratio: "9:16",
      duration_seconds: 15,
    });
    expect(m.scenes[0]).toMatchObject({
      image_url: expect.stringContaining("/assets/img1/content"),
      video_url: expect.stringContaining("/assets/v1/content"),
      credit: "Video by Ann on Pexels",
    });
    expect(m.scenes[1]!.image_url).toBeNull(); // img2 isn't in the asset list
  });
});

describe("preview player", () => {
  it("creates the preview, plays, scrubs, follows the selection and rebuilds after edits", async () => {
    const t = sampleTimeline();
    const { rerender } = render(
      <PreviewPlayer projectId="p1" title="Ocean" timeline={t} assets={[]} selectedIndex={0} />,
    );
    expect(await screen.findByRole("button", { name: "Play" })).toBeTruthy();
    expect(createPreview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(controller.play).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("slider", { name: "Playhead" }), {
      target: { value: "7.5" },
    });
    expect(controller.seek).toHaveBeenLastCalledWith(7.5);
    rerender(
      <PreviewPlayer projectId="p1" title="Ocean" timeline={t} assets={[]} selectedIndex={2} />,
    );
    expect(controller.seek).toHaveBeenLastCalledWith(10); // scene 3 starts at 10 s
    vi.useFakeTimers();
    const edited = { ...t, aspect_ratio: "1:1" as const };
    rerender(
      <PreviewPlayer
        projectId="p1"
        title="Ocean"
        timeline={edited}
        assets={[]}
        selectedIndex={2}
      />,
    );
    expect(controller.update).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(REBUILD_MS)));
    expect(controller.update).toHaveBeenCalledTimes(1);
    expect(controller.update.mock.calls[0]![0]).toMatchObject({ project: { aspect_ratio: "1:1" } });
  });

  it("offers to voice the scenes the preview can't play yet", async () => {
    render(
      <PreviewPlayer
        projectId="p1"
        title="Ocean"
        timeline={sampleTimeline()}
        assets={[]}
        selectedIndex={0}
      />,
    );
    expect(await screen.findByText(/2 scenes not voiced in the preview yet/)).toBeTruthy();
    await act(
      async () => void fireEvent.click(screen.getByRole("button", { name: "Voice the preview" })),
    );
    expect(controller.voice).toHaveBeenCalled();
  });

  it("explains when the preview can't run", async () => {
    createPreview.mockRejectedValueOnce(new Error("No Web Audio here."));
    render(
      <PreviewPlayer
        projectId="p1"
        title="Ocean"
        timeline={sampleTimeline()}
        assets={[]}
        selectedIndex={0}
      />,
    );
    expect(await screen.findByText("No Web Audio here.")).toBeTruthy();
  });
});
