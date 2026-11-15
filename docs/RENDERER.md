# Renderer

Package `@avs/renderer` (`renderer/`). The video is rendered **in the user's browser**; the Worker
only stores files and keeps the workflow's state (CLAUDE.md rule 6).

## Pipeline

```
POST /projects/:id/render ─▶ manifest (scenes, timings, captions, narration text, media URLs)
  1. Load      images; depth map per image (Depth Anything V2 Small); narration voiced with
               Kokoro-82M (server audio only if a voice provider exists); FFmpeg core in parallel
  2. Fit       each scene lasts at least as long as its narration (+0.35 s); Kokoro speaks up to
               1.2× faster first so the video stays close to the planned length
  3. Frames    WebGL depth parallax + Canvas 2D, 30 fps: shots, transitions, word captions, grain
               ─▶ WebCodecs H.264 (hardware)      or ─▶ JPEG frames (fallback)
  4. Audio     OfflineAudioContext: narration at each scene start + generated music (ducked)
               ─▶ 48 kHz stereo WAV
  5. Encode    FFmpeg.wasm: copy H.264 (or libx264 from frames) + AAC 128k, faststart MP4
  6. Upload    POST /render/upload (raw video/mp4, ≤ 95 MB) ─▶ R2 + `render` asset
  7. Complete  POST /render/complete ─▶ workflow event ─▶ quality check ─▶ completed
```

| Output | 720p (default) | 1080p     |
| ------ | -------------- | --------- |
| 9:16   | 720×1280       | 1080×1920 |
| 16:9   | 1280×720       | 1920×1080 |
| 1:1    | 720×720        | 1080×1080 |

H.264 (High profile when available) + AAC-LC 48 kHz stereo, 30 fps, `+faststart`.

## Why hybrid encoding

The blueprint asks for FFmpeg.wasm and H.264/AAC. Live checks in Chromium found that WebCodecs
encodes H.264 quickly, but **cannot encode AAC** (open-source builds ship no AAC encoder). So:

- video: WebCodecs when `VideoEncoder.isConfigSupported` passes; otherwise FFmpeg's libx264
- audio and container: always FFmpeg.wasm (AAC, MP4 mux)

Measured on a 15 s, 3-scene 720p video in headless Chromium: **5.3 s** with WebCodecs, **28.7 s**
FFmpeg-only. Both outputs probe as H.264 High 720×1280 30 fps + AAC-LC 48 kHz stereo, 15.000 s.

## Third-party files (/vendor)

Everything the renderer loads that isn't our own code is listed, pinned, in
`packages/contracts` (`VENDOR_FILES`):

| File                                   | Source                                 | Size        |
| -------------------------------------- | -------------------------------------- | ----------- |
| FFmpeg core 0.12.10 (`.js`, `.wasm`)   | npm `@ffmpeg/core`                     | 32 MB       |
| ONNX Runtime Web (`.mjs`, `.wasm`)     | npm `@huggingface/transformers` 3.8.1  | 22 MB       |
| Kokoro-82M v1.0 ONNX, q8 + tokenizer   | Hugging Face, pinned revision + sha256 | 92 MB       |
| Kokoro voices `af_heart`, `am_michael` | npm `kokoro-js` 1.2.1                  | 0.5 MB each |
| Depth Anything V2 Small, q8            | Hugging Face, pinned revision + sha256 | 27 MB       |
| Lilita One (display font, SIL OFL 1.1) | google/fonts, pinned commit + sha256   | 28 KB       |

- **production:** stored in R2 under `vendor/…` and served by the Worker at `/vendor/…`
  (`immutable`, only paths on the list). `GET /api/v1/health` reports `missing_vendor_files`;
  the deploy workflow uploads exactly those (`scripts/vendor-upload.mjs --health`), checking each
  download's sha256, and fails if any are still missing.
- **development:** Vite serves npm files from `node_modules` and downloaded files from the upload
  script's cache (`node_modules/.cache/avs-vendor`). If the models aren't cached, the renderer
  loads them from Hugging Face instead.
- Upload by hand: `pnpm --filter @avs/api vendor:upload` (or `vendor:upload:local`).

