#!/usr/bin/env node
/* global process, console, Buffer, document, setTimeout, btoa */
// Browser test for graphics scenes (ADR 048). Renders the 12-scene "Close Deals" fixture in
// headless Chromium at 1080×1920, 30 fps, and checks it:
//   - saves a still at the busiest frame of each scene to renderer/test-fixtures/graphics/
//   - fails if text-like pixels fall outside Instagram's safe area (top 220 px, bottom 380 px)
//   - asserts the MP4 is H.264 + AAC at the expected length (ffprobe)
//   - asserts the audio has a sound near every cue frame (ffmpeg → PCM, RMS around each cue)
//   - plays the live preview, then seeks, and compares the frame with the export painter
//
// Usage (from the repo root, with Playwright's Chromium and ffmpeg installed):
//   node renderer/scripts/graphics-fixture.mjs [--out /tmp/close-deals.mp4] [--no-video]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "apps/studio/package.json"));
const { createServer } = require("vite");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const mp4Path = outAt >= 0 ? resolve(args[outAt + 1]) : join(tmpdir(), "close-deals.mp4");
const withVideo = !args.includes("--no-video");
const stillsDir = join(root, "renderer/test-fixtures/graphics");
mkdirSync(stillsDir, { recursive: true });

const failures = [];
const fail = (m) => {
  failures.push(m);
  console.error(`FAIL ${m}`);
};

