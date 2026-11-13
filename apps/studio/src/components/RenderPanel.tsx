import type { Asset, Project } from "@avs/contracts";
import { MAX_RENDER_BYTES } from "@avs/contracts";
import type { RenderProgress, RenderStage } from "@avs/renderer";
import { useEffect, useRef, useState } from "react";
import { abortRender, assetUrl, completeRender, startRender, uploadRender } from "../services/api";
import { ErrorBox } from "./Feedback";

const STAGES: { key: RenderStage | "upload" | "finish"; label: string }[] = [
  { key: "loading", label: "Loading images and narration" },
  { key: "frames", label: "Drawing frames" },
  { key: "audio", label: "Mixing audio" },
  { key: "encoding", label: "Encoding MP4" },
  { key: "upload", label: "Uploading" },
  { key: "finish", label: "Finishing" },
];
type Stage = (typeof STAGES)[number]["key"];

type State =
  | { kind: "idle" }
  | { kind: "running"; stage: Stage; progress: number; detail?: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

/**
 * Renders the video in this browser tab. Holds a Web Lock so only one render runs per browser,
 * warns before closing the tab, and resets the server state if it fails or is cancelled.
 */
export function RenderPanel({
  project,
  onFinished,
  onBusyChange,
}: {
  project: Project;
  onFinished: () => void;
  /** Lets the page hide other production buttons while a render is in progress. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [quality, setQuality] = useState<"720p" | "1080p">("720p");
  const abortRef = useRef<AbortController | null>(null);
  const running = state.kind === "running";

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(
    () => onBusyChange?.(running || state.kind === "done"),
    [running, state.kind, onBusyChange],
  );

  async function run() {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: "running", stage: "loading", progress: 0 });
    const work = async () => {
      let manifest;
      try {
        manifest = await startRender(project.id);
        const { renderVideo } = await import("@avs/renderer"); // loaded only when needed
        const result = await renderVideo(manifest, {
          quality,
          signal: ctrl.signal,
          onProgress: (p: RenderProgress) =>
            setState({
              kind: "running",
              stage: p.stage === "done" ? "upload" : p.stage,
              progress: p.progress,
              ...(p.detail ? { detail: p.detail } : {}),
            }),
        });
        if (result.mp4.byteLength > MAX_RENDER_BYTES)
          throw new Error(
            `The video is ${Math.round(result.mp4.byteLength / 1048576)} MB, over the upload limit. Try 720p.`,
          );
        setState({
          kind: "running",
          stage: "upload",
          progress: 0,
          detail: `${(result.mp4.byteLength / 1048576).toFixed(1)} MB`,
        });
        const asset: Asset = await uploadRender(
          project.id,
          manifest.render_request_id,
          result.mp4,
          {
            durationSeconds: result.durationSeconds,
            encoder: result.encoder,
          },
        );
        setState({ kind: "running", stage: "finish", progress: 0.5 });
        await completeRender(project.id, manifest.render_request_id, asset.id);
        setState({ kind: "done" });
        onFinished();
      } catch (err) {
        const cancelled = err instanceof DOMException && err.name === "AbortError";
        await abortRender(project.id).catch(() => undefined);
        setState(
          cancelled
            ? { kind: "idle" }
            : { kind: "error", message: err instanceof Error ? err.message : "Rendering failed." },
        );
      } finally {
        abortRef.current = null;
      }
    };
    // Some browsers (and test DOMs) expose navigator.locks without a working request().
    const locks =
      typeof navigator !== "undefined" ? (navigator.locks as LockManager | undefined) : undefined;
    if (typeof locks?.request === "function") {
      await locks.request("avs-render", { ifAvailable: true }, async (lock) => {
        if (!lock) {
          setState({
            kind: "error",
            message: "Another video is rendering in this browser. Wait for it to finish.",
          });
          return;
        }
        await work();
      });
    } else await work();
  }

  const stageIndex = running ? STAGES.findIndex((s) => s.key === state.stage) : -1;
  const overall = running ? Math.min(0.99, (stageIndex + state.progress) / STAGES.length) : 0;

  return (
    <div className="render-panel" aria-live="polite">
      {state.kind === "error" && <ErrorBox message={state.message} onRetry={() => void run()} />}
      {running ? (
        <>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(overall * 100)}
            aria-label="Render progress"
          >
            <div className="progress-bar" style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
          <p className="small render-stage">
            <strong>{STAGES[stageIndex]?.label}</strong>
            {state.detail ? ` · ${state.detail}` : ""}
          </p>
          <p className="muted small">
            Keep this tab open. Rendering uses your device, not the cloud.
          </p>
          <button type="button" className="btn wide" onClick={() => abortRef.current?.abort()}>
            Stop rendering
          </button>
        </>
      ) : state.kind === "done" ? (
        <p className="small">✓ Uploaded. Finishing up…</p>
      ) : (
        <>
          <div className="quality" role="group" aria-label="Quality">
            {(["720p", "1080p"] as const).map((q) => (
              <button
                key={q}
                type="button"
                className={`chip${quality === q ? " active" : ""}`}
                aria-pressed={quality === q}
                onClick={() => setQuality(q)}
              >
                {q}
              </button>
            ))}
          </div>
          <button type="button" className="btn primary wide" onClick={() => void run()}>
            Render video
          </button>
          <p className="muted small">
            Takes about a minute in your browser. Nothing is uploaded until it's done.
          </p>
        </>
      )}
    </div>
  );
}

export function FinalVideo({ asset, aspect }: { asset: Asset; aspect: string }) {
  const src = assetUrl(asset.project_id, asset.id);
  const mb = asset.file_size ? `${(asset.file_size / 1048576).toFixed(1)} MB` : "";
  return (
    <div className="card final-video">
      <h2>Your video</h2>
      <video
        className={`player ratio-${aspect.replace(":", "x")}`}
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label="Final video"
      />
      <div className="actions">
        <span className="muted small">MP4 · H.264/AAC {mb && `· ${mb}`}</span>
        <a className="btn primary" href={`${src}?download=1`} download>
          Download MP4
        </a>
      </div>
    </div>
  );
}
