import {
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  timelineSchema,
  type Clip,
  type SfxCue,
  type TextOverlay,
  type Timeline,
} from "@avs/schemas";

/**
 * Every edit is a typed command applied by a pure reducer (ADR 045). The editor validates the
 * result against the timeline schema, so an edit that would break it (a video over the length
 * limit, say) is refused with a message instead of being saved.
 */
export type EditorCommand =
  | { type: "moveClip"; from: number; to: number }
  | { type: "setDuration"; clipId: string; seconds: number }
  | {
      type: "updateClip";
      clipId: string;
      patch: Partial<
        Pick<
          Clip,
          | "caption"
          | "shot"
          | "camera"
          | "transition_in"
          | "focal"
          | "trim_in_s"
          | "on_screen_text"
          | "image_asset_id"
          | "video_asset_id"
        >
      >;
    }
  | { type: "updateVoice"; clipId: string; patch: Partial<Clip["voice"]> }
  | { type: "duplicateClip"; clipId: string; newId: string }
  | { type: "deleteClip"; clipId: string }
  | { type: "addOverlay"; clipId: string; overlay: TextOverlay }
  | { type: "updateOverlay"; clipId: string; overlayId: string; patch: Partial<TextOverlay> }
  | { type: "removeOverlay"; clipId: string; overlayId: string }
  | { type: "addSfx"; clipId: string; sfx: SfxCue }
  | { type: "updateSfx"; clipId: string; sfxId: string; patch: Partial<SfxCue> }
  | { type: "removeSfx"; clipId: string; sfxId: string }
  | { type: "setCaptions"; patch: Partial<Timeline["captions"]> }
  | { type: "setMusic"; patch: Partial<Timeline["music"]> }
  | { type: "setAutoTransitionSfx"; on: boolean }
  | { type: "setAspect"; aspect: Timeline["aspect_ratio"] };

/** Rounds to 0.1 s without binary-fraction drift (3.4, not 3.4000000000000004). */
const round = (n: number) => Math.round(n * 10) / 10;

/** Keeps a clip's overlays and sounds inside it after its length changed. */
function fitInside(c: Clip): Clip {
  const d = c.duration_s;
  return {
    ...c,
    overlays: c.overlays.map((o) => {
      const start = Math.min(o.start_s, Math.max(0, d - 0.2));
      return { ...o, start_s: start, duration_s: Math.max(0.2, Math.min(o.duration_s, d - start)) };
    }),
    sfx: c.sfx.map((s) => ({ ...s, at_s: Math.min(s.at_s, Math.max(0, d - 0.05)) })),
  };
}

const mapClip = (t: Timeline, id: string, f: (c: Clip) => Clip): Timeline => ({
  ...t,
  clips: t.clips.map((c) => (c.id === id ? f(c) : c)),
});

export function clampDuration(seconds: number): number {
  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, round(seconds)));
}

/** Applies a command. Pure: returns a new timeline (the input is never changed). */
export function applyCommand(t: Timeline, cmd: EditorCommand): Timeline {
  switch (cmd.type) {
    case "moveClip": {
      const n = t.clips.length;
      if (cmd.from < 0 || cmd.from >= n || cmd.from === cmd.to) return t;
      const to = Math.max(0, Math.min(n - 1, cmd.to));
      const clips = [...t.clips];
      const [moved] = clips.splice(cmd.from, 1);
      clips.splice(to, 0, moved!);
      return { ...t, clips };
    }
    case "setDuration":
      return mapClip(t, cmd.clipId, (c) =>
        fitInside({ ...c, duration_s: clampDuration(cmd.seconds) }),
      );
    case "updateClip":
      return mapClip(t, cmd.clipId, (c) => ({ ...c, ...cmd.patch }));
    case "updateVoice":
      return mapClip(t, cmd.clipId, (c) => ({ ...c, voice: { ...c.voice, ...cmd.patch } }));
    case "duplicateClip": {
      const i = t.clips.findIndex((c) => c.id === cmd.clipId);
      if (i < 0) return t;
      const src = t.clips[i]!;
      const suffix = cmd.newId.slice(-6);
      const copy: Clip = {
        ...src,
        id: cmd.newId,
        overlays: src.overlays.map((o) => ({ ...o, id: `${o.id}-${suffix}`.slice(0, 64) })),
        sfx: src.sfx.map((s) => ({ ...s, id: `${s.id}-${suffix}`.slice(0, 64) })),
      };
      const clips = [...t.clips];
      clips.splice(i + 1, 0, copy);
      return { ...t, clips };
    }
    case "deleteClip":
      if (t.clips.length <= 1) return t; // a video needs at least one clip
      return { ...t, clips: t.clips.filter((c) => c.id !== cmd.clipId) };
    case "addOverlay":
      return mapClip(t, cmd.clipId, (c) =>
        fitInside({ ...c, overlays: [...c.overlays, cmd.overlay] }),
      );
    case "updateOverlay":
      return mapClip(t, cmd.clipId, (c) =>
        fitInside({
          ...c,
          overlays: c.overlays.map((o) => (o.id === cmd.overlayId ? { ...o, ...cmd.patch } : o)),
        }),
      );
    case "removeOverlay":
      return mapClip(t, cmd.clipId, (c) => ({
        ...c,
        overlays: c.overlays.filter((o) => o.id !== cmd.overlayId),
      }));
    case "addSfx":
      return mapClip(t, cmd.clipId, (c) => fitInside({ ...c, sfx: [...c.sfx, cmd.sfx] }));
    case "updateSfx":
      return mapClip(t, cmd.clipId, (c) =>
        fitInside({
          ...c,
          sfx: c.sfx.map((s) => (s.id === cmd.sfxId ? { ...s, ...cmd.patch } : s)),
        }),
      );
    case "removeSfx":
      return mapClip(t, cmd.clipId, (c) => ({
        ...c,
        sfx: c.sfx.filter((s) => s.id !== cmd.sfxId),
      }));
    case "setCaptions":
      return { ...t, captions: { ...t.captions, ...cmd.patch } };
    case "setMusic":
      return { ...t, music: { ...t.music, ...cmd.patch } };
    case "setAutoTransitionSfx":
      return { ...t, auto_transition_sfx: cmd.on };
    case "setAspect":
      return { ...t, aspect_ratio: cmd.aspect };
  }
}

