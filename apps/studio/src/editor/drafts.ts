import { timelineSchema, type Timeline } from "@avs/schemas";

/**
 * Unsaved edits kept on this device (ADR 045), so a closed tab, a crash or a lost connection
 * never loses work. A timeline is small (≤ 256 KB), so localStorage is enough and works the same
 * everywhere; every access is guarded because storage can be full, blocked or missing.
 */
export interface Draft {
  projectId: string;
  /** The server revision these edits started from. */
  baseRevision: number;
  timeline: Timeline;
  savedAt: string;
}

export interface DraftStore {
  get(projectId: string): Draft | null;
  put(draft: Draft): void;
  remove(projectId: string): void;
}

const key = (projectId: string) => `avs:timeline-draft:${projectId}`;

export function localDraftStore(
  storage: Storage | undefined = globalThis.localStorage,
): DraftStore {
  return {
    get(projectId) {
      try {
        const raw = storage?.getItem(key(projectId));
        if (!raw) return null;
        const d = JSON.parse(raw) as Partial<Draft>;
        const t = timelineSchema.safeParse(d.timeline);
        if (!t.success || typeof d.baseRevision !== "number" || typeof d.savedAt !== "string")
          return null;
        return { projectId, baseRevision: d.baseRevision, timeline: t.data, savedAt: d.savedAt };
      } catch {
        return null;
      }
    },
    put(draft) {
      try {
        storage?.setItem(key(draft.projectId), JSON.stringify(draft));
      } catch {
        // Full or blocked storage: the server save still runs.
      }
    },
    remove(projectId) {
      try {
        storage?.removeItem(key(projectId));
      } catch {
        // ignore
      }
    },
  };
}

/** For tests. */
export function memoryDraftStore(): DraftStore & { drafts: Map<string, Draft> } {
  const drafts = new Map<string, Draft>();
  return {
    drafts,
    get: (id) => drafts.get(id) ?? null,
    put: (d) => void drafts.set(d.projectId, d),
    remove: (id) => void drafts.delete(id),
  };
}