const server = await createServer({
  configFile: join(root, "apps/studio/vite.config.ts"),
  root: join(root, "apps/studio"),
  server: { port: 5181, strictPort: false },
  logLevel: "error",
});
await server.listen();
const port = server.config.server.port ?? 5181;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  // A plain same-origin page (not the studio app, which would call the API).
  await page.goto(`http://localhost:${port}/__fixtures/README.md`);
  const R = `/@fs${root}/renderer/src`;

  // 1. Stills at the busiest frame of each scene, plus a safe-area scan.
  const stills = await page.evaluate(async (R) => {
    const { closeDealsManifest } = await import(`${R}/graphics/fixture.ts`);
    const { busiestFrame, layoutOf, loadDisplayFont, isDisplayFontReady } = await import(
      `${R}/graphics/index.ts`
    );
    const { paintFrame } = await import(`${R}/painter.ts`);
    const { buildTimeline } = await import(`${R}/timeline.ts`);
    await loadDisplayFont("");
    const m = closeDealsManifest();
    const { scenes, totalFrames } = buildTimeline(m);
    const canvas = Object.assign(document.createElement("canvas"), { width: 1080, height: 1920 });
    const ctx = canvas.getContext("2d");
    const fc = {
      width: 1080,
      height: 1920,
      timeline: scenes,
      media: scenes.map(() => ({ image: null, words: [], gpu: false })),
      totalFrames,
      title: m.project.title,
      parallax: null,
      grain: null,
    };
    const out = [];
    for (const t of scenes) {
      const frame = t.startFrame + busiestFrame(layoutOf(t.scene), t.frameCount);
      paintFrame(ctx, fc, frame);
      // Text-like pixels: dark ink, or saturated orange / blue / red, in the unsafe bands.
      const scan = (y0, y1) => {
        const d = ctx.getImageData(0, y0, 1080, y1 - y0).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          if (lum < 140 || sat > 90) n++;
        }
        return n;
      };
      out.push({
        scene: t.scene.scene_number,
        preset: t.scene.graphics.preset,
        frame,
        top: scan(0, 220),
        bottom: scan(1540, 1920),
        jpg: canvas.toDataURL("image/jpeg", 0.85),
      });
    }
    return { out, font: isDisplayFontReady() };
  }, R);
  if (!stills.font) fail("the display font did not load");
  for (const s of stills.out) {
    const name = `scene-${String(s.scene).padStart(2, "0")}-${s.preset}.jpg`;
    writeFileSync(join(stillsDir, name), Buffer.from(s.jpg.split(",")[1], "base64"));
    console.log(
      `still ${name} at frame ${s.frame}: unsafe-area pixels top ${s.top}, bottom ${s.bottom}`,
    );
    if (s.top > 0) fail(`scene ${s.scene} draws in the top 220 px (${s.top} px)`);
    if (s.bottom > 0) fail(`scene ${s.scene} draws in the bottom 380 px (${s.bottom} px)`);
  }

  // 2. Live preview: plays, then seeks; the paused frame matches the export painter.
  const preview = await page.evaluate(async (R) => {
    const { closeDealsManifest } = await import(`${R}/graphics/fixture.ts`);
    const { createPreview } = await import(`${R}/preview.ts`);
    const { paintFrame } = await import(`${R}/painter.ts`);
    const { buildTimeline } = await import(`${R}/timeline.ts`);
    const m = closeDealsManifest();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const c = await createPreview(canvas, m, { height: 640 });
    await c.play();
    await new Promise((r) => setTimeout(r, 1200));
    const played = c.state.seconds;
    c.pause();
    c.seek(20);
    await new Promise((r) => setTimeout(r, 400));
    const seeked = c.state.seconds;
    const a = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const ref = Object.assign(document.createElement("canvas"), {
      width: canvas.width,
      height: canvas.height,
    });
    const { scenes, totalFrames } = buildTimeline(m);
    paintFrame(
      ref.getContext("2d"),
      {
        width: canvas.width,
        height: canvas.height,
        timeline: scenes,
        media: scenes.map(() => ({ image: null, words: [], gpu: false })),
        totalFrames,
        title: m.project.title,
        parallax: null,
        grain: null,
      },
      Math.round(seeked * 30),
    );
    const b = ref.getContext("2d").getImageData(0, 0, ref.width, ref.height).data;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4)
      diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    c.destroy();
    return {
      played,
      seeked,
      meanDiff: diff / (a.length / 4) / 3,
      size: [canvas.width, canvas.height],
    };
  }, R);
  console.log("preview", JSON.stringify(preview));
  if (!(preview.played > 0.5)) fail(`the preview did not play (${preview.played} s after 1.2 s)`);
  if (Math.abs(preview.seeked - 20) > 0.05)
    fail(`the preview seeked to ${preview.seeked} s, not 20 s`);
  if (!(preview.meanDiff < 2))
    fail(`the seeked preview frame differs from the export painter (${preview.meanDiff})`);

  // 3. Full export at 1080×1920.
  if (withVideo) {
    const t0 = Date.now();
    const res = await page.evaluate(async (R) => {
      const { closeDealsManifest } = await import(`${R}/graphics/fixture.ts`);
      const { renderVideo } = await import(`${R}/index.ts`);
      const { buildTimeline, FPS } = await import(`${R}/timeline.ts`);
      const { mixCues } = await import(`${R}/render.ts`);
      const m = closeDealsManifest();
      const r = await renderVideo(m, { quality: "1080p", depth: false, narrator: "provider" });
      const { scenes } = buildTimeline(m);
      const cueTimes = mixCues(scenes, true).map((c) => ({ at: c.at, kind: c.kind }));
      let bin = "";
      for (let i = 0; i < r.mp4.length; i += 0x8000)
        bin += String.fromCharCode(...r.mp4.subarray(i, i + 0x8000));
      return {
        b64: btoa(bin),
        frames: r.frames,
        encoder: r.encoder,
        notes: r.notes,
        cueTimes,
        fps: FPS,
      };
    }, R);
    writeFileSync(mp4Path, Buffer.from(res.b64, "base64"));
    console.log(
      `rendered ${res.frames} frames with ${res.encoder} in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${mp4Path}`,
    );
    if (res.notes.length) console.log("notes:", res.notes);

    const probe = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        mp4Path,
      ]).toString(),
    );
    const v = probe.streams.find((s) => s.codec_type === "video");
    const a = probe.streams.find((s) => s.codec_type === "audio");
    const dur = Number(probe.format.duration);
    console.log(
      `ffprobe: ${v?.codec_name} ${v?.width}x${v?.height} @ ${v?.r_frame_rate}, ${a?.codec_name}, ${dur.toFixed(3)} s`,
    );
    if (v?.codec_name !== "h264") fail(`video codec is ${v?.codec_name}, not h264`);
    if (a?.codec_name !== "aac") fail(`audio codec is ${a?.codec_name}, not aac`);
    if (v?.width !== 1080 || v?.height !== 1920) fail(`video is ${v?.width}x${v?.height}`);
    if (v?.r_frame_rate !== "30/1") fail(`frame rate is ${v?.r_frame_rate}`);
    if (Math.abs(dur - 34.8) > 0.15) fail(`duration is ${dur} s, expected 34.8 s`);

    // Audio: RMS in a 70 ms window from each cue vs the quietest stretch of the mix.
    const pcm = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", mp4Path, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    const rms = (from, to) => {
      let s = 0;
      let n = 0;
      for (
        let i = Math.max(0, Math.floor(from * 8000));
        i < Math.min(samples.length, to * 8000);
        i++
      ) {
        s += samples[i] ** 2;
        n++;
      }
      return Math.sqrt(s / Math.max(1, n));
    };
    const db = (x) => 20 * Math.log10(Math.max(1e-9, x));
    let silent = 0;
    for (const { at: t, kind } of res.cueTimes) {
      // A whoosh swells into the motion it accompanies (peak ≈ 0.27 s); the rest are instant.
      const span = kind === "whoosh" ? 0.4 : 0.12;
      let peak = 0;
      for (let x = t - 0.02; x < t + span; x += 0.02) peak = Math.max(peak, rms(x, x + 0.05));
      const level = db(peak);
      if (level < -45) {
        silent++;
        fail(`no ${kind} near its cue at ${t.toFixed(3)} s (${level.toFixed(1)} dBFS)`);
      }
    }
    console.log(`audio: ${res.cueTimes.length} cues, ${res.cueTimes.length - silent} with sound`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("All graphics fixture checks passed.");
if (!existsSync(mp4Path) && withVideo) process.exit(1);
void readFileSync;