/**
 * Commands of the same kind on the same thing in quick succession (typing, dragging a trim
 * handle) merge into one undo step.
 */
export function coalesceKey(cmd: EditorCommand): string | null {
  switch (cmd.type) {
    case "setDuration":
      return `dur:${cmd.clipId}`;
    case "updateClip":
    case "updateVoice":
      return `${cmd.type}:${cmd.clipId}:${Object.keys(cmd.patch).sort().join(",")}`;
    case "updateOverlay":
      return `ov:${cmd.overlayId}:${Object.keys(cmd.patch).sort().join(",")}`;
    case "updateSfx":
      return `sfx:${cmd.sfxId}:${Object.keys(cmd.patch).sort().join(",")}`;
    case "setCaptions":
    case "setMusic":
      return `${cmd.type}:${Object.keys(cmd.patch).sort().join(",")}`;
    default:
      return null;
  }
}

/** Applies and validates. Returns the reason when the result isn't a valid timeline. */
export function tryCommand(
  t: Timeline,
  cmd: EditorCommand,
): { ok: true; timeline: Timeline } | { ok: false; reason: string } {
  const next = applyCommand(t, cmd);
  if (next === t) return { ok: true, timeline: t };
  const parsed = timelineSchema.safeParse(next);
  if (parsed.success) return { ok: true, timeline: next };
  return { ok: false, reason: parsed.error.issues[0]?.message ?? "That edit isn't possible." };
}

/* --------------------------------- history --------------------------------- */

export const MAX_HISTORY = 100;
export const COALESCE_MS = 1000;

export interface History {
  past: Timeline[];
  present: Timeline;
  future: Timeline[];
  /** The last command's coalesce key and time, to merge rapid edits. */
  last: { key: string; at: number } | null;
}

export const initialHistory = (t: Timeline): History => ({
  past: [],
  present: t,
  future: [],
  last: null,
});

export function record(h: History, next: Timeline, key: string | null, now: number): History {
  if (next === h.present) return h;
  const merge = key !== null && h.last?.key === key && now - h.last.at < COALESCE_MS;
  return {
    past: merge ? h.past : [...h.past, h.present].slice(-MAX_HISTORY),
    present: next,
    future: [],
    last: key ? { key, at: now } : null,
  };
}

export function undo(h: History): History {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], last: null };
}

export function redo(h: History): History {
  const next = h.future[0];
  if (!next) return h;
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1), last: null };
}

/* -------------------------------- geometry -------------------------------- */

/** Where a dragged clip lands, from the pointer's x and the clips' horizontal extents. */
export function dropIndex(x: number, extents: { left: number; width: number }[]): number {
  let i = 0;
  for (const e of extents) {
    if (x < e.left + e.width / 2) return i;
    i++;
  }
  return Math.max(0, extents.length - 1);
}

/** A trim-handle drag: the new length from the start length and the pixels moved. */
export function trimmedDuration(startSeconds: number, dx: number, pxPerSecond: number): number {
  return clampDuration(startSeconds + dx / pxPerSecond);
}
