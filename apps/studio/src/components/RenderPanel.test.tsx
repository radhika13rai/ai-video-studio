import { API_PATHS } from "@avs/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { err, makeProject, ok, route, stubApi } from "../test/fake-api";
import { FinalVideo, RenderPanel } from "./RenderPanel";

const renderVideo = vi.fn();
vi.mock("@avs/renderer", () => ({ renderVideo: (...args: unknown[]) => renderVideo(...args) }));

const manifest = (projectId: string) => ({
  render_request_id: "rr-1",
  project: { id: projectId, title: "T", aspect_ratio: "9:16", duration_seconds: 10 },
  scenes: [
    {
      scene_number: 1,
      start_seconds: 0,
      duration_seconds: 10,
      visual_type: "text",
      caption: "Hi",
      image_url: null,
      voice_url: null,
    },
  ],
  fallbacks: [],
});
const asset = (projectId: string) => ({
  id: "video-1",
  project_id: projectId,
  scene_id: null,
  asset_type: "render",
  storage_key: `projects/${projectId}/final.mp4`,
  mime_type: "video/mp4",
  file_size: 2_097_152,
  source_provider: "browser-renderer",
  license: null,
  metadata: {},
  created_at: "2026-11-13T00:00:00Z",
});

// Braces matter: a function returned from beforeEach is run as cleanup after the test.
beforeEach(() => {
  renderVideo.mockReset();
});

describe("RenderPanel", () => {
  it("renders, uploads the MP4 and completes the request", async () => {
    const p = makeProject({ status: "awaiting_render" });
    renderVideo.mockImplementation(async (_m, opts: { onProgress: (x: unknown) => void }) => {
      opts.onProgress({ stage: "frames", progress: 0.5, detail: "Frame 150 of 300" });
      return {
        mp4: new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]),
        durationSeconds: 10,
        encoder: "webcodecs",
        width: 720,
        height: 1280,
        frames: 300,
        missingMedia: [],
      };
    });
    const calls = stubApi(
      route("POST", API_PATHS.projectRender(p.id), () => ok(manifest(p.id))),
      route("POST", /\/render\/upload$/, () => ok(asset(p.id), 201)),
      route("POST", API_PATHS.projectRenderComplete(p.id), () =>
        ok({ project_id: p.id, status: "quality_check" }, 202),
      ),
    );
    const onFinished = vi.fn();
    render(<RenderPanel project={p} onFinished={onFinished} />);
    await userEvent.click(screen.getByRole("button", { name: "1080p" }));
    await userEvent.click(screen.getByRole("button", { name: "Render video" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());

    expect(renderVideo.mock.calls[0]?.[1]).toMatchObject({ quality: "1080p" });
    const upload = calls.find((c) => c.url.pathname.endsWith("/render/upload"));
    expect(upload?.url.searchParams.get("render_request_id")).toBe("rr-1");
    expect((upload?.init.headers as Record<string, string>)["content-type"]).toBe("video/mp4");
    expect((upload?.init.headers as Record<string, string>)["x-video-encoder"]).toBe("webcodecs");
    const complete = calls.find((c) => c.url.pathname.endsWith("/render/complete"));
    expect(JSON.parse(String(complete?.init.body))).toEqual({
      render_request_id: "rr-1",
      asset_id: "video-1",
    });
    expect(screen.getByText(/Uploaded/)).toBeTruthy();
  });

  it("resets the server state and explains when rendering fails", async () => {
    const p = makeProject({ status: "awaiting_render" });
    renderVideo.mockRejectedValue(
      new Error("This browser can't draw video frames (no 2D canvas)."),
    );
    const calls = stubApi(
      route("POST", API_PATHS.projectRender(p.id), () => ok(manifest(p.id))),
      route("POST", API_PATHS.projectRenderAbort(p.id), () =>
        ok({ ...p, status: "awaiting_render" }),
      ),
    );
    render(<RenderPanel project={p} onFinished={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render video" }));
    expect(await screen.findByText(/can't draw video frames/)).toBeTruthy();
    expect(calls.some((c) => c.url.pathname.endsWith("/render/abort"))).toBe(true);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows the server's reason when the render can't start", async () => {
    const p = makeProject({ status: "awaiting_render" });
    stubApi(
      route("POST", API_PATHS.projectRender(p.id), () =>
        err("INVALID_STATE", "This project isn't ready to render (status: created).", 409),
      ),
      route("POST", API_PATHS.projectRenderAbort(p.id), () => ok(p)),
    );
    render(<RenderPanel project={p} onFinished={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render video" }));
    expect(await screen.findByText(/isn't ready to render/)).toBeTruthy();
    expect(renderVideo).not.toHaveBeenCalled();
  });

  it("allows only one render per browser", async () => {
    const p = makeProject({ status: "awaiting_render" });
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async (_n: string, _o: unknown, cb: (lock: null) => Promise<void>) => cb(null),
      },
    });
    const calls = stubApi();
    render(<RenderPanel project={p} onFinished={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Render video" }));
    expect(await screen.findByText(/Another video is rendering in this browser/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(renderVideo).not.toHaveBeenCalled();
  });

  it("plays and downloads the finished video", () => {
    const p = makeProject();
    render(<FinalVideo asset={asset(p.id) as never} aspect="9:16" />);
    const video = screen.getByLabelText("Final video");
    expect(video.getAttribute("src")).toBe(API_PATHS.assetContent(p.id, "video-1"));
    const link = screen.getByRole("link", { name: "Download MP4" });
    expect(link.getAttribute("href")).toBe(`${API_PATHS.assetContent(p.id, "video-1")}?download=1`);
    expect(screen.getByText(/2\.0 MB/)).toBeTruthy();
  });
});
