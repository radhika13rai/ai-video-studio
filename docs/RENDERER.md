# Renderer

Package `@avs/renderer` (`renderer/`). The video is rendered **in the user's browser**; the Worker
only stores files and keeps the workflow's state (CLAUDE.md rule 6).

## Pipeline

```
POST /projects/:id/render ─▶ manifest (scenes, timings, captions, media URLs)
  1. Load      images (createImageBitmap) and narration (decodeAudioData), FFmpeg core in parallel
  2. Frames    Canvas 2D, 30 fps: Ken Burns zoom/pan, captions, text cards, fades
               ─▶ WebCodecs H.264 (hardware)      or ─▶ JPEG frames (fallback)
  3. Audio     OfflineAudioContext places each clip at its scene start ─▶ 48 kHz stereo WAV
  4. Encode    FFmpeg.wasm: copy H.264 (or libx264 from frames) + AAC 128k, faststart MP4
  5. Upload    POST /render/upload (raw video/mp4, ≤ 95 MB) ─▶ R2 + `render` asset
  6. Complete  POST /render/complete ─▶ workflow event ─▶ quality check ─▶ completed
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

## FFmpeg core hosting

The single-threaded core (`@ffmpeg/core` 0.12.10) needs no cross-origin isolation, but its `.wasm`
is 32 MB, over the 25 MiB per-file limit for Workers static assets. It is therefore:

- **development:** served by a Vite middleware from `renderer/node_modules/@ffmpeg/core`
- **production:** stored in R2 under `vendor/ffmpeg-core/<version>/` and served by the Worker at
  `/vendor/ffmpeg-core/<version>/…` (public, `immutable`, routed with `run_worker_first`)

Upload it once per version: `pnpm --filter @avs/api vendor:upload` (or `vendor:upload:local` for
`wrangler dev`). No CDN is used.

## Look

- Images are centre-cropped to the frame (FLUX's square images fill 9:16), with one of four
  deterministic Ken Burns motions per scene and a bottom gradient for caption contrast.
- Captions: narration split into chunks of up to 6 words at sentence and comma breaks, timed by
  length, bold white with a dark outline, two-line captions balanced so no word is left alone.
- Text cards (scenes without images): coloured gradient with drifting light and the scene title.
- Short dip from black at each cut, longer fade in at the start and fade out at the end.
- Narration: 50 ms lead-in after each cut, 80 ms fade-out, trimmed to its scene.

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

- `renderer/src/timeline.test.ts`: frame allocation, captions, cropping, motion, WAV encoding.
- `workers/api/tests/render.test.ts`: manifest → upload → complete → workflow completes; upload
  validation; abort; FFmpeg route.
- `apps/studio/src/components/RenderPanel.test.tsx`: UI flow, errors, one render per browser.
- Browser runs (Playwright + ffprobe) with real Workers AI images and narration in
  `renderer/test-fixtures`: both encoders, frame inspection, audio alignment (voice at 0.05–4.0 s
  and 5.16–9.8 s, silent text card), and a full render → upload → download through the app.
