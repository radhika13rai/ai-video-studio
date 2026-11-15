import type { Asset } from "@avs/contracts";
import type { Clip, Timeline } from "@avs/schemas";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { assetUrl } from "../services/api";
import { dropIndex, trimmedDuration, type EditorCommand } from "./commands";

/**
 * The timeline: clips side by side (width ∝ length) with lanes for voice, text, sound effects
 * and music below. Clips are reordered by dragging (pointer events: mouse, pen and touch, where
 * a long press starts the drag so scrolling still works) and lengthened by dragging their right
 * edge. Every drag has a button or keyboard equivalent in the inspector.
 */

export type InspectorTab = "scene" | "voice" | "text" | "audio";

const LONG_PRESS_MS = 300;
const DRAG_START_PX = 8;

export function TimelineView({
  timeline,
  assets,
  selectedId,
  pxPerSecond,
  onSelect,
  dispatch,
}: {
  timeline: Timeline;
  assets: Asset[];
  selectedId: string | null;
  pxPerSecond: number;
  onSelect: (clipId: string, tab?: InspectorTab) => void;
  dispatch: (cmd: EditorCommand) => boolean;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const press = useRef<{
    index: number;
    x: number;
    y: number;
    pointerType: string;
    timer: ReturnType<typeof setTimeout> | null;
    active: boolean;
  } | null>(null);
  const width = (c: Clip) => Math.max(56, c.duration_s * pxPerSecond);
  const byId = new Map(assets.map((a) => [a.id, a]));

  const extents = () =>
    Array.from(laneRef.current?.querySelectorAll<HTMLElement>("[data-clip-index]") ?? []).map(
      (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, width: r.width };
      },
    );

  const startDrag = (index: number) => {
    if (!press.current) return;
    press.current.active = true;
    setDrag({ from: index, to: index });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, index: number) => {
    if ((e.target as HTMLElement).closest("[data-trim]")) return;
    press.current = {
      index,
      x: e.clientX,
      y: e.clientY,
      pointerType: e.pointerType,
      timer: e.pointerType === "touch" ? setTimeout(() => startDrag(index), LONG_PRESS_MS) : null,
      active: false,
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.active) {
      const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (p.pointerType === "touch") {
        if (moved > DRAG_START_PX && p.timer) {
          clearTimeout(p.timer); // the finger is scrolling, not holding
          press.current = null;
        }
        return;
      }
      if (moved < DRAG_START_PX) return;
      startDrag(p.index);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    e.preventDefault();
    setDrag({ from: p.index, to: dropIndex(e.clientX, extents()) });
  };
  const onPointerUp = () => {
    const p = press.current;
    press.current = null;
    if (p?.timer) clearTimeout(p.timer);
    if (p?.active && drag && drag.to !== drag.from)
      dispatch({ type: "moveClip", from: drag.from, to: drag.to });
    setDrag(null);
  };

  return (
    <div className="timeline" aria-label="Timeline">
      <div
        className="lane video-lane"
        ref={laneRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {timeline.clips.map((c, i) => {
          const img = c.image_asset_id ? byId.get(c.image_asset_id) : undefined;
          const style = {
            width: width(c),
            ...(img ? { backgroundImage: `url(${assetUrl(img.project_id, img.id)})` } : {}),
          };
          const dropping = drag && drag.to === i && drag.from !== i;
          return (
            <div
              key={c.id}
              data-clip-index={i}
              className={`clip${c.id === selectedId ? " selected" : ""}${drag?.from === i ? " dragging" : ""}${dropping ? " drop-target" : ""}${c.visual_type === "text" || !img ? " text-card" : ""}`}
              style={style}
              onPointerDown={(e) => onPointerDown(e, i)}
            >
              <button
                type="button"
                className="clip-select"
                aria-pressed={c.id === selectedId}
                aria-label={`Scene ${i + 1}, ${c.duration_s.toFixed(1)} seconds${c.video_asset_id ? ", footage" : ""}`}
                onClick={() => onSelect(c.id, "scene")}
              >
                <span className="clip-num">{i + 1}</span>
                {c.video_asset_id && <span className="clip-badge">🎬</span>}
                <span className="clip-dur">{c.duration_s.toFixed(1)}s</span>
              </button>
              <TrimHandle
                clip={c}
                index={i}
                pxPerSecond={pxPerSecond}
                onTrim={(seconds) => dispatch({ type: "setDuration", clipId: c.id, seconds })}
              />
            </div>
          );
        })}
      </div>
      <Lane
        label="Voice"
        timeline={timeline}
        width={width}
        selectedId={selectedId}
        onSelect={(id) => onSelect(id, "voice")}
        render={(c) =>
          c.voice.mode === "none" ? (
            <span className="muted">—</span>
          ) : (
            <span>🎙 {c.voice.text.slice(0, 40)}</span>
          )
        }
      />
      <Lane
        label="Text"
        timeline={timeline}
        width={width}
        selectedId={selectedId}
        onSelect={(id) => onSelect(id, "text")}
        render={(c) => (
          <span>
            {c.overlays.length ? `T ×${c.overlays.length}` : ""}
            {c.on_screen_text ? ` “${c.on_screen_text.slice(0, 20)}”` : ""}
          </span>
        )}
      />
      <Lane
        label="Sound"
        timeline={timeline}
        width={width}
        selectedId={selectedId}
        onSelect={(id) => onSelect(id, "audio")}
        render={(c) => (
          <span className="sfx-marks">
            {c.sfx.map((s) => (
              <i key={s.id} style={{ left: `${(s.at_s / c.duration_s) * 100}%` }} title={s.kind} />
            ))}
          </span>
        )}
      />
      <div className="lane music-lane" aria-label="Music">
        <span>
          ♪{" "}
          {timeline.music.mode === "none"
            ? "No music"
            : `Music · ${timeline.music.mood ?? "default"}`}
        </span>
      </div>
    </div>
  );
}

function Lane({
  label,
  timeline,
  width,
  selectedId,
  onSelect,
  render,
}: {
  label: string;
  timeline: Timeline;
  width: (c: Clip) => number;
  selectedId: string | null;
  onSelect: (clipId: string) => void;
  render: (c: Clip) => React.ReactNode;
}) {
  return (
    <div className="lane" aria-label={label}>
      {timeline.clips.map((c, i) => (
        <button
          key={c.id}
          type="button"
          className={`lane-cell${c.id === selectedId ? " selected" : ""}`}
          style={{ width: width(c) }}
          aria-label={`${label}, scene ${i + 1}`}
          onClick={() => onSelect(c.id)}
        >
          {render(c)}
        </button>
      ))}
    </div>
  );
}

function TrimHandle({
  clip,
  index,
  pxPerSecond,
  onTrim,
}: {
  clip: Clip;
  index: number;
  pxPerSecond: number;
  onTrim: (seconds: number) => void;
}) {
  const start = useRef<{ x: number; seconds: number } | null>(null);
  return (
    <span
      data-trim
      className="trim-handle"
      role="separator"
      aria-label={`Change the length of scene ${index + 1}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        start.current = { x: e.clientX, seconds: clip.duration_s };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        e.preventDefault();
        onTrim(trimmedDuration(start.current.seconds, e.clientX - start.current.x, pxPerSecond));
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    />
  );
}
