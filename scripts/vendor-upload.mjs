#!/usr/bin/env node
/* global process, fetch, console, Buffer */
// Uploads the browser renderer's third-party files (FFmpeg core, ONNX runtime, Kokoro voice and
// depth models) to R2 under vendor/. npm files come from node_modules at their pinned version;
// downloaded files must match the sha256 pinned in packages/contracts (VENDOR_FILES).
//
// Usage (from workers/api): node ../../scripts/vendor-upload.mjs --local|--remote [--health URL]
//   --health URL   upload only the files that URL's /api/v1/health reports as missing
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { VENDOR_FILES } = await import(join(root, "packages/contracts/src/index.ts"));
const args = process.argv.slice(2);
const where = args.includes("--remote") ? "--remote" : "--local";
const healthAt = args.indexOf("--health");
const cache = join(root, "node_modules/.cache/avs-vendor");

let files = VENDOR_FILES;
if (healthAt >= 0) {
  const res = await fetch(args[healthAt + 1]);
  const body = await res.json();
  const missing = body?.data?.missing_vendor_files;
  if (!Array.isArray(missing)) throw new Error("Health check did not report missing_vendor_files.");
  files = VENDOR_FILES.filter((f) => missing.includes(f.path));
}
if (files.length === 0) {
  console.log("All vendor files are already in R2.");
  process.exit(0);
}

/** Finds a package's directory through the workspace packages that depend on it. */
function packageDir(name) {
  for (const base of ["renderer", "apps/studio", "workers/api", "."]) {
    const p = join(root, base, "node_modules", name, "package.json");
    if (existsSync(p)) return dirname(realpathSync(p));
  }
  throw new Error(`Package ${name} is not installed; run pnpm install.`);
}

async function localPath(file) {
  if (file.source.kind === "npm") return join(packageDir(file.source.package), file.source.file);
  const out = join(cache, file.source.sha256);
  if (!existsSync(out)) {
    console.log(`Downloading ${file.source.url}`);
    const res = await fetch(file.source.url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${file.source.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== file.source.sha256)
      throw new Error(
        `Checksum mismatch for ${file.path}: expected ${file.source.sha256}, got ${got}`,
      );
    mkdirSync(cache, { recursive: true });
    writeFileSync(out, bytes);
  } else {
    const got = createHash("sha256").update(readFileSync(out)).digest("hex");
    if (got !== file.source.sha256)
      throw new Error(`Cached ${file.path} is corrupt; delete ${out}`);
  }
  return out;
}

for (const file of files) {
  const src = await localPath(file);
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `ai-video-studio-media/vendor/${file.path}`,
      "--file",
      src,
      "--content-type",
      file.contentType,
      where,
    ],
    { stdio: "inherit" },
  );
}
console.log(`Uploaded ${files.length} vendor file(s) (${where.slice(2)}).`);
