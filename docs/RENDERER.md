# Renderer

Package `@avs/renderer` (`renderer/`). The video is rendered **in the user's browser**; the Worker
only stores files and keeps the workflow's state (CLAUDE.md rule 6).

## Pipeline

```
POST /projects/:id/render ─▶ manifest (scenes, timings, captions, narration text, media URLs)
  1. Load      images; depth map per image (Depth Anything V2 Small); narration voiced with
               Kokoro-82M (server MeloTTS audio as fallback); FFmpeg core in parallel
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
- If Kokoro can't load at all (old browser, blocked download), scenes use the MeloTTS narration the
  workflow already generated, and the result says so (`narration: "provider"`, `notes`).
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

## Safety and limits

- One render per browser (Web Locks). The tab warns before closing during a render. Stop and
  failures call `/render/abort`, which returns the project to "Ready to render".
- Missing or undecodable media never stops a render: that scene renders without it, and the
  result lists `missingMedia`.
- The server accepts the upload only while the project is `rendering`, for the current render
  request, as `video/mp4` whose bytes start with an `ftyp` box, up to 95 MB. A new upload replaces
  the previous video. `/complete` checks ownership, the request ID and that the asset is this
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
- Free-motion run (2026-11-14, headless Chromium, software GL): 3 scenes, 13 s, 720×1280:
  Kokoro narration on all scenes, depth on both pictures, no requests outside the app's origin,
  60 s total on CPU; H.264 + AAC, mean −24 dB / peak −6 dB. Fallbacks checked: voice model
  blocked → server narration with a note; `narrator: "provider"`, `depth: false` → flat moves.
