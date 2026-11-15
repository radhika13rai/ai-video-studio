import type { Scene } from "@avs/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { blueprintAssumptions, sceneDirections, SceneList } from "./Production";

const blueprint = {
  narrative: {
    beats: [
      { id: "hook", name: "Hook" },
      { id: "items", name: "Main points" },
    ],
  },
  scenes: [
    { scene_number: 1, beat_id: "hook", shot: "close", camera: "push_in" },
    { scene_number: 2, beat_id: "items", shot: "extreme_close", camera: "pan_left" },
  ],
  assumptions: ["10 tips don't fit in 15 s; the best 3 were kept."],
};

const scene = (n: number): Scene => ({
  id: `s${n}`,
  project_id: "p",
  scene_number: n,
  description: `Scene ${n}`,
  visual_prompt: "A prompt",
  voiceover: "Words.",
  duration_seconds: 5,
  visual_type: "image",
  status: "ready",
  created_at: "2026-11-15T00:00:00Z",
});

describe("Creative Director in the storyboard", () => {
  it("reads beats, shots, cameras and assumptions from the blueprint", () => {
    const d = sceneDirections({ blueprint });
    expect(d.get(1)).toEqual({ beat: "Hook", shot: "close", camera: "push in" });
    expect(d.get(2)).toEqual({ beat: "Main points", shot: "extreme close", camera: "pan left" });
    expect(blueprintAssumptions({ blueprint })).toEqual([
      "10 tips don't fit in 15 s; the best 3 were kept.",
    ]);
  });

  it("is empty (and the storyboard unchanged) without a blueprint or with a malformed one", () => {
    expect(sceneDirections({}).size).toBe(0);
    expect(sceneDirections({ blueprint: { scenes: "nope" } }).size).toBe(0);
    expect(blueprintAssumptions({ blueprint: { assumptions: [1, "ok"] } })).toEqual(["ok"]);
  });

  it("shows each scene's beat and camera note", () => {
    render(<SceneList scenes={[scene(1), scene(2)]} directions={sceneDirections({ blueprint })} />);
    expect(screen.getByText("Hook")).toBeTruthy();
    expect(screen.getByText(/close shot, push in/)).toBeTruthy();
    expect(screen.getByText("Main points")).toBeTruthy();
  });
});

describe("stock footage in the storyboard", () => {
  it("plays a scene's clip and credits its creator, linking to the source", () => {
    const video = {
      id: "v1",
      project_id: "p",
      scene_id: "s1",
      asset_type: "video" as const,
      storage_key: "k",
      mime_type: "video/mp4",
      file_size: 1,
      source_provider: "pexels-video",
      license: {
        source: "pexels",
        credit: "Video by Ann Diver on Pexels",
        page_url: "https://www.pexels.com/video/jellyfish-42/",
      },
      metadata: {},
      created_at: "2026-11-15T00:00:00Z",
    };
    const { container } = render(
      <SceneList scenes={[scene(1)]} assets={[video]} onRetry={() => undefined} retrying={null} />,
    );
    expect(container.querySelector("video")?.getAttribute("src")).toMatch(/\/assets\/v1\/content$/);
    const link = screen.getByRole("link", { name: "Video by Ann Diver on Pexels" });
    expect(link.getAttribute("href")).toBe("https://www.pexels.com/video/jellyfish-42/");
    // A scene with footage needs no image, so nothing to retry.
    expect(screen.queryByRole("button", { name: "Retry media" })).toBeNull();
  });
});
