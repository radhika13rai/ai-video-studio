import { afterEach, describe, expect, it, vi } from "vitest";
import { isStaleChunkError, loadRenderer, STALE_APP_MESSAGE } from "./renderer";

const stale = () =>
  Promise.reject(
    new TypeError("Failed to fetch dynamically imported module: https://x/assets/src-OLD.js"),
  );

describe("loadRenderer", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("recognises missing-code-file errors from each browser", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: a"))).toBe(
      true,
    );
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new TypeError("error loading dynamically imported module: a"))).toBe(
      true,
    );
    expect(isStaleChunkError(new Error("Render failed"))).toBe(false);
  });

  it("returns the module when it loads", async () => {
    const mod = { renderVideo: () => null } as never;
    await expect(loadRenderer({}, () => Promise.resolve(mod))).resolves.toBe(mod);
  });

  it("reloads once when the page predates a deploy", async () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    void loadRenderer({ reloadIfStale: true }, stale);
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    // A second failure right after the reload explains instead of looping.
    await expect(loadRenderer({ reloadIfStale: true }, stale)).rejects.toThrow(STALE_APP_MESSAGE);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("explains instead of reloading where a reload would interrupt", async () => {
    await expect(loadRenderer({}, stale)).rejects.toThrow(STALE_APP_MESSAGE);
  });

  it("passes other errors through", async () => {
    await expect(loadRenderer({}, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
