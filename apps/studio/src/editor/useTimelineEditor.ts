import type { Timeline } from "@avs/schemas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, getTimeline, saveTimeline } from "../services/api";
import {
  coalesceKey,
  initialHistory,
  record,
  redo as redoHistory,
  tryCommand,
  undo as undoHistory,
  type EditorCommand,
  type History,
} from "./commands";
import { localDraftStore, type Draft, type DraftStore } from "./drafts";

/**
 * Editor state (ADR 045): the timeline with undo/redo, autosave to this device (0.3 s) and to
 * the server (2 s after the last edit, with conflict detection), recovery of unsaved edits, and
 * conflict resolution when another tab or device saved first.
 */

export const LOCAL_SAVE_MS = 300;
export const SERVER_SAVE_MS = 2000;
export const RETRY_SAVE_MS = 10_000;

export type SaveStatus = "saved" | "unsaved" | "saving" | "offline" | "conflict";

export interface EditorState {
  loading: boolean;
  loadError: string | null;
  timeline: Timeline | null;
  revision: number;
  status: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  /** The last refused edit or save problem, in plain language. */
  notice: string | null;
  /** Unsaved edits found on this device from an earlier visit. */
  recovery: { draft: Draft; stale: boolean } | null;
}

export function useTimelineEditor(
  projectId: string,
  deps: { store?: DraftStore; now?: () => number } = {},
) {
  const store = useMemo(() => deps.store ?? localDraftStore(), [deps.store]);
  const now = deps.now ?? Date.now;
  const [history, setHistory] = useState<History | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<EditorState["recovery"]>(null);

  // Refs mirror state for async callbacks and timers.
  const presentRef = useRef<Timeline | null>(null);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<SaveStatus>("saved");
  const setStatusBoth = (s: SaveStatus) => {
    statusRef.current = s;
    setStatus(s);
  };

  const clearTimers = () => {
    if (localTimer.current) clearTimeout(localTimer.current);
    if (serverTimer.current) clearTimeout(serverTimer.current);
    localTimer.current = serverTimer.current = null;
  };

  const writeDraft = useCallback(() => {
    const t = presentRef.current;
    if (!t || !dirtyRef.current) return;
    store.put({
      projectId,
      baseRevision: revisionRef.current,
      timeline: t,
      savedAt: new Date(now()).toISOString(),
    });
  }, [projectId, store, now]);

  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const saveNow = useCallback(async (): Promise<void> => {
    const t = presentRef.current;
    if (!t || !dirtyRef.current || savingRef.current || statusRef.current === "conflict") return;
    savingRef.current = true;
    setStatusBoth("saving");
    try {
      const saved = await saveTimeline(projectId, revisionRef.current, t);
      revisionRef.current = saved.revision;
      setRevision(saved.revision);
      if (presentRef.current === t) {
        dirtyRef.current = false;
        store.remove(projectId);
        setStatusBoth("saved");
      } else {
        // More edits arrived while saving: save those too.
        setStatusBoth("unsaved");
        writeDraft();
        serverTimer.current = setTimeout(() => void saveRef.current(), SERVER_SAVE_MS);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "CONFLICT") {
        setStatusBoth("conflict");
      } else if (err instanceof ApiClientError && err.status >= 400 && err.status < 500) {
        // The server refused this timeline: keep it on the device and say why.
        setStatusBoth("unsaved");
        setNotice(`Couldn't save: ${err.message}`);
      } else {
        setStatusBoth("offline");
        serverTimer.current = setTimeout(() => void saveRef.current(), RETRY_SAVE_MS);
      }
    } finally {
      savingRef.current = false;
    }
  }, [projectId, store, writeDraft]);
  useEffect(() => {
    saveRef.current = saveNow;
  }, [saveNow]);

  const changed = useCallback(
    (next: History) => {
      setHistory(next);
      presentRef.current = next.present;
      dirtyRef.current = true;
      if (statusRef.current !== "conflict") setStatusBoth("unsaved");
      if (localTimer.current) clearTimeout(localTimer.current);
      localTimer.current = setTimeout(writeDraft, LOCAL_SAVE_MS);
      if (serverTimer.current) clearTimeout(serverTimer.current);
      serverTimer.current = setTimeout(() => void saveNow(), SERVER_SAVE_MS);
    },
    [saveNow, writeDraft],
  );

  // Load.
  useEffect(() => {
    let live = true;
    getTimeline(projectId).then(
      (server) => {
        if (!live) return;
        revisionRef.current = server.revision;
        setRevision(server.revision);
        presentRef.current = server.timeline;
        setHistory(initialHistory(server.timeline));
        const draft = store.get(projectId);
        if (draft && JSON.stringify(draft.timeline) !== JSON.stringify(server.timeline))
          setRecovery({ draft, stale: draft.baseRevision !== server.revision });
        else if (draft) store.remove(projectId);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setLoadError(err instanceof Error ? err.message : "Couldn't load the timeline.");
        setLoading(false);
      },
    );
    return () => {
      live = false;
      clearTimers();
    };
  }, [projectId, store]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      writeDraft();
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [writeDraft]);

  const dispatch = useCallback(
    (cmd: EditorCommand): boolean => {
      if (!history) return false;
      const res = tryCommand(history.present, cmd);
      if (!res.ok) {
        setNotice(res.reason);
        return false;
      }
      setNotice(null);
      if (res.timeline !== history.present)
        changed(record(history, res.timeline, coalesceKey(cmd), now()));
      return true;
    },
    [history, changed, now],
  );

  const undo = useCallback(() => {
    if (history?.past.length) changed(undoHistory(history));
  }, [history, changed]);
  const redo = useCallback(() => {
    if (history?.future.length) changed(redoHistory(history));
  }, [history, changed]);

  const restoreDraft = useCallback(() => {
    if (!history || !recovery) return;
    setRecovery(null);
    // Restoring is undoable; saving it replaces what's on the server (the user chose this).
    changed(record(history, recovery.draft.timeline, null, now()));
  }, [history, recovery, changed, now]);

  const discardDraft = useCallback(() => {
    store.remove(projectId);
    setRecovery(null);
  }, [store, projectId]);

  /** After a conflict: keep this device's version (saved over the other) or load the other. */
  const resolveConflict = useCallback(
    async (keep: "mine" | "theirs") => {
      const server = await getTimeline(projectId);
      revisionRef.current = server.revision;
      setRevision(server.revision);
      if (keep === "theirs") {
        clearTimers();
        dirtyRef.current = false;
        store.remove(projectId);
        presentRef.current = server.timeline;
        setHistory(initialHistory(server.timeline));
        setStatusBoth("saved");
        return;
      }
      setStatusBoth("unsaved");
      dirtyRef.current = true;
      await saveNow();
    },
    [projectId, store, saveNow],
  );

  /** Replace the whole timeline (e.g. a restored version from the server), not undoable. */
  const replaceFromServer = useCallback(
    (t: Timeline, rev: number) => {
      clearTimers();
      revisionRef.current = rev;
      setRevision(rev);
      dirtyRef.current = false;
      store.remove(projectId);
      presentRef.current = t;
      setHistory(initialHistory(t));
      setStatusBoth("saved");
    },
    [store, projectId],
  );

  const state: EditorState = {
    loading,
    loadError,
    timeline: history?.present ?? null,
    revision,
    status,
    canUndo: !!history?.past.length,
    canRedo: !!history?.future.length,
    notice,
    recovery,
  };
  return {
    state,
    dispatch,
    undo,
    redo,
    saveNow,
    restoreDraft,
    discardDraft,
    resolveConflict,
    replaceFromServer,
    dismissNotice: () => setNotice(null),
  };
}
