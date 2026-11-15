import type { Asset, Project } from "@avs/contracts";
import type { TimelineRevision } from "@avs/schemas";
import { ASPECT_RATIOS } from "@avs/types";
import { useCallback, useEffect, useState } from "react";
import { ErrorBox } from "../components/Feedback";
import { Link } from "../lib/router";
import {
  assetUrl,
  getProject,
  listAssets,
  listTimelineRevisions,
  restoreTimelineRevision,
} from "../services/api";
import type { DraftStore } from "./drafts";
import { Inspector } from "./Inspector";
import { TimelineView, type InspectorTab } from "./TimelineView";
import { useTimelineEditor, type SaveStatus } from "./useTimelineEditor";

/** The timeline editor (ADR 045): /projects/:id/edit. */

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: "All changes saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  offline: "Offline: changes kept on this device",
  conflict: "Changed elsewhere",
};

const ZOOMS = [12, 20, 32, 48];

export function EditorPage({ id, store }: { id: string; store?: DraftStore }) {
  const editor = useTimelineEditor(id, store ? { store } : {});
  const { state, undo, redo } = editor;
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("scene");
  const [zoom, setZoom] = useState(1);
  const [versions, setVersions] = useState<TimelineRevision[] | null>(null);

  useEffect(() => {
    getProject(id).then(setProject, () => undefined);
    listAssets(id).then(setAssets, () => undefined);
  }, [id]);

  const [indexHint, setIndexHint] = useState(0);
  const t = state.timeline;
  // The selected clip, or (after it was deleted) the one now in its place.
  const found = t ? t.clips.findIndex((c) => c.id === selectedId) : -1;
  const index = t ? (found >= 0 ? found : Math.min(indexHint, t.clips.length - 1)) : 0;
  const clip = t?.clips[index] ?? null;
  // Edits keep the selection on the same scene, wherever it moves.
  const dispatch = useCallback(
    (cmd: Parameters<typeof editor.dispatch>[0]) => {
      if (clip && selectedId !== clip.id) setSelectedId(clip.id);
      return editor.dispatch(cmd);
    },
    [clip, selectedId, editor],
  );

  const select = useCallback(
    (clipId: string, next?: InspectorTab) => {
      setSelectedId(clipId);
      const i = t?.clips.findIndex((c) => c.id === clipId) ?? -1;
      if (i >= 0) setIndexHint(i);
      if (next) setTab(next);
    },
    [t],
  );

  // Keyboard: undo/redo, choose and move scenes, delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select");
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        redo();
        return;
      }
      if (typing || !t || !clip) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        if (e.altKey) dispatch({ type: "moveClip", from: index, to: index + dir });
        else {
          const next = t.clips[index + dir];
          if (next) select(next.id);
        }
        e.preventDefault();
      } else if ((e.key === "Delete" || e.key === "Backspace") && t.clips.length > 1) {
        dispatch({ type: "deleteClip", clipId: clip.id });
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t, clip, index, undo, redo, dispatch, select]);

  if (state.loading) return <p className="muted">Loading the editor…</p>;
  if (state.loadError || !t || !clip)
    return (
      <section className="narrow">
        <ErrorBox message={state.loadError ?? "This video can't be edited yet."} />
        <Link href={`/projects/${id}`} className="btn">
          Back to the project
        </Link>
      </section>
    );

  const total = t.clips.reduce((n, c) => n + c.duration_s, 0);
  const preview = clip.image_asset_id
    ? assets.find((a) => a.id === clip.image_asset_id)
    : undefined;
  const footage = clip.video_asset_id
    ? assets.find((a) => a.id === clip.video_asset_id)
    : undefined;

  return (
    <section className="editor">
      <header className="editor-bar">
        <Link href={`/projects/${id}`} className="btn small" aria-label="Back to the project">
          ←
        </Link>
        <h1 className="editor-title">{project?.title ?? "Edit video"}</h1>
        <span className={`save-status ${state.status}`} role="status" aria-label="Save status">
          {STATUS_TEXT[state.status]}
        </span>
        <div className="editor-actions">
          <button
            type="button"
            className="btn small"
            onClick={undo}
            disabled={!state.canUndo}
            aria-label="Undo"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="btn small"
            onClick={redo}
            disabled={!state.canRedo}
            aria-label="Redo"
          >
            ↷ Redo
          </button>
          <select
            aria-label="Aspect ratio"
            value={t.aspect_ratio}
            onChange={(e) =>
              dispatch({ type: "setAspect", aspect: e.target.value as typeof t.aspect_ratio })
            }
          >
            {ASPECT_RATIOS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn small"
            onClick={() => listTimelineRevisions(id).then(setVersions, () => setVersions([]))}
          >
            Versions
          </button>
          <Link href={`/projects/${id}`} className="btn small primary">
            Render…
          </Link>
        </div>
      </header>

      {state.recovery && (
        <div className="banner" role="alert">
          <p>
            Unsaved edits from {new Date(state.recovery.draft.savedAt).toLocaleString()} were found
            on this device{state.recovery.stale ? " (the video was changed elsewhere since)" : ""}.
          </p>
          <button type="button" className="btn small primary" onClick={editor.restoreDraft}>
            Restore them
          </button>
          <button type="button" className="btn small" onClick={editor.discardDraft}>
            Discard
          </button>
        </div>
      )}
      {state.status === "conflict" && (
        <div className="banner warn" role="alert">
          <p>This video was saved from another tab or device while you were editing.</p>
          <button
            type="button"
            className="btn small primary"
            onClick={() => void editor.resolveConflict("mine")}
          >
            Keep my version
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => void editor.resolveConflict("theirs")}
          >
            Load the other version
          </button>
        </div>
      )}
      {state.notice && (
        <div className="banner info" role="alert">
          <p>{state.notice}</p>
          <button type="button" className="btn small" onClick={editor.dismissNotice}>
            OK
          </button>
        </div>
      )}
      {versions && (
        <div className="banner">
          <p>{versions.length ? "Saved versions:" : "No earlier versions yet."}</p>
          {versions.map((v) => (
            <button
              key={v.revision}
              type="button"
              className="btn small"
              onClick={async () => {
                const restored = await restoreTimelineRevision(id, v.revision, state.revision);
                editor.replaceFromServer(restored.timeline, restored.revision);
                setVersions(null);
              }}
            >
              {new Date(v.created_at).toLocaleString()}
            </button>
          ))}
          <button type="button" className="btn small" onClick={() => setVersions(null)}>
            Close
          </button>
        </div>
      )}

      <div
        className={`editor-preview aspect-${t.aspect_ratio.replace(":", "x")}`}
        aria-label="Preview"
      >
        {footage ? (
          <video
            src={assetUrl(footage.project_id, footage.id)}
            muted
            playsInline
            loop
            autoPlay
            style={{ objectPosition: `${clip.focal.x * 100}% ${clip.focal.y * 100}%` }}
          />
        ) : preview ? (
          <img
            src={assetUrl(preview.project_id, preview.id)}
            alt=""
            style={{ objectPosition: `${clip.focal.x * 100}% ${clip.focal.y * 100}%` }}
          />
        ) : (
          <div className="preview-card">
            {clip.caption ?? (clip.voice.text || clip.description)}
          </div>
        )}
        <span className="preview-meta">
          Scene {index + 1} of {t.clips.length} · {total.toFixed(1)} s total
        </span>
      </div>

      <div className="zoom">
        <button
          type="button"
          className="btn small"
          aria-label="Zoom out"
          disabled={zoom === 0}
          onClick={() => setZoom(zoom - 1)}
        >
          −
        </button>
        <button
          type="button"
          className="btn small"
          aria-label="Zoom in"
          disabled={zoom === ZOOMS.length - 1}
          onClick={() => setZoom(zoom + 1)}
        >
          +
        </button>
      </div>
      <TimelineView
        timeline={t}
        assets={assets}
        selectedId={clip.id}
        pxPerSecond={ZOOMS[zoom] ?? 20}
        onSelect={select}
        dispatch={dispatch}
      />
      <Inspector
        timeline={t}
        clip={clip}
        index={index}
        tab={tab}
        onTab={setTab}
        dispatch={dispatch}
      />
    </section>
  );
}
