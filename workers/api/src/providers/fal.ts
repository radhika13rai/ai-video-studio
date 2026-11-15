import { z } from "zod";
import { bytesReader, inspectMp4 } from "../quality/mp4";
import {
  httpError,
  ProviderError,
  type AsyncMediaProvider,
  type PollResult,
  type RequestFor,
} from "./types";

/**
 * Paid image-to-video through fal.ai's queue API (ADR 042), model Wan 2.5 image-to-video
 * (`fal-ai/wan-25-preview/image-to-video`, $0.10 per second at 720p on fal's model page,
 * 2026-11-15). Switched off unless PAID_PROVIDERS=on, a daily budget is set and the FAL_KEY
 * secret exists. Queue protocol (fal docs): POST https://queue.fal.run/<model> with
 * "Authorization: Key <key>" returns request_id, status_url and response_url; GET status_url
 * gives IN_QUEUE | IN_PROGRESS | COMPLETED (COMPLETED also covers failures, so the result decides);
 * GET response_url gives the model output, here { video: { url } }.
 * Not yet run against the live API: no key exists in development.
 */

const MODEL = "fal-ai/wan-25-preview/image-to-video";
const QUEUE = "https://queue.fal.run";
const MAX_BYTES = 60 * 1024 * 1024;
const RESULT_HOSTS = [
  /(^|\.)fal\.media$/,
  /(^|\.)fal\.run$/,
  /(^|\.)fal\.ai$/,
  /^storage\.googleapis\.com$/,
];

const submitSchema = z.object({
  request_id: z.string().min(1).max(200),
  response_url: z.url(),
  status_url: z.url().optional(),
});
const statusSchema = z.object({
  status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
});
const resultSchema = z.object({ video: z.object({ url: z.url() }) });

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const hostOk = (url: string, hosts: RegExp[]) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
};

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class FalWanImageToVideo implements AsyncMediaProvider<"image_to_video"> {
  readonly name = "fal-wan25-i2v";
  readonly capability = "image_to_video" as const;
  readonly mode = "async" as const;
  readonly tier = "paid" as const;
  readonly cost = {
    unit: "second" as const,
    usd_per_unit: 0.1,
    source: "fal.ai model page for Wan 2.5 image-to-video, 720p (checked 2026-11-15)",
  };
  /** The model makes 5 s or 10 s clips; the workflow asks for one of those. */
  readonly limits = { min_duration_seconds: 5, max_duration_seconds: 10, max_prompt_chars: 800 };
  readonly timeoutMs = 30_000;
  readonly credential = "FAL_KEY";
  readonly commercialUse = true;
  readonly defaultDailyLimit = 40;
  readonly defaultPriority = 10;
  readonly pollIntervalSeconds = 15;
  readonly maxWaitSeconds = 600;

  constructor(
    private readonly key: () => string | null,
    private readonly fetcher: Fetcher = (i, init) => fetch(i, init),
  ) {}

  private headers(): Record<string, string> {
    const key = this.key();
    if (!key) throw new ProviderError(this.name, "FAL_KEY isn't set", "auth", false);
    return { Authorization: `Key ${key}`, "content-type": "application/json" };
  }

  private async call(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetcher(url, { ...init, signal });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new ProviderError(this.name, "request failed", "unavailable", true);
    }
  }

  async submit(
    req: RequestFor<"image_to_video">,
    signal: AbortSignal,
  ): Promise<{ external_id: string }> {
    if (!req.image.mime_type.startsWith("image/"))
      throw new ProviderError(this.name, "needs a still image", "unsupported", false);
    const res = await this.call(
      `${QUEUE}/${MODEL}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          prompt: req.prompt.slice(0, 800),
          image_url: `data:${req.image.mime_type};base64,${base64(req.image.bytes)}`,
          resolution: "720p",
          duration: req.duration_seconds > 5 ? "10" : "5",
        }),
      },
      signal,
    );
    if (!res.ok) throw httpError(this.name, res.status, await res.text().catch(() => ""));
    const body = submitSchema.safeParse(await res.json().catch(() => null));
    if (!body.success || !hostOk(body.data.response_url, [/^queue\.fal\.run$/]))
      throw new ProviderError(
        this.name,
        "submit returned an unexpected answer",
        "bad_response",
        true,
      );
    // The response URL identifies the job; its status lives at <response_url>/status.
    return { external_id: body.data.response_url };
  }

  async poll(externalId: string, signal: AbortSignal): Promise<PollResult> {
    if (!hostOk(externalId, [/^queue\.fal\.run$/]))
      return { status: "failed", message: "unknown job reference", retryable: false };
    const headers = this.headers();
    const st = await this.call(`${externalId}/status`, { headers }, signal);
    if (!st.ok) throw httpError(this.name, st.status);
    const status = statusSchema.safeParse(await st.json().catch(() => null));
    if (!status.success)
      throw new ProviderError(
        this.name,
        "status returned an unexpected answer",
        "bad_response",
        true,
      );
    if (status.data.status !== "COMPLETED") return { status: "running" };

    const res = await this.call(externalId, { headers }, signal);
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 160);
      return {
        status: "failed",
        message: `the job failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        retryable: res.status >= 500,
      };
    }
    const result = resultSchema.safeParse(await res.json().catch(() => null));
    if (!result.success)
      return { status: "failed", message: "the job finished without a video", retryable: true };
    const url = result.data.video.url;
    if (!hostOk(url, RESULT_HOSTS))
      return { status: "failed", message: "the video is on an unexpected host", retryable: false };

    const bytes = await this.download(url, signal);
    let info;
    try {
      info = await inspectMp4(bytesReader(bytes), bytes.length);
    } catch {
      return { status: "failed", message: "the video isn't a readable MP4", retryable: true };
    }
    const track = info.tracks.find((t) => t.kind === "video");
    if (!track) return { status: "failed", message: "the file has no video", retryable: true };
    const seconds = Math.round(info.durationSeconds * 100) / 100;
    return {
      status: "succeeded",
      result: {
        bytes,
        mime_type: "video/mp4",
        extension: "mp4",
        ...(track.width ? { width: track.width, height: track.height } : {}),
        duration_seconds: seconds,
        // Billed per second of output (5 or 10).
        units: seconds > 7.5 ? 10 : 5,
        unit_type: "seconds",
        model: MODEL,
        license: { source: "generated", provider: this.name, model: MODEL },
      },
    };
  }

  private async download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    const res = await this.call(url, {}, signal);
    if (res.url && !hostOk(res.url, RESULT_HOSTS))
      throw new ProviderError(
        this.name,
        "video redirected to an unexpected host",
        "bad_response",
        false,
      );
    if (!res.ok || !res.body) throw httpError(this.name, res.status || 502);
    if (Number(res.headers.get("content-length") ?? "0") > MAX_BYTES)
      throw new ProviderError(this.name, "the video is too large", "bad_response", false);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_BYTES)
      throw new ProviderError(this.name, "the video is too large", "bad_response", false);
    return buf;
  }
}
