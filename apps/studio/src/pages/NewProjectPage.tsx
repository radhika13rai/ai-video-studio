import { createProjectRequestSchema } from "@avs/schemas";
import {
  ASPECT_RATIOS,
  LIMITS,
  TARGET_PLATFORMS,
  VIDEO_TYPES,
  type AspectRatio,
  type TargetPlatform,
  type VideoType,
} from "@avs/types";
import { useRef, useState, type FormEvent } from "react";
import { ErrorBox } from "../components/Feedback";
import { PLATFORM_LABELS, VIDEO_TYPE_LABELS } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { ApiClientError, createProject } from "../services/api";

const RATIO_HELP: Record<AspectRatio, string> = {
  "9:16": "Vertical · Shorts, Reels, TikTok",
  "16:9": "Landscape · YouTube",
  "1:1": "Square · feeds",
};
const PROMPT_MAX = 4000;

interface Form {
  title: string;
  prompt: string;
  video_type: VideoType;
  aspect_ratio: AspectRatio;
  duration_seconds: number;
  target_platform: TargetPlatform;
  style: string;
}

export function NewProjectPage() {
  const [form, setForm] = useState<Form>({
    title: "",
    prompt: "",
    video_type: "auto",
    aspect_ratio: "9:16",
    duration_seconds: 30,
    target_platform: "youtube_shorts",
    style: "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One key per form: a double click or a retry after a network error can't create two projects.
  const idempotencyKey = useRef(crypto.randomUUID());

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const candidate = { ...form, style: form.style.trim() || undefined };
    const parsed = createProjectRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Partial<Record<keyof Form, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Form | undefined;
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setSubmitting(true);
    setServerError(null);
    try {
      const project = await createProject(parsed.data, idempotencyKey.current);
      navigate(`/projects/${project.id}`, { replace: true });
    } catch (err) {
      setServerError(err instanceof ApiClientError ? err.message : "Could not create the project.");
      setSubmitting(false);
    }
  }

  return (
    <section className="narrow">
      <Link href="/" className="back">
        ← Projects
      </Link>
      <h1>New video</h1>
      <p className="muted">Describe what you want. You can change the title and style later.</p>

      <form className="card form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            name="title"
            value={form.title}
            maxLength={200}
            placeholder="e.g. 5 facts about the deep ocean"
            onChange={(e) => set("title", e.target.value)}
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? "title-error" : undefined}
          />
          {errors.title && (
            <small id="title-error" className="field-error">
              Give your video a title.
            </small>
          )}
        </div>

        <div className="field">
          <label htmlFor="prompt">What should the video be about?</label>
          <textarea
            id="prompt"
            name="prompt"
            rows={5}
            value={form.prompt}
            maxLength={PROMPT_MAX}
            placeholder="Describe the topic, the audience and the feel. The more specific, the better."
            onChange={(e) => set("prompt", e.target.value)}
            aria-invalid={!!errors.prompt}
            aria-describedby="prompt-help"
          />
          <small id="prompt-help" className={errors.prompt ? "field-error" : "help"}>
            {errors.prompt ? "Describe your video." : `${form.prompt.length} / ${PROMPT_MAX}`}
          </small>
        </div>

        <fieldset className="field">
          <legend>Format</legend>
          <div className="ratios">
            {ASPECT_RATIOS.map((r) => (
              <label
                key={r}
                className={`ratio-option${form.aspect_ratio === r ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="aspect_ratio"
                  value={r}
                  checked={form.aspect_ratio === r}
                  onChange={() => set("aspect_ratio", r)}
                />
                <span className={`ratio-shape ratio-${r.replace(":", "x")}`} aria-hidden="true" />
                <strong>{r}</strong>
                <small>{RATIO_HELP[r]}</small>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="row2">
          <label className="field">
            <span>Video type</span>
            <select
              name="video_type"
              value={form.video_type}
              onChange={(e) => set("video_type", e.target.value as VideoType)}
            >
              {VIDEO_TYPES.map((t) => (
                <option key={t} value={t}>
                  {VIDEO_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Platform</span>
            <select
              name="target_platform"
              value={form.target_platform}
              onChange={(e) => set("target_platform", e.target.value as TargetPlatform)}
            >
              {TARGET_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>
            Length: <strong>{form.duration_seconds} seconds</strong>
          </span>
          <input
            type="range"
            name="duration_seconds"
            min={LIMITS.minVideoDurationSeconds}
            max={LIMITS.maxVideoDurationSeconds}
            step={5}
            value={form.duration_seconds}
            onChange={(e) => set("duration_seconds", Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>
            Style <em className="muted">(optional)</em>
          </span>
          <input
            name="style"
            value={form.style}
            maxLength={200}
            placeholder="e.g. premium cinematic, playful, minimal"
            onChange={(e) => set("style", e.target.value)}
          />
        </label>

        {serverError && <ErrorBox message={serverError} />}

        <div className="actions">
          <Link href="/" className="btn">
            Cancel
          </Link>
          <button type="submit" className="btn primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </section>
  );
}