The FFmpeg core is single-threaded, and ONNX runs single-threaded unless the page is
cross-origin isolated (it isn't; see ADR 029), so no COOP/COEP headers are needed. Vite also emits
a copy of the ONNX `.wasm` into the build; it's unused (the runtime is pointed at `/vendor`).

## Narration: Kokoro-82M in the browser

- Model: [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0), ONNX export
  `onnx-community/Kokoro-82M-v1.0-ONNX`, q8, run by `kokoro-js` (Apache-2.0) on ONNX Runtime Web
  (WASM, CPU). Free: no API, no server time. The first render in a browser downloads ~92 MB;
  later renders use the browser cache.
- Voices: **Heart** (`af_heart`, default) and **Michael** (`am_michael`, backup), chosen in the
  render panel and remembered per browser. If the chosen voice fails, the backup is used.
- Kokoro and the depth model run in **background workers** (`ml.worker.ts`, one each), so the
  page stays responsive and shows a live seconds counter. Every step has a time limit (load voice
  300 s, first scene 120 s, later scenes 60 s; load depth 180 s, each picture 60 s). When one runs
  out, that worker is terminated: remaining scenes use server narration if any exists (none since
  ADR 039; captions carry the script), or flat moves. A phone that's too slow for Kokoro still
  gets a finished video, and those scenes are listed as missing narration.
- The speaking speed is chosen before speaking (≈2.6 words/s at 1×, at most 1.2×), so each scene
  is voiced once.
- If Kokoro can't load at all (old browser, blocked download), the video has captions but no
  voice, and the result says so (`narration: "none"`, `notes`, `missingMedia`). The upload
  reports voiced/total narrated scenes, and the quality check warns. Server audio is still used
  when a voice provider exists.
- Text-to-phoneme uses the `phonemizer` package, which bundles eSpeak NG (GPL-3.0). The same is
  true of the Python `kokoro-onnx`; check this suits how you distribute the app.
- Not the Python `kokoro-onnx` 0.4.7 runner: Python can't run in a Worker or a browser. The model
  and voices are the same; only the runtime differs (ADR 033).

## Look and motion

- **Depth parallax:** each picture gets a depth map; a WebGL shader shifts pixels by depth as the
  camera moves sideways, so the foreground slides against the background. Without WebGL or the
  depth model, the same moves run as flat 2D crops (`motion: "flat"`).
- **Shots:** each scene is cut into shots of about 2.6 s (max 4): a wide opening shot, then
  punch-ins on different parts of the picture, each with its own push or pull, a quick zoom punch
  on the cut and gentle handheld drift. Deterministic per scene, so re-renders match.
- **Transitions** (0.47 s, centred on each cut): zoom-through, slide, crossfade, whip pan with
  motion blur, flash; they rotate through the video.
- **Captions:** Reels style, up to 4 words at a time, timed across the actual narration audio
  (weighted by word length and punctuation). The word being said is yellow and pops.
- **Text scenes:** animated gradient with drifting light and rising particles; the line appears
  big in the centre, word by word, and stays until the scene ends.
- **Graphics:** title intro (words rise in, gone by 2.3 s), progress bar, vignette, bottom shade
  for caption contrast, light film grain, fade in and out.
- **Music:** generated in code (no licences): a C–G–Am–F pad, soft bass and plucked arpeggio at
  90 bpm, low-passed, ducked from 0.16 to 0.06 under narration. Optional in the render panel.

## Stock footage and sound effects

- A scene with `video_url` plays its clip (ADR 041). The clip is downloaded with the pictures but
  decoded only while its scene (or a transition into or out of it) is on screen, then released,
  so a phone holds at most two clips at once. For each output frame the hidden `<video>` is
  seeked to the exact time and copied into a canvas that the painter draws like a picture, with
  the planned camera move (no 3D depth). Seeking frame by frame is slower than playback but never
  drops or repeats frames.
- A clip shorter than its scene plays in slow motion to fill it (never loops); a longer one plays
  from the start at normal speed.
- A clip that can't be downloaded or decoded is listed in `missingMedia`; the scene falls back to
  its picture or a text card.
- The footage credit ("Video by … on Pexels") is drawn small at the bottom left.
- Planned transitions get synthesized sound effects (no files, no licences): an air whoosh
  (band-passed noise sweeping up, peaking just before the cut) for whip, slide and zoom, and a
  soft low hit for flash. Crossfades and cuts stay silent. `sfx: false` turns them off.
- Verified in headless Chromium: a moving H.264 clip plays with captions and credit, a broken
  clip falls back to a text card, the whoosh peaks around −21 dB RMS at the whip and the hit at
  the flash.

## Editor features (ADR 044)

The manifest compiled from the timeline can carry, per scene and only when edited:

- `overlays`: text with a preset (title, lower third with a bar, label, quote), a position
  (x, y as shares of the frame, kept inside it), a time window relative to the scene, and an
  entrance (fade, pop, slide up, typewriter); up to three lines.
- `sfx`: placed effects (whoosh, hit, riser, pop, boom), synthesized at scene start + offset with
  their own level. A riser ends on its cue.
- `voice_id`, `voice_speed`, `voice_gain_db`: a scene's own Kokoro voice (unknown ids fall back
  to the chosen voice), speaking speed (instead of fitting to the scene) and level.
