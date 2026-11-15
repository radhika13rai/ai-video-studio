import { KOKORO_VOICES } from "@avs/contracts";
import {
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  DEFAULT_TRANSITION_SECONDS,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  OVERLAY_ANIMATIONS,
  OVERLAY_PRESETS,
  SFX_KINDS,
  type Clip,
  type Timeline,
} from "@avs/schemas";
import { CAMERA_MOVES, MUSIC_MOODS, SCENE_TRANSITIONS, SHOT_SIZES } from "@avs/types";
import type { ReactNode } from "react";
import type { EditorCommand } from "./commands";
import { GraphicsEditor } from "./GraphicsEditor";
import type { InspectorTab } from "./TimelineView";

/** Settings for the selected scene (and the video's captions and audio). */

const label = (s: string) => s.replace(/_/g, " ");
const newId = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

function Field({
  label: l,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string | undefined;
}) {
  return (
    <label className="field">
      <span>{l}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function Range({
  value,
  min,
  max,
  step,
  onChange,
  format,
  name,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  name: string;
}) {
  return (
    <span className="range">
      <input
        type="range"
        aria-label={name}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{format ? format(value) : value}</output>
    </span>
  );
}

export function Inspector({
  timeline,
  clip,
  index,
  tab,
  onTab,
  dispatch,
  versions,
}: {
  timeline: Timeline;
  clip: Clip;
  index: number;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  dispatch: (cmd: EditorCommand) => boolean;
  /** The scene-regeneration section (absent: not shown). */
  versions?: ReactNode;
}) {
  const n = timeline.clips.length;
  const tabs: [InspectorTab, string][] = [
    ["scene", "Scene"],
    ["voice", "Voice"],
    ["text", "Text"],
    ["audio", "Audio"],
  ];
  return (
    <section className="inspector" aria-label={`Scene ${index + 1} settings`}>
      <div className="tabs" role="tablist">
        {tabs.map(([id, name]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? " active" : ""}`}
            onClick={() => onTab(id)}
          >
            {name}
          </button>
        ))}
      </div>

      {tab === "scene" && (
        <div className="panel">
          <div className="row-actions">
            <button
              type="button"
              className="btn small"
              disabled={index === 0}
              onClick={() => dispatch({ type: "moveClip", from: index, to: index - 1 })}
            >
              ◀ Move left
            </button>
            <button
              type="button"
              className="btn small"
              disabled={index === n - 1}
              onClick={() => dispatch({ type: "moveClip", from: index, to: index + 1 })}
            >
              Move right ▶
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                dispatch({ type: "duplicateClip", clipId: clip.id, newId: newId("c_") })
              }
            >
              Duplicate
            </button>
            <button
              type="button"
              className="btn small danger"
              disabled={n <= 1}
              onClick={() => dispatch({ type: "deleteClip", clipId: clip.id })}
            >
              Delete
            </button>
          </div>
          <Field label="Length">
            <Range
              name="Length"
              value={clip.duration_s}
              min={MIN_CLIP_SECONDS}
              max={MAX_CLIP_SECONDS}
              step={0.1}
              format={(v) => `${v.toFixed(1)} s`}
              onChange={(v) => dispatch({ type: "setDuration", clipId: clip.id, seconds: v })}
            />
          </Field>
          <Field
            label="Transition in"
            hint={index === 0 ? "The first scene always cuts in." : undefined}
          >
            <select
              aria-label="Transition in"
              value={clip.transition_in?.kind ?? ""}
              onChange={(e) =>
                dispatch({
                  type: "updateClip",
                  clipId: clip.id,
                  patch: {
                    transition_in: e.target.value
                      ? {
                          kind: e.target.value as (typeof SCENE_TRANSITIONS)[number],
                          duration_s: clip.transition_in?.duration_s ?? DEFAULT_TRANSITION_SECONDS,
                        }
                      : null,
                  },
                })
              }
            >
              <option value="">Automatic</option>
              {SCENE_TRANSITIONS.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          </Field>
          {clip.transition_in && clip.transition_in.kind !== "cut" && (
            <Field label="Transition length">
              <Range
                name="Transition length"
                value={clip.transition_in.duration_s}
                min={0.2}
                max={2}
                step={0.1}
                format={(v) => `${v.toFixed(1)} s`}
                onChange={(v) =>
                  dispatch({
                    type: "updateClip",
                    clipId: clip.id,
                    patch: { transition_in: { kind: clip.transition_in!.kind, duration_s: v } },
                  })
                }
              />
            </Field>
          )}
          {clip.visual_type !== "graphics" && (
            <>
              <div className="grid2">
                <Field label="Camera">
                  <select
                    aria-label="Camera"
                    value={clip.camera ?? ""}
                    onChange={(e) =>
                      dispatch({
                        type: "updateClip",
                        clipId: clip.id,
                        patch: { camera: (e.target.value || null) as Clip["camera"] },
                      })
                    }
                  >
                    <option value="">Automatic</option>
                    {CAMERA_MOVES.map((c) => (
                      <option key={c} value={c}>
                        {label(c)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Shot">
                  <select
                    aria-label="Shot"
                    value={clip.shot ?? ""}
                    onChange={(e) =>
                      dispatch({
                        type: "updateClip",
                        clipId: clip.id,
                        patch: { shot: (e.target.value || null) as Clip["shot"] },
                      })
                    }
                  >
                    <option value="">Automatic</option>
                    {SHOT_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Framing (focus point)" hint="Moves the crop towards what matters.">
                <Range
                  name="Focus left–right"
                  value={clip.focal.x}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => (v < 0.45 ? "left" : v > 0.55 ? "right" : "centre")}
                  onChange={(x) =>
                    dispatch({
                      type: "updateClip",
                      clipId: clip.id,
                      patch: { focal: { ...clip.focal, x } },
                    })
                  }
                />
                <Range
                  name="Focus top–bottom"
                  value={clip.focal.y}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => (v < 0.45 ? "top" : v > 0.55 ? "bottom" : "middle")}
                  onChange={(y) =>
                    dispatch({
                      type: "updateClip",
                      clipId: clip.id,
                      patch: { focal: { ...clip.focal, y } },
                    })
                  }
                />
              </Field>
            </>
          )}
          {clip.video_asset_id && (
            <Field label="Skip the start of the footage">
              <Range
                name="Footage trim"
                value={clip.trim_in_s}
                min={0}
                max={20}
                step={0.1}
                format={(v) => `${v.toFixed(1)} s`}
                onChange={(v) =>
                  dispatch({ type: "updateClip", clipId: clip.id, patch: { trim_in_s: v } })
                }
              />
            </Field>
          )}
        </div>
      )}

      {tab === "scene" && clip.visual_type === "graphics" && (
        <div className="panel">
          <GraphicsEditor clip={clip} dispatch={dispatch} />
        </div>
      )}
      {/* Graphics scenes have no picture to regenerate: their layout is edited above. */}
      {tab === "scene" && clip.visual_type !== "graphics" && versions}

      {tab === "voice" && (
        <div className="panel">
          <Field label="Narration">
            <select
              aria-label="Narration"
              value={clip.voice.mode}
              onChange={(e) =>
                dispatch({
                  type: "updateVoice",
                  clipId: clip.id,
                  patch: { mode: e.target.value as Clip["voice"]["mode"] },
                })
              }
            >
              <option value="kokoro">Voiced in your browser</option>
              {clip.voice.asset_id && <option value="asset">Stored recording</option>}
              <option value="none">Silent</option>
            </select>
          </Field>
          <Field label="What is said">
            <textarea
              aria-label="What is said"
              rows={4}
              maxLength={1000}
              value={clip.voice.text}
              onChange={(e) =>
                dispatch({ type: "updateVoice", clipId: clip.id, patch: { text: e.target.value } })
              }
            />
          </Field>
          <div className="grid2">
            <Field label="Voice">
              <select
                aria-label="Voice"
                value={clip.voice.voice_id ?? ""}
                onChange={(e) =>
                  dispatch({
                    type: "updateVoice",
                    clipId: clip.id,
                    patch: { voice_id: e.target.value || null },
                  })
                }
              >
                <option value="">Same as the video</option>
                {KOKORO_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Speed">
              <select
                aria-label="Speed"
                value={clip.voice.speed === null ? "" : String(clip.voice.speed)}
                onChange={(e) =>
                  dispatch({
                    type: "updateVoice",
                    clipId: clip.id,
                    patch: { speed: e.target.value ? Number(e.target.value) : null },
                  })
                }
              >
                <option value="">Fit the scene</option>
                {[0.8, 0.9, 1, 1.1, 1.2].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Voice level">
            <Range
              name="Voice level"
              value={clip.voice.gain_db}
              min={-20}
              max={6}
              step={1}
              format={(v) => `${v > 0 ? "+" : ""}${v} dB`}
              onChange={(v) =>
                dispatch({ type: "updateVoice", clipId: clip.id, patch: { gain_db: v } })
              }
            />
          </Field>
        </div>
      )}

      {tab === "text" && (
        <div className="panel">
          <Field label="Caption" hint="Empty: show what is said (or the scene description).">
            <input
              aria-label="Caption"
              maxLength={300}
              value={clip.caption ?? ""}
              placeholder={clip.voice.text || clip.description}
              onChange={(e) =>
                dispatch({
                  type: "updateClip",
                  clipId: clip.id,
                  patch: { caption: e.target.value || null },
                })
              }
            />
          </Field>
          <Field label="Label">
            <input
              aria-label="Label"
              maxLength={80}
              value={clip.on_screen_text ?? ""}
              onChange={(e) =>
                dispatch({
                  type: "updateClip",
                  clipId: clip.id,
                  patch: { on_screen_text: e.target.value || null },
                })
              }
            />
          </Field>
          <h3 className="panel-title">Text on screen</h3>
          {clip.overlays.map((o, k) => (
            <fieldset key={o.id} className="item">
              <legend>Text {k + 1}</legend>
              <input
                aria-label={`Text ${k + 1}`}
                maxLength={120}
                value={o.text}
                onChange={(e) =>
                  e.target.value.trim() &&
                  dispatch({
                    type: "updateOverlay",
                    clipId: clip.id,
                    overlayId: o.id,
                    patch: { text: e.target.value },
                  })
                }
              />
              <div className="grid2">
                <select
                  aria-label={`Style of text ${k + 1}`}
                  value={o.preset}
                  onChange={(e) =>
                    dispatch({
                      type: "updateOverlay",
                      clipId: clip.id,
                      overlayId: o.id,
                      patch: { preset: e.target.value as typeof o.preset },
                    })
                  }
                >
                  {OVERLAY_PRESETS.map((p) => (
                    <option key={p} value={p}>
                      {label(p)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Animation of text ${k + 1}`}
                  value={o.animation}
                  onChange={(e) =>
                    dispatch({
                      type: "updateOverlay",
                      clipId: clip.id,
                      overlayId: o.id,
                      patch: { animation: e.target.value as typeof o.animation },
                    })
                  }
                >
                  {OVERLAY_ANIMATIONS.map((a) => (
                    <option key={a} value={a}>
                      {label(a)}
                    </option>
                  ))}
                </select>
              </div>
              <Range
                name={`Start of text ${k + 1}`}
                value={o.start_s}
                min={0}
                max={Math.max(0, clip.duration_s - 0.2)}
                step={0.1}
                format={(v) => `from ${v.toFixed(1)} s`}
                onChange={(v) =>
                  dispatch({
                    type: "updateOverlay",
                    clipId: clip.id,
                    overlayId: o.id,
                    patch: { start_s: v },
                  })
                }
              />
              <Range
                name={`Length of text ${k + 1}`}
                value={o.duration_s}
                min={0.2}
                max={clip.duration_s}
                step={0.1}
                format={(v) => `for ${v.toFixed(1)} s`}
                onChange={(v) =>
                  dispatch({
                    type: "updateOverlay",
                    clipId: clip.id,
                    overlayId: o.id,
                    patch: { duration_s: v },
                  })
                }
              />
              <Range
                name={`Height of text ${k + 1}`}
                value={o.y}
                min={0}
                max={1}
                step={0.05}
                format={(v) => (v < 0.35 ? "top" : v > 0.65 ? "bottom" : "middle")}
                onChange={(v) =>
                  dispatch({
                    type: "updateOverlay",
                    clipId: clip.id,
                    overlayId: o.id,
                    patch: { y: v },
                  })
                }
              />
              <button
                type="button"
                className="btn small danger"
                onClick={() =>
                  dispatch({ type: "removeOverlay", clipId: clip.id, overlayId: o.id })
                }
              >
                Remove text {k + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="btn small"
            disabled={clip.overlays.length >= 8}
            onClick={() =>
              dispatch({
                type: "addOverlay",
                clipId: clip.id,
                overlay: {
                  id: newId("o_"),
                  text: "Your text",
                  start_s: 0,
                  duration_s: Math.min(2.5, clip.duration_s),
                  preset: "title",
                  x: 0.5,
                  y: 0.45,
                  animation: "pop",
                },
              })
            }
          >
            + Add text
          </button>
          <h3 className="panel-title">Captions (whole video)</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={timeline.captions.enabled}
              onChange={(e) =>
                dispatch({ type: "setCaptions", patch: { enabled: e.target.checked } })
              }
            />
            Show captions
          </label>
          <div className="grid2">
            <select
              aria-label="Caption style"
              value={timeline.captions.style}
              onChange={(e) =>
                dispatch({
                  type: "setCaptions",
                  patch: { style: e.target.value as Timeline["captions"]["style"] },
                })
              }
            >
              {CAPTION_STYLES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
            <select
              aria-label="Caption position"
              value={timeline.captions.position}
              onChange={(e) =>
                dispatch({
                  type: "setCaptions",
                  patch: { position: e.target.value as Timeline["captions"]["position"] },
                })
              }
            >
              {CAPTION_POSITIONS.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {tab === "audio" && (
        <div className="panel">
          <h3 className="panel-title">Sound effects in this scene</h3>
          {clip.sfx.map((s, k) => (
            <div key={s.id} className="item row">
              <select
                aria-label={`Sound ${k + 1}`}
                value={s.kind}
                onChange={(e) =>
                  dispatch({
                    type: "updateSfx",
                    clipId: clip.id,
                    sfxId: s.id,
                    patch: { kind: e.target.value as typeof s.kind },
                  })
                }
              >
                {SFX_KINDS.map((x) => (
                  <option key={x} value={x}>
                    {label(x)}
                  </option>
                ))}
              </select>
              <Range
                name={`Time of sound ${k + 1}`}
                value={s.at_s}
                min={0}
                max={Math.max(0, clip.duration_s - 0.05)}
                step={0.1}
                format={(v) => `at ${v.toFixed(1)} s`}
                onChange={(v) =>
                  dispatch({ type: "updateSfx", clipId: clip.id, sfxId: s.id, patch: { at_s: v } })
                }
              />
              <button
                type="button"
                className="btn small danger"
                aria-label={`Remove sound ${k + 1}`}
                onClick={() => dispatch({ type: "removeSfx", clipId: clip.id, sfxId: s.id })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn small"
            disabled={clip.sfx.length >= 8}
            onClick={() =>
              dispatch({
                type: "addSfx",
                clipId: clip.id,
                sfx: { id: newId("s_"), kind: "whoosh", at_s: 0, gain_db: 0 },
              })
            }
          >
            + Add sound
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={timeline.auto_transition_sfx}
              onChange={(e) => dispatch({ type: "setAutoTransitionSfx", on: e.target.checked })}
            />
            Automatic sounds on transitions
          </label>
          <h3 className="panel-title">Music (whole video)</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={timeline.music.mode === "generated"}
              onChange={(e) =>
                dispatch({
                  type: "setMusic",
                  patch: { mode: e.target.checked ? "generated" : "none" },
                })
              }
            />
            Background music
          </label>
          {timeline.music.mode === "generated" && (
            <>
              <Field label="Mood">
                <select
                  aria-label="Music mood"
                  value={timeline.music.mood ?? ""}
                  onChange={(e) =>
                    dispatch({
                      type: "setMusic",
                      patch: {
                        mood: (e.target.value || null) as Timeline["music"]["mood"],
                        tempo_bpm: e.target.value ? (timeline.music.tempo_bpm ?? 96) : null,
                      },
                    })
                  }
                >
                  <option value="">Default</option>
                  {MUSIC_MOODS.map((m) => (
                    <option key={m} value={m}>
                      {label(m)}
                    </option>
                  ))}
                </select>
              </Field>
              {timeline.music.mood && (
                <Field label="Tempo">
                  <Range
                    name="Tempo"
                    value={timeline.music.tempo_bpm ?? 96}
                    min={60}
                    max={140}
                    step={2}
                    format={(v) => `${v} bpm`}
                    onChange={(v) => dispatch({ type: "setMusic", patch: { tempo_bpm: v } })}
                  />
                </Field>
              )}
              <Field label="Music level">
                <Range
                  name="Music level"
                  value={timeline.music.gain_db}
                  min={-20}
                  max={6}
                  step={1}
                  format={(v) => `${v > 0 ? "+" : ""}${v} dB`}
                  onChange={(v) => dispatch({ type: "setMusic", patch: { gain_db: v } })}
                />
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={timeline.music.duck_under_voice}
                  onChange={(e) =>
                    dispatch({ type: "setMusic", patch: { duck_under_voice: e.target.checked } })
                  }
                />
                Quieter while someone speaks
              </label>
            </>
          )}
        </div>
      )}
    </section>
  );
}
