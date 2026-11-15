import type { Asset, Project } from "@avs/contracts";
import type { TimelineRevision } from "@avs/schemas";
import { ASPECT_RATIOS } from "@avs/types";
import { useCallback, useEffect, useState } from "react";
import { ErrorBox } from "../components/Feedback";
import { Link, navigate } from "../lib/router";
import {
  exportProject,
  getProject,
  regenerateScene,
  listAssets,
  listTimelineRevisions,
  restoreTimelineRevision,
} from "../services/api";
import type { EditorCommand } from "./commands";
import type { DraftStore } from "./drafts";
import { Inspector } from "./Inspector";
import { PreviewPlayer } from "./PreviewPlayer";
import { SceneVersions } from "./SceneVersions";
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
  const { state, undo, redo, dispatch: applyEdit } = editor;
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("scene");
  const [zoom, setZoom] = useState(1);
  const [versions, setVersions] = useState<TimelineRevision[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

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
    (cmd: EditorCommand) => {
      if (clip && selectedId !== clip.id) setSelectedId(clip.id);
      return applyEdit(cmd);
    },
    [clip, selectedId, applyEdit],
  );

  // While playing, the timeline follows the scene on screen.
  const followPlayhead = useCallback(
    (i: number) => {
      const c = t?.clips[i];
      if (c) {
        setSelectedId(c.id);
        setIndexHint(i);
      }
    },
    [t],
  );

  /** Puts a scene version on the clip (an undoable edit). */
  const applyVersion = (clipId: string, asset: Asset) =>
    dispatch({
      type: "updateClip",
      clipId,
      patch:
        asset.asset_type === "video"
          ? { video_asset_id: asset.id }
          : { image_asset_id: asset.id, video_asset_id: null },
    });

  /** Saves, then starts a render-only run and goes to the project page to render. */
  const exportVideo = async () => {
    setExporting(true);
    try {
      await editor.saveNow();
      await exportProject(id);
      navigate(`/projects/${id}`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Couldn't start the export.");
      setExporting(false);
    }
  };

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
          {project?.status === "awaiting_render" ? (
            <Link href={`/projects/${id}`} className="btn small primary">
              Render…
            </Link>
          ) : (
            <button
              type="button"
              className="btn small primary"
              disabled={exporting || state.status === "conflict"}
              onClick={() => void exportVideo()}
            >
              {exporting ? "Starting…" : "Export video"}
            </button>
          )}
        </div>
      </header>
      {exportError && (
        <div className="banner warn" role="alert">
          <p>{exportError}</p>
          <button type="button" className="btn small" onClick={() => setExportError(null)}>
            OK
          </button>
        </div>
      )}

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

      <PreviewPlayer
        projectId={id}
        title={project?.title ?? ""}
        timeline={t}
        assets={assets}
        selectedIndex={index}
        onTimeScene={followPlayhead}
      />
      <span className="small muted preview-meta-line">
        Scene {index + 1} of {t.clips.length} · {total.toFixed(1)} s planned
      </span>

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
        versions={
          <SceneVersions
            clip={clip}
            assets={assets}
            onRegenerate={async (what, prompt) => {
              const { asset } = await regenerateScene(id, clip.scene_id, what, prompt);
              setAssets((list) => [...list, asset]);
              applyVersion(clip.id, asset);
            }}
            onUse={(asset) => applyVersion(clip.id, asset)}
          />
        }
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