- `transition_seconds`: the scene's transition length, centred on the cut (default 14 frames).
- `focal`: the point of the picture kept in frame when cropping.
- `trim_in_seconds`: seconds of footage skipped at the start.

And for the whole video: `captions` (on/off, bold, minimal or karaoke, bottom, middle or top;
text cards always show their words) and `audio` (music on/off, music level, ducking, automatic
transition effects). Absent fields mean the previous behaviour, so older manifests render the
same. Verified in headless Chromium: karaoke captions at the top, a popping title and a sliding
lower third, a reframed picture, a 1.5 s crossfade, and with music off only the placed boom,
pop and riser in the audio (no automatic whoosh when transition effects are off).

## Live preview (ADR 046)

`createPreview(canvas, manifest)` plays a manifest in real time for the editor, using the same
painter (`paintFrame`), scene timing (`prepare.ts`: narration-fitted lengths, caption word
timing) and offline audio mix as the export, so the preview matches the video.

- Master clock: the Web Audio context. The full mix (narration, music, sound effects) is
  rendered once per build and played from the current offset; each animation frame paints the
  frame for the current time.
- 360×640 (9:16) by default, flat camera moves (no depth model), footage played as video and
  kept within 0.25 s of the clock (the export still seeks frame by frame).
- `update(manifest)` rebuilds after an edit, reusing downloaded pictures, recordings and clips.
- Narration comes from the voice cache or a stored recording. `voice()` voices the remaining
  lines with Kokoro on request and caches them.

**Voice cache** (`voice-cache.ts`): Kokoro lines in IndexedDB, keyed by SHA-256 of voice, speed
and text (`speechPlan` decides these the same way for preview and export), at most 200 lines.
The export checks the cache first and loads the Kokoro model only for lines that aren't cached;
it caches what it voices. Without IndexedDB the cache is empty and everything still works.

Verified in headless Chromium: 1.16 s of playback in 1.2 s, seek to 7.16 s, pause holds, an
update to 16:9 rebuilds at 1138×640 with the new length, the cached line counts as voiced, and an
export with that cache had Kokoro narration without loading the model (3.6 s).

## Graphics scenes (ADR 048)

A scene with `visual_type: "graphics"` draws no picture: it is one of eleven code-defined layout
presets (`renderer/src/graphics/`), filled from the scene's `graphics` slots and animated on a
fixed 1080 × 1920 design canvas (fitted to the output size). The style: a light dotted background,
chunky orange extruded headlines (Lilita One, letters springing in one by one, auto-fitted to
960 px), white rounded cards, blue connector curves that draw themselves with a dot riding the
tip, green checks popping in one by one, a persistent glossy folder (the anchor) and a small pixel
mascot that blinks, hops and points.

| Preset                | Draws                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| `hook_headline`       | pill, headline, up to 6 book-cover items floating around the anchor   |
| `card_list`           | optional headline and up to 6 rows (title + subtitle)                 |
| `collect_into_anchor` | up to 6 cards with connectors, then they fly into the folder + ripple |
| `headline_papers`     | headline, papers fanning out of the folder, optional caption pill     |
| `headline_badge`      | headline, a blue gem, a badge pill                                    |
| `progress_card`       | card with a label, a counting percentage and a filling bar, then a ✓  |
| `checklist`           | headline and up to 6 rows, each then checked in order                 |
| `chat_objection`      | quoted message card, a red label, a "typing…" card                    |
| `chat_reply`          | a reply card that types itself, then up to 2 tags                     |
| `stacked_cards`       | up to 5 numbered cards on a blue connector spine                      |
| `cta_card`            | headline, profile card with handle, button, line and a drawn arrow    |

- **One timing source:** `cues(layout, durationFrames)` (pure) returns every element's entrance
  frame and its sound. The painter animates from those frames and the mixer puts a sound on each
  (`click`, `tick`, `confirm`, `impact`, `pop`, `whoosh`, all synthesized), so every sound lands
  on its animation. Short scenes compress the schedule; every element has entered before the
  exit fade over the last 7 frames.
- **Persistent objects:** the project's `graphics_theme` sets the palette, the anchor (`folder`
  or `none`) and the mascot. Each preset has a pose for both; between two graphics scenes they
  glide from the old pose to the new one on a critically damped spring instead of being redrawn.
