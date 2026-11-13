import type { Project } from "@avs/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ErrorBox } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";
import {
  isActive,
  PLATFORM_LABELS,
  STATUS_DISPLAY,
  timeAgo,
  VIDEO_TYPE_LABELS,
} from "../lib/format";
import { Link, navigate } from "../lib/router";
import {
  ApiClientError,
  countJobs,
  countScenes,
  deleteProject,
  getProject,
  updateProject,
} from "../services/api";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; project: Project };

export function ProjectPage({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [counts, setCounts] = useState<{ scenes: number; jobs: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = (quiet: boolean) => {
      getProject(id, ctrl.signal).then(
        (project) => setState({ kind: "ready", project }),
        (e: unknown) => {
          if (ctrl.signal.aborted) return;
          if (e instanceof ApiClientError && e.status === 404) setState({ kind: "missing" });
          else if (!quiet)
            setState({
              kind: "error",
              message: e instanceof Error ? e.message : "Could not load.",
            });
        },
      );
      Promise.all([countScenes(id), countJobs(id)]).then(
        ([scenes, jobs]) => setCounts({ scenes, jobs }),
        () => undefined,
      );
    };
    load(false);
    return () => ctrl.abort();
  }, [id, reload]);

  // Poll while the project is in production so the status badge stays current.
  const active = state.kind === "ready" && isActive(state.project.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      getProject(id).then(
        (project) => setState({ kind: "ready", project }),
        () => undefined,
      );
    }, 5000);
    return () => clearInterval(t);
  }, [active, id]);

  if (state.kind === "loading")
    return <div className="card skeleton tall" aria-busy="true" aria-label="Loading" />;
  if (state.kind === "missing")
    return (
      <section className="narrow">
        <Link href="/" className="back">
          ← Projects
        </Link>
        <h1>Project not found</h1>
        <p className="muted">It may have been deleted, or it belongs to another account.</p>
      </section>
    );
  if (state.kind === "error")
    return (
      <ErrorBox
        message={state.message}
        onRetry={() => {
          setState({ kind: "loading" });
          setReload((r) => r + 1);
        }}
      />
    );

  const p = state.project;
  const style = typeof p.production_config.style === "string" ? p.production_config.style : null;

  async function saveTitle(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || title.trim() === p.title) return setEditing(false);
    setBusy(true);
    setActionError(null);
    try {
      const project = await updateProject(p.id, { title: title.trim() });
      setState({ kind: "ready", project });
      setEditing(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not rename.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(`Delete "${p.title}"? Its media will be deleted too. This can't be undone.`)
    )
      return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteProject(p.id);
      navigate("/", { replace: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not delete.");
      setBusy(false);
    }
  }

  return (
    <section>
      <Link href="/" className="back">
        ← Projects
      </Link>
      <div className="page-head">
        <div className="title-block">
          {editing ? (
            <form onSubmit={saveTitle} className="inline-edit">
              <input
                aria-label="Project title"
                value={title}
                maxLength={200}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
              />
              <button type="submit" className="btn primary small" disabled={busy}>
                Save
              </button>
              <button type="button" className="btn small" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <h1>
              {p.title}{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setTitle(p.title);
                  setEditing(true);
                }}
              >
                Rename
              </button>
            </h1>
          )}
          <div className="status-line">
            <StatusBadge status={p.status} />
            <span className="muted">{STATUS_DISPLAY[p.status].hint}</span>
          </div>
        </div>
      </div>

      {actionError && <ErrorBox message={actionError} />}

      <div className="detail-grid">
        <div className="card">
          <h2>Brief</h2>
          <p className="prompt full">{p.prompt}</p>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{VIDEO_TYPE_LABELS[p.video_type]}</dd>
            <dt>Format</dt>
            <dd>
              {p.aspect_ratio} · {p.duration_seconds} seconds
            </dd>
            <dt>Platform</dt>
            <dd>{PLATFORM_LABELS[p.target_platform]}</dd>
            <dt>Style</dt>
            <dd>{style ?? <span className="muted">Not set</span>}</dd>
            <dt>Created</dt>
            <dd title={p.created_at}>{timeAgo(p.created_at)}</dd>
          </dl>
        </div>

        <div className="card">
          <h2>Production</h2>
          <ol className="steps">
            {(
              [
                "Script & storyboard",
                "Images, video & voice",
                "Render in your browser",
                "Quality check",
              ] as const
            ).map((s, i) => (
              <li key={s} className="step">
                <span className="step-num">{i + 1}</span> {s}
              </li>
            ))}
          </ol>
          <p className="muted small">
            {counts ? `${counts.scenes} scenes · ${counts.jobs} jobs so far.` : "Loading progress…"}
          </p>
          <button
            type="button"
            className="btn primary wide"
            disabled
            title="Arrives with workflow orchestration (Task 7)"
          >
            Generate video
          </button>
          <p className="muted small">
            Automatic production is being built and isn't available yet.
          </p>
        </div>
      </div>

      <div className="danger-zone">
        <button type="button" className="btn danger" onClick={remove} disabled={busy}>
          Delete project
        </button>
      </div>
    </section>
  );
}
