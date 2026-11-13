import { readdirSync, readFileSync } from "node:fs";

/** Reads every .mp4 in a folder as base64, keyed by file name (runs in Node, for vitest.config). */
export function loadMp4Fixtures(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => [f, readFileSync(`${dir}/${f}`).toString("base64")]),
  );
}
