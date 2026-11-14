import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VENDOR_FILES } from "../../packages/contracts/src/index";

const root = path.resolve(__dirname, "../..");

/** Where a vendor file lives on this machine (node_modules, or the upload script's cache). */
function localVendorFile(vendorPath: string): string | null {
  const file = VENDOR_FILES.find((f) => f.path === vendorPath);
  if (!file) return null;
  if (file.source.kind === "url") {
    const cached = path.join(root, "node_modules/.cache/avs-vendor", file.source.sha256);
    return existsSync(cached) ? cached : null;
  }
  for (const base of ["renderer", "apps/studio", "workers/api", "."]) {
    const pkg = path.join(root, base, "node_modules", file.source.package, "package.json");
    if (existsSync(pkg)) return path.join(path.dirname(realpathSync(pkg)), file.source.file);
  }
  return null;
}

/**
 * Serves /vendor/* (FFmpeg core, ONNX runtime, models) from this machine at the same paths the
 * Worker serves them from R2 in production. Downloaded models appear once
 * `pnpm --filter @avs/api vendor:upload:local` has cached them; until then the renderer falls
 * back to loading models from Hugging Face.
 */
function vendorFiles(): Plugin {
  const fixtures = path.resolve(root, "renderer/test-fixtures");
  return {
    name: "avs-vendor-files",
    configureServer(server) {
      // Test-only media for the renderer's browser tests (never part of the production build).
      server.middlewares.use("/__fixtures", (req, res, next) => {
        const file = path.join(fixtures, path.basename(req.url ?? ""));
        if (!existsSync(file)) return next();
        createReadStream(file).pipe(res);
      });
      server.middlewares.use("/vendor", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(/^\/+/, "");
        const meta = VENDOR_FILES.find((f) => f.path === rel);
        const file = localVendorFile(rel);
        if (!meta || !file || !existsSync(file)) return next();
        res.setHeader("content-type", meta.contentType);
        res.setHeader("content-length", String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

// In development the Worker runs on :8787 (wrangler dev) and Vite proxies /api to it.
export default defineConfig({
  plugins: [react(), vendorFiles()],
  // FFmpeg.wasm starts its own module worker; pre-bundling breaks its relative URLs.
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@huggingface/transformers", "kokoro-js"],
  },
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
});
