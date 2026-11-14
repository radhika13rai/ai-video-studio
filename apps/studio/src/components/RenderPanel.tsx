import type { Asset, Project } from "@avs/contracts";
import { KOKORO_VOICES, MAX_RENDER_BYTES, type KokoroVoiceId } from "@avs/contracts";
import type { RenderProgress, RenderStage } from "@avs/renderer";
import { useEffect, useRef, useState } from "react";
import { abortRender, assetUrl, completeRender, startRender, uploadRender } from "../services/api";
import { ErrorBox } from "./Feedback";

const STAGES: { key: RenderStage | "upload" | "finish"; label: string }[] = [
  { key: "loading", label: "Preparing pictures, depth and voice" },
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
  const [voice, setVoice] = useState<KokoroVoiceId>(() =>
    remembered("avs-voice", KOKORO_VOICES[0].id),
  );
  const [music, setMusic] = useState<boolean>(() => remembered("avs-music", "on") === "on");
  const abortRef = useRef<AbortController | null>(null);
  const retry = renderRetryOf(project.production_config);
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
          voice,
          music,
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
          {retry && (
            <p className="small render-retry" role="status">
              <strong>
                Attempt {retry.attempt} of {retry.max}
              </strong>
              {retry.reason ? `: the last render failed its quality check (${retry.reason})` : ""}.
              Your scenes, images and narration are kept; render again to try once more.
            </p>
          )}
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
          <label className="field">
            <span className="small">Voice</span>
            <select
              value={voice}
              onChange={(e) => {
                const v = e.target.value as KokoroVoiceId;
                setVoice(v);
                remember("avs-voice", v);
              }}
            >
              {KOKORO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="check small">
            <input
              type="checkbox"
              checked={music}
              onChange={(e) => {
                setMusic(e.target.checked);
                remember("avs-music", e.target.checked ? "on" : "off");
              }}
            />{" "}
            Background music
          </label>
          <button type="button" className="btn primary wide" onClick={() => void run()}>
            Render video
          </button>
          <p className="muted small">
            Takes a few minutes in your browser (the first time also downloads the voice and 3D
            models, about 120 MB). Nothing is uploaded until it's done.
          </p>
        </>
      )}
    </div>
  );
}

/** Render attempt info written by the workflow after a failed quality check (attempt 2+). */
export function renderRetryOf(
  config: Record<string, unknown>,
): { attempt: number; max: number; reason: string | null } | null {
  const r = config.render_request as
    { attempt?: unknown; max_attempts?: unknown; last_failure?: unknown } | undefined;
  if (!r || typeof r.attempt !== "number" || r.attempt < 2) return null;
  const reason =
    typeof r.last_failure === "string"
      ? r.last_failure.replace(/^Quality check failed:\s*/, "").slice(0, 160)
      : null;
  return {
    attempt: r.attempt,
    max: typeof r.max_attempts === "number" ? r.max_attempts : r.attempt,
    reason,
  };
}

function remembered<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
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
