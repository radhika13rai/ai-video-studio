import type * as RendererModule from "@avs/renderer";

/**
 * Loads the browser renderer on demand. Its code is a separate file whose name changes with
 * every deploy, so a page opened before a deploy asks for a file that no longer exists. When
 * that happens we reload the page once (it then gets the new file names) or, where a reload
 * would interrupt the user, explain what to do.
 */
type Renderer = typeof RendererModule;

const RELOAD_KEY = "avs:renderer-reload";
const RELOAD_GUARD_MS = 60_000;

export const STALE_APP_MESSAGE =
  "The studio was updated while this page was open. Reload the page to continue (your edits are saved).";

/** True for the browser errors a missing code file produces. */
export function isStaleChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    msg,
  );
}

function reloadedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    return Date.now() - at < RELOAD_GUARD_MS;
  } catch {
    return true; // no storage: never risk a reload loop
  }
}

export async function loadRenderer(
  options: { reloadIfStale?: boolean } = {},
  load: () => Promise<Renderer> = () => import("@avs/renderer"),
): Promise<Renderer> {
  try {
    return await load();
  } catch (e) {
    if (!isStaleChunkError(e)) throw e;
    if (options.reloadIfStale && !reloadedRecently()) {
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
      window.location.reload();
      return new Promise<Renderer>(() => undefined); // the page is going away
    }
    throw new Error(STALE_APP_MESSAGE, { cause: e });
  }
}
