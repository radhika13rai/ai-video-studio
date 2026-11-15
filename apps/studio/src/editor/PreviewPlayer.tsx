import type { Asset } from "@avs/contracts";
import type { PreviewController, PreviewState } from "@avs/renderer";
import { compileTimeline, type RenderManifest, type Timeline } from "@avs/schemas";
import { useEffect, useMemo, useRef, useState } from "react";
import { assetUrl } from "../services/api";

/**
 * Live preview of the timeline being edited (ADR 046): compiles the timeline into a manifest in
 * the browser and plays it with the renderer's preview engine (same painter and mix as the
 * export). Edits rebuild it after a short pause; selecting a scene jumps to it.
 */

export const REBUILD_MS = 400;

/** The manifest the server would compile for this timeline, built here for the preview. */
export function previewManifest(
  projectId: string,
  title: string,
  timeline: Timeline,
  assets: Asset[],
): RenderManifest {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const c = compileTimeline(timeline, (id) => {
    const a = byId.get(id);
    if (!a) return null;
    const credit = typeof a.license?.credit === "string" ? a.license.credit : null;
    return { url: assetUrl(projectId, a.id), credit };
  });
  return {
    render_request_id: "preview",
    render_attempt_token: "preview",
    project: {
      id: projectId,
      title,
      aspect_ratio: c.aspect_ratio,
      duration_seconds: c.duration_seconds,
    },
    scenes: c.scenes,
    fallbacks: [],
    ...(c.music ? { music: c.music } : {}),
    ...(c.captions ? { captions: c.captions } : {}),
    ...(c.audio ? { audio: c.audio } : {}),
  };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function PreviewPlayer({
  projectId,
  title,
  timeline,
  assets,
  selectedIndex,
  onTimeScene,
}: {
  projectId: string;
  title: string;
  timeline: Timeline;
  assets: Asset[];
  selectedIndex: number;
  /** Called with the scene playing, so the timeline can follow the playhead. */
  onTimeScene?: (index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [controller, setController] = useState<PreviewController | null>(null);
  const [state, setState] = useState<PreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voicing, setVoicing] = useState<string | null>(null);
  const manifest = useMemo(
    () => previewManifest(projectId, title, timeline, assets),
    [projectId, title, timeline, assets],
  );
  const latest = useRef(manifest);
  useEffect(() => {
    latest.current = manifest;
  }, [manifest]);

  // Create once; destroy on unmount.
  useEffect(() => {
    let live = true;
    let created: PreviewController | null = null;
    (async () => {
      try {
        const { createPreview } = await import("@avs/renderer");
        if (!live || !canvasRef.current) return;
        created = await createPreview(canvasRef.current, latest.current, {}, (s) => {
          if (live) setState(s);
        });
        if (!live) return created.destroy();
        setController(created);
        setState(created.state);
      } catch (e) {
        if (live)
          setError(e instanceof Error ? e.message : "The preview can't run in this browser.");
      }
    })();
    return () => {
      live = false;
      created?.destroy();
    };
  }, []);

  // Rebuild after edits (debounced).
  useEffect(() => {
    const c = controller;
    if (!c) return;
    const timer = setTimeout(() => void c.update(manifest).catch(() => undefined), REBUILD_MS);
    return () => clearTimeout(timer);
  }, [manifest, controller]);

  // Jump to the selected scene when paused.
  useEffect(() => {
    const c = controller;
    if (c && !c.state.playing) c.seek(c.sceneStart(selectedIndex));
  }, [selectedIndex, controller]);

  // Follow the playhead.
  const playingScene = useMemo(() => {
    const c = controller;
    if (!c || !state?.playing) return null;
    let k = 0;
    for (let i = 0; i < timeline.clips.length; i++) if (c.sceneStart(i) <= state.seconds) k = i;
    return k;
  }, [state, timeline.clips.length, controller]);
  useEffect(() => {
    if (playingScene !== null) onTimeScene?.(playingScene);
  }, [playingScene, onTimeScene]);

  const c = controller;
  return (
    <div className="preview-player">
      <div
        className={`editor-preview aspect-${timeline.aspect_ratio.replace(":", "x")}`}
        aria-label="Preview"
      >
        <canvas ref={canvasRef} aria-label="Video preview" />
        {error && <div className="preview-card">{error}</div>}
      </div>
      <div className="transport">
        <button
          type="button"
          className="btn small primary"
          disabled={!c}
          aria-label={state?.playing ? "Pause" : "Play"}
          onClick={() => (state?.playing ? c?.pause() : void c?.play())}
        >
          {state?.playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          aria-label="Playhead"
          min={0}
          max={state?.duration ?? 0}
          step={0.05}
          value={state?.seconds ?? 0}
          disabled={!c}
          onChange={(e) => c?.seek(Number(e.target.value))}
        />
        <span className="time">
          {clock(state?.seconds ?? 0)} / {clock(state?.duration ?? 0)}
        </span>
      </div>
      {state && state.narrated > state.voiced && (
        <p className="small muted voice-note">
          {voicing ??
            `${state.narrated - state.voiced} scene${state.narrated - state.voiced > 1 ? "s" : ""} not voiced in the preview yet (captions show the words).`}{" "}
          {!voicing && (
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                setVoicing("Loading the voice…");
                try {
                  await c?.voice((done, total) =>
                    setVoicing(`Voicing ${done + 1 > total ? total : done + 1} of ${total}…`),
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't voice the preview.");
                } finally {
                  setVoicing(null);
                }
              }}
            >
              Voice the preview
            </button>
          )}
        </p>
      )}
    </div>
  );
}
