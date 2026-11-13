import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { FFMPEG_CORE_BASE } from "../../packages/contracts/src/index";

/**
 * Serves the FFmpeg.wasm core from node_modules at the same path the Worker serves it from R2 in
 * production, so the renderer loads it from our own origin everywhere (no CDN).
 */
function ffmpegCore(): Plugin {
  // @ffmpeg/core does not export package.json, so locate it through the renderer's node_modules.
  const dir = path.resolve(__dirname, "../../renderer/node_modules/@ffmpeg/core/dist/esm");
  const fixtures = path.resolve(__dirname, "../../renderer/test-fixtures");
  const types: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" };
  return {
    name: "avs-ffmpeg-core",
    configureServer(server) {
      // Test-only media for the renderer's browser tests (never part of the production build).
      server.middlewares.use("/__fixtures", (req, res, next) => {
        const file = path.join(fixtures, path.basename(req.url ?? ""));
        if (!existsSync(file)) return next();
        createReadStream(file).pipe(res);
      });
      server.middlewares.use(FFMPEG_CORE_BASE, (req, res, next) => {
        const file = path.join(dir, path.basename(req.url ?? ""));
        if (!existsSync(file)) return next();
        res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
        res.setHeader("content-length", String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

// In development the Worker runs on :8787 (wrangler dev) and Vite proxies /api to it.
export default defineConfig({
  plugins: [react(), ffmpegCore()],
  // FFmpeg.wasm starts its own module worker; pre-bundling breaks its relative URLs.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
});