- **No picture effects:** no depth parallax, punch-ins, title intro, label, vignette, progress bar
  or grain. Two graphics scenes cut (their elements fade out and in); next to a picture scene the
  transition is always a crossfade, without a whoosh. Captions are off unless the caption look is
  set explicitly, because the on-screen text carries the message.
- **Font:** loaded with the FontFace API from `/vendor/` before the first frame (export and
  preview); if it fails the headlines use bold Inter and the render notes say so.
- **Safe area:** text stays between y 220 and 1540 of the design canvas (Instagram's top 220 px
  and bottom 380 px are kept clear). 16:9 and 1:1 projects show the 9:16 composition centred.

## Following the Creative Director

When the project has a blueprint, the manifest carries per-scene `shot`, `camera`,
`transition_in` and `on_screen_text`, plus project `music: { mood, tempo_bpm }`. All optional:
without them the renderer behaves exactly as before.

- **Shot size** sets the first shot's framing (wide 1.02× … extreme close 1.55×); later shots punch
  in closer on another part of the picture.
- **Camera move** sets every shot's motion: push in / pull out (zoom), pan left/right, tilt up/down
  (pan across the picture), orbit (stronger depth parallax), handheld (more drift), static (still,
  minimal drift).
- **Transition** replaces the rotating default; `cut` means a hard cut with no blend.
- **On-screen text**: a short label near the top that pops in (not during the title intro).
- **Music**: the mood picks the chords and texture (upbeat and driving pulse the bass; ambient
  and warm drop the arpeggio and darken the filter); the tempo comes from the blueprint (60–140).

## Safety and limits

- One render per project: the server hands out an attempt token with a 30-minute lease, and
  upload, complete and abort require it (see `API.md`). A second tab or device sees "already
  rendering" with a **Start anyway** button (takeover). Web Locks still stop two renders in one
  browser. The tab warns before closing during a render. Stop and failures call `/render/abort`
  with the token, which returns the project to "Ready to render".
- Missing or undecodable media never stops a render: that scene renders without it, and the
  result lists `missingMedia`.
- The server accepts the upload only while the project is `rendering`, for the current render
  request and attempt token, as `video/mp4` with a `Content-Length` up to 95 MB. It streams into R2
  (never buffered in the Worker), is validated there, and replaces the previous video only after
  it's recorded; a damaged upload is deleted and the old video stays. `/complete` checks ownership, the request ID and that the asset is this
  render's video before resuming the workflow; the workflow checks the asset again.

## Testing

- `renderer/src/timeline.test.ts`: frame allocation, captions, cropping, shots, transitions,
  word timing, voice pacing, WAV encoding.
- `workers/api/tests/render.test.ts`: manifest → upload → complete → workflow completes; upload
  validation; abort; vendor route (pinned list only) and `missing_vendor_files`.
- `apps/studio/src/components/RenderPanel.test.tsx`: UI flow, errors, one render per browser.
- Browser runs (Playwright + ffprobe) with real Workers AI images and narration in
  `renderer/test-fixtures`: both encoders, frame inspection, audio alignment (voice at 0.05–4.0 s
  and 5.16–9.8 s, silent text card), and a full render → upload → download through the app.
- Graphics scenes: `renderer/src/graphics/graphics.test.ts` (springs, cues inside the scene and
  in order, the 12-scene fixture, a sound on every cue, transitions, text fitting) and the browser
  script `node renderer/scripts/graphics-fixture.mjs`, which renders the 12-scene "Close Deals"
  fixture (`renderer/src/graphics/fixture.ts`) in headless Chromium at 1080×1920, 30 fps; saves a
  still at the busiest frame of each scene to `renderer/test-fixtures/graphics/`; fails on
  text-like pixels in the unsafe top 220 px / bottom 380 px; checks the live preview plays and
  seeks to the same frame the export paints; and checks the MP4 with ffprobe and its audio
  around every cue. Last run (2026-11-15): 1044 frames with WebCodecs in 14 s, H.264 1080×1920 @
  30 fps + AAC, 34.800 s, 70 of 70 cues audible, 0 unsafe-area pixels, preview seek identical.
- Free-motion run (2026-11-14, headless Chromium, software GL): 3 scenes, 13 s, 720×1280:
  Kokoro narration on all scenes, depth on both pictures, no requests outside the app's origin,
  60 s total on CPU; H.264 + AAC, mean −24 dB / peak −6 dB. Fallbacks checked: voice model
  blocked → server narration with a note; `narrator: "provider"`, `depth: false` → flat moves.
