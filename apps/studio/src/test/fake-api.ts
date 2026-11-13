import type { Project } from "@avs/contracts";
import { vi } from "vitest";

export function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: crypto.randomUUID(),
    user_id: "u1",
    title: "Ocean facts",
    prompt: "Five surprising facts about the deep ocean",
    video_type: "faceless",
    aspect_ratio: "9:16",
    duration_seconds: 30,
    target_platform: "youtube_shorts",
    status: "created",
    production_config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

interface Reply {
  status?: number;
  body: unknown;
}
type Handler = (url: URL, init: RequestInit) => Reply | undefined;

/** Stubs fetch with a list of handlers; records every call. Unhandled calls return 404. */
export function stubApi(...handlers: Handler[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ url, init });
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: "NOT_FOUND", message: "nope", retryable: false },
      }),
      { status: 404 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

export const ok = (data: unknown, status = 200): Reply => ({
  status,
  body: { success: true, data },
});
export const err = (code: string, message: string, status: number): Reply => ({
  status,
  body: { success: false, error: { code, message, retryable: false } },
});

export const route =
  (
    method: string,
    path: string | RegExp,
    respond: (url: URL, init: RequestInit) => Reply,
  ): Handler =>
  (url, init) =>
    (init.method ?? "GET") === method &&
    (typeof path === "string" ? url.pathname === path : path.test(url.pathname))
      ? respond(url, init)
      : undefined;
