import type { AspectRatio } from "@avs/types";
import { z } from "zod";
import { bytesReader, inspectMp4 } from "../quality/mp4";
import {
  httpError,
  ProviderError,
  type MediaResult,
  type RequestFor,
  type SyncMediaProvider,
} from "./types";

/**
 * Pexels stock footage (https://www.pexels.com/api/). Free with an API key: 200 requests an hour
 * and 20,000 a month by default; videos are under the Pexels License (free for commercial use,
 * no attribution required, but the API terms ask apps to credit Pexels and the creator, which
 * the asset's licence record and the scene card do). Real filmed clips, not generated video.
 * Search results are validated; the clip is downloaded server-side from an allowed host, size
 * capped and checked to be an MP4 with a video track.
 */

const API = "https://api.pexels.com/videos/search";
const MAX_BYTES = 30 * 1024 * 1024;
const ALLOWED_HOSTS = [/(^|\.)pexels\.com$/, /(^|\.)vimeo\.com$/, /(^|\.)vimeocdn\.com$/];

const fileSchema = z.object({
  file_type: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  link: z.url(),
});
const videoSchema = z.object({
  id: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: z.number().nonnegative(),
  url: z.url(),
  user: z.object({ name: z.string().max(200), url: z.url() }),
  video_files: z.array(fileSchema),
});
const searchSchema = z.object({ videos: z.array(z.unknown()) });
type PexelsVideo = z.infer<typeof videoSchema>;

const ORIENTATION: Record<AspectRatio, "portrait" | "landscape" | "square"> = {
  "9:16": "portrait",
  "16:9": "landscape",
  "1:1": "square",
};

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** The clip's MP4 file closest to 720p on its short side, never above 1080p. */
export function pickFile(video: PexelsVideo): z.infer<typeof fileSchema> | null {
  const mp4 = video.video_files.filter(
    (f) =>
      f.file_type === "video/mp4" && f.width && f.height && Math.min(f.width, f.height) <= 1080,
  );
  const short = (f: z.infer<typeof fileSchema>) => Math.min(f.width ?? 0, f.height ?? 0);
  mp4.sort((a, b) => Math.abs(short(a) - 720) - Math.abs(short(b) - 720));
  return mp4[0] ?? null;
}

/** Ranks results: matching orientation first, then clips long enough for the scene. */
export function rankVideos(videos: PexelsVideo[], aspect: AspectRatio, seconds: number) {
  const want = ORIENTATION[aspect];
  const orientation = (v: PexelsVideo) =>
    v.width === v.height ? "square" : v.width > v.height ? "landscape" : "portrait";
  return [...videos].sort(
    (a, b) =>
      Number(orientation(b) === want) - Number(orientation(a) === want) ||
      Number(b.duration >= seconds) - Number(a.duration >= seconds),
  );
}

const allowed = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
};

export class PexelsStockVideo implements SyncMediaProvider<"video"> {
  readonly name = "pexels-video";
  readonly capability = "video" as const;
  readonly mode = "sync" as const;
  readonly tier = "free" as const;
  readonly cost = {
    unit: "clip" as const,
    usd_per_unit: 0,
    source: "Pexels API: free with a key (200 requests/hour, 20,000/month)",
  };
  readonly limits = { max_prompt_chars: 100 };
  readonly timeoutMs = 45_000;
  readonly credential = "PEXELS_API_KEY";
  readonly commercialUse = true;
  /** About 2/3 of the monthly allowance spread over 30 days, leaving room for retries. */
  readonly defaultDailyLimit = 400;
  readonly defaultPriority = 10;

  constructor(
    private readonly key: () => string | null,
    private readonly fetcher: Fetcher = (i, init) => fetch(i, init),
  ) {}

  async generate(req: RequestFor<"video">, signal: AbortSignal): Promise<MediaResult> {
    const key = this.key();
    if (!key) throw new ProviderError(this.name, "PEXELS_API_KEY isn't set", "auth", false);
    const query = req.prompt.trim().slice(0, 100);
    if (!query) throw new ProviderError(this.name, "nothing to search for", "unsupported", false);

    const params = new URLSearchParams({
      query,
      orientation: ORIENTATION[req.aspect_ratio],
      size: "medium",
      per_page: "10",
    });
    let res: Response;
    try {
      res = await this.fetcher(`${API}?${params}`, { headers: { Authorization: key }, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ProviderError(this.name, "search request failed", "unavailable", true);
    }
    if (!res.ok) throw httpError(this.name, res.status);
    const body = searchSchema.safeParse(await res.json().catch(() => null));
    if (!body.success)
      throw new ProviderError(
        this.name,
        "search returned an unexpected shape",
        "bad_response",
        true,
      );
    // Validate each result on its own, so one odd entry doesn't sink the search.
    const videos = body.data.videos.flatMap((v) => {
      const p = videoSchema.safeParse(v);
      return p.success ? [p.data] : [];
    });
    const avoid = new Set(req.avoid ?? []);
    const ranked = rankVideos(
      videos.filter((v) => !avoid.has(`pexels:${v.id}`)),
      req.aspect_ratio,
      req.duration_seconds,
    );
    const choice = ranked.map((v) => ({ v, f: pickFile(v) })).find((x) => x.f && allowed(x.f.link));
    if (!choice?.f)
      throw new ProviderError(
        this.name,
        `no stock clip found for "${query}"`,
        "unsupported",
        false,
      );

    const bytes = await this.download(choice.f.link, signal);
    let info;
    try {
      info = await inspectMp4(bytesReader(bytes), bytes.length);
    } catch {
      throw new ProviderError(this.name, "the clip isn't a readable MP4", "bad_response", true);
    }
    const track = info.tracks.find((t) => t.kind === "video");
    if (!track) throw new ProviderError(this.name, "the clip has no video", "bad_response", true);
    return {
      bytes,
      mime_type: "video/mp4",
      extension: "mp4",
      ...(track.width ? { width: track.width, height: track.height } : {}),
      duration_seconds: Math.round(info.durationSeconds * 100) / 100,
      units: 1,
      unit_type: "clips",
      model: `pexels:${choice.v.id}`,
      license: {
        source: "pexels",
        license: "Pexels License (https://www.pexels.com/license/)",
        author: choice.v.user.name,
        author_url: choice.v.user.url,
        page_url: choice.v.url,
        credit: `Video by ${choice.v.user.name} on Pexels`,
      },
    };
  }

  /** Downloads at most MAX_BYTES, refusing redirects to hosts outside the allow-list. */
  private async download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetcher(url, { signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ProviderError(this.name, "clip download failed", "unavailable", true);
    }
    if (res.url && !allowed(res.url))
      throw new ProviderError(
        this.name,
        "clip redirected to an unexpected host",
        "bad_response",
        false,
      );
    if (!res.ok || !res.body) throw httpError(this.name, res.status || 502);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES)
      throw new ProviderError(this.name, "the clip is too large", "bad_response", false);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new ProviderError(this.name, "the clip is too large", "bad_response", false);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

/** Search words from a scene description: no filler, at most six words. */
export function stockQuery(text: string): string {
  const STOP = new Set(
    "a an the and or but of in on at to for with from by as is are was were be been this that these those it its into over under while our your their his her them they we you i".split(
      " ",
    ),
  );
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 6)
    .join(" ");
}
