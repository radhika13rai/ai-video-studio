import { LIMITS, type QualityStatus } from "@avs/types";
import type { Asset, Project, Scene } from "../db";
import { inspectMp4, Mp4Error, type Mp4Info, type ReadAt } from "./mp4";

/**
 * Quality controller: deterministic checks on the final MP4 and the production around it
 * (CLAUDE.md rule 15: no model needed to verify structure, timing and coverage).
 */

export type CheckStatus = "pass" | "warn" | "fail";

export interface QualityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface QualityResult {
  overall_status: QualityStatus;
  score: number;
  checks: QualityCheck[];
  recommendations: string[];
  mp4: Mp4Info | null;
}

const EXPECTED: Record<string, [number, number][]> = {
  "9:16": [
    [720, 1280],
    [1080, 1920],
  ],
  "16:9": [
    [1280, 720],
    [1920, 1080],
  ],
  "1:1": [
    [720, 720],
    [1080, 1080],
  ],
};

export async function runQualityChecks(input: {
  project: Pick<Project, "aspect_ratio" | "duration_seconds">;
  scenes: Pick<Scene, "id" | "scene_number" | "visual_type" | "voiceover" | "duration_seconds">[];
  assets: Pick<Asset, "scene_id" | "asset_type">[];
  narrationPlanned: boolean;
  video: { read: ReadAt; size: number } | null;
  /**
   * Length the browser renderer planned after fitting scenes to the narration (reported with
   * the upload). Used only when it's plausible; the real length always comes from the MP4.
   */
  renderPlanSeconds?: number | null;
  /**
   * What voiced the video, as the renderer reported it with the upload. When present it decides
   * the narration checks (narration is usually voiced in the browser, so no voice asset exists).
   */
  renderNarration?: { kind: string; voiced: number; total: number } | null;
}): Promise<QualityResult> {
  const checks: QualityCheck[] = [];
  const recs: string[] = [];
  const add = (c: QualityCheck, rec?: string) => {
    checks.push(c);
    if (rec && c.status !== "pass") recs.push(rec);
  };

  // 1. The file itself.
  let mp4: Mp4Info | null = null;
  if (!input.video) {
    add(
      { id: "file", label: "Video file", status: "fail", detail: "No rendered video was found." },
      "Render the video again.",
    );
  } else {
    try {
      mp4 = await inspectMp4(input.video.read, input.video.size);
      add(
        {
          id: "file",
          label: "Video file",
          status: mp4.hasMdat ? "pass" : "fail",
          detail: mp4.hasMdat
            ? `Valid MP4 (${mp4.brand}), ${(input.video.size / 1048576).toFixed(1)} MB.`
            : "The MP4 has no media data.",
        },
        "Render the video again.",
      );
    } catch (err) {
      const msg = err instanceof Mp4Error ? err.message : "unreadable file";
      add(
        { id: "file", label: "Video file", status: "fail", detail: `Not a playable MP4: ${msg}.` },
        "Render the video again.",
      );
    }
  }

  if (mp4) {
    const video = mp4.tracks.find((t) => t.kind === "video");
    const audio = mp4.tracks.find((t) => t.kind === "audio");

    if (!video)
      add(
        {
          id: "video",
          label: "Video track",
          status: "fail",
          detail: "The file has no video track.",
        },
        "Render the video again.",
      );
    else {
      const codecOk = video.codec === "avc1" || video.codec === "avc3";
      add(
        {
          id: "codec",
          label: "Video codec",
          status: codecOk ? "pass" : "warn",
          detail: codecOk
            ? "H.264, plays everywhere."
            : `Codec '${video.codec}' may not play on every platform.`,
        },
        "Render again in a browser with H.264 support.",
      );
      const sizes = EXPECTED[input.project.aspect_ratio] ?? [];
      const sizeOk = sizes.some(([w, h]) => w === video.width && h === video.height);
      add(
        {
          id: "resolution",
          label: "Resolution",
          status: sizeOk ? "pass" : "warn",
          detail: `${video.width}×${video.height} for ${input.project.aspect_ratio}${sizeOk ? "." : `; expected ${sizes.map(([w, h]) => `${w}×${h}`).join(" or ")}.`}`,
        },
        "Render again at 720p or 1080p.",
      );
    }

    const reported = input.renderNarration ?? null;
    const expectsAudio =
      input.narrationPlanned &&
      (reported ? reported.voiced > 0 : input.assets.some((a) => a.asset_type === "voiceover"));
    if (audio) {
      const aacOk = audio.codec === "mp4a";
      add({
        id: "audio",
        label: "Audio track",
        status: aacOk ? "pass" : "warn",
        detail: aacOk
          ? `AAC, ${audio.sampleRate ?? "?"} Hz, ${audio.channels ?? "?"} channel(s).`
          : `Audio codec '${audio.codec}' is unusual.`,
      });
    } else
      add(
        {
          id: "audio",
          label: "Audio track",
          status: expectsAudio ? "fail" : "warn",
          detail: expectsAudio
            ? "Narration was generated but the video has no audio."
            : "The video is silent.",
        },
        expectsAudio
          ? "Render the video again; the narration didn't make it into the file."
          : "Render again in a browser that can run the Kokoro voice to get narration.",
      );

    const planned = input.project.duration_seconds;
    const actual = mp4.durationSeconds;
    const plan = plausibleRenderPlan(input.renderPlanSeconds, planned);
    const durationRec = "Render the video again.";
    if (plan === null) {
      // No usable render plan (older uploads): compare with the brief, as before.
      const off = Math.abs(actual - planned);
      add(
        {
          id: "duration",
          label: "Length",
          status: off <= 0.5 ? "pass" : off <= planned * 0.25 ? "warn" : "fail",
          detail: `${actual.toFixed(2)} s (planned ${planned} s).`,
        },
        durationRec,
      );
    } else {
      // Did the file come out as long as the renderer meant it to? Catches truncated renders.
      const off = Math.abs(actual - plan);
      add(
        {
          id: "render_length",
          label: "Render length",
          status: off <= 0.5 ? "pass" : off <= plan * 0.25 ? "warn" : "fail",
          detail: `${actual.toFixed(2)} s (the render planned ${plan.toFixed(2)} s).`,
        },
        durationRec,
      );
      // Scenes stretch to fit their narration, so a longer video than the brief is expected:
      // it's a warning, and fails only when absurdly far off.
      const briefOff = Math.abs(actual - planned);
      const absurd = actual < planned * 0.25 || actual > LIMITS.maxVideoDurationSeconds * 1.5;
      add(
        {
          id: "duration",
          label: "Length",
          status: briefOff <= 0.5 ? "pass" : absurd ? "fail" : "warn",
          detail: `${actual.toFixed(2)} s (planned ${planned} s${actual > planned + 0.5 ? "; scenes were lengthened to fit the narration" : ""}).`,
        },
        "Shorten the narration or raise the planned length if this matters for your platform.",
      );
    }

    add(
      {
        id: "faststart",
        label: "Streaming",
        status: mp4.fastStart ? "pass" : "warn",
        detail: mp4.fastStart
          ? "Starts playing before it fully downloads."
          : "The index is at the end, so playback waits for the whole file.",
      },
      "Render again; the renderer writes fast-start files.",
    );

    const kbps =
      mp4.durationSeconds > 0 && input.video
        ? (input.video.size * 8) / 1000 / mp4.durationSeconds
        : 0;
    add(
      {
        id: "bitrate",
        label: "Bitrate",
        status: kbps >= 300 ? "pass" : "warn",
        detail: `${Math.round(kbps)} kb/s${kbps < 300 ? ", which may look blocky" : ""}.`,
      },
      "Render at a higher quality.",
    );
  }

  // 2. Production coverage (what the brief asked for vs what was generated).
  const visual = input.scenes.filter((s) => s.visual_type !== "text");
  const withImage = visual.filter((s) =>
    input.assets.some((a) => a.scene_id === s.id && a.asset_type === "image"),
  );
  const missingImages = visual.filter((s) => !withImage.includes(s)).map((s) => s.scene_number);
  add(
    {
      id: "images",
      label: "Scene images",
      status: missingImages.length === 0 ? "pass" : "warn",
      detail:
        visual.length === 0
          ? "No image scenes."
          : `${withImage.length} of ${visual.length} image scenes have a generated image.`,
    },
    `Scene${missingImages.length > 1 ? "s" : ""} ${missingImages.join(", ")} ${missingImages.length > 1 ? "have" : "has"} no image; use "Retry media" on ${missingImages.length > 1 ? "them" : "it"}, then render again.`,
  );
  if (input.narrationPlanned) {
    const spoken = input.scenes.filter((s) => (s.voiceover ?? "").trim());
    const reported = input.renderNarration ?? null;
    if (reported && spoken.length > 0) {
      const missing = Math.max(0, reported.total - reported.voiced);
      add(
        {
          id: "narration",
          label: "Narration",
          status: missing === 0 ? "pass" : "warn",
          detail: `${reported.voiced} of ${reported.total} narrated scenes have audio${reported.kind === "kokoro" ? " (Kokoro voice)" : reported.kind === "provider" ? " (server voice)" : ""}.`,
        },
        reported.voiced === 0
          ? "No narration made it into the video; render again (the Kokoro voice needs a browser with background-worker support)."
          : "Some scenes have no narration; render again.",
      );
    } else {
      const voiced = spoken.filter((s) =>
        input.assets.some((a) => a.scene_id === s.id && a.asset_type === "voiceover"),
      );
      const missingVoice = spoken.filter((s) => !voiced.includes(s)).map((s) => s.scene_number);
      add(
        {
          id: "narration",
          label: "Narration",
          status: missingVoice.length === 0 ? "pass" : "warn",
          detail: `${voiced.length} of ${spoken.length} narrated scenes have audio.`,
        },
        `Scene${missingVoice.length > 1 ? "s" : ""} ${missingVoice.join(", ")} ${missingVoice.length > 1 ? "have" : "has"} no narration; use "Retry media", then render again.`,
      );
    }
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return {
    overall_status: fails > 0 ? "failed" : warns > 0 ? "warning" : "passed",
    score: Math.max(0, 100 - fails * 30 - warns * 8),
    checks,
    recommendations: [...new Set(recs)],
    mp4,
  };
}

/** The renderer's planned length, if it is a believable value for this brief; else null. */
export function plausibleRenderPlan(
  reported: number | null | undefined,
  planned: number,
): number | null {
  if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0) return null;
  if (reported < planned * 0.5 || reported > planned * 2) return null;
  if (reported > LIMITS.maxVideoDurationSeconds * 1.5) return null;
  return reported;
}
