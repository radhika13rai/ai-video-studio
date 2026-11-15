import type { Asset, Job, Project, QualityReport, Scene, WorkflowRun } from "@avs/contracts";
import type { ProjectStatus } from "@avs/types";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorBox } from "../components/Feedback";
import {
  blueprintAssumptions,
  PipelineSteps,
  pipelineSteps,
  SceneList,
  sceneDirections,
} from "../components/Production";
import { QualityCard } from "../components/QualityCard";
import { FinalVideo, RenderPanel } from "../components/RenderPanel";
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
  cancelProject,
  deleteProject,
  generateProject,
  getProject,
  getQuality,
  getRun,
  listAssets,
  listJobs,
  listScenes,
  retrySceneMedia,
  updateProject,
} from "../services/api";

const STARTABLE: ProjectStatus[] = [
  "created",
  "failed",
  "cancelled",
  "awaiting_render",
  "completed",
];
const CANCELLABLE: ProjectStatus[] = [
  "planning",
  "generating",
  "awaiting_render",
  "rendering",
  "quality_check",
];

interface Progress {
  jobs: Job[];
  scenes: Scene[];
  assets: Asset[];
  run: WorkflowRun | null;
  quality: QualityReport | null;
}

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; project: Project };

/** Statuses in which the timeline editor is open (production has made the media). */
const EDITABLE: ProjectStatus[] = ["awaiting_render", "completed", "failed", "cancelled"];

export function ProjectPage({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [progress, setProgress] = useState<Progress>({
    jobs: [],
    scenes: [],
    assets: [],
    run: null,
    quality: null,
  });
  const [retrying, setRetrying] = useState<string | null>(null);
  // One key per page visit: a double click can't start two runs.
  const generateKey = useRef(crypto.randomUUID());

  const loadProgress = useCallback(() => {
    // Each part loads independently: one failing request mustn't blank the whole panel.
    Promise.allSettled([
      listJobs(id),
      listScenes(id),
      listAssets(id),
      getRun(id),
      getQuality(id),
    ]).then(([jobs, scenes, assets, run, quality]) =>
      setProgress((prev) => ({
        jobs: jobs.status === "fulfilled" ? jobs.value : prev.jobs,
        scenes: scenes.status === "fulfilled" ? scenes.value : prev.scenes,
        assets: assets.status === "fulfilled" ? assets.value : prev.assets,
        run: run.status === "fulfilled" ? run.value : prev.run,
        quality: quality.status === "fulfilled" ? quality.value : prev.quality,
      })),
    );
  }, [id]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [rendering, setRendering] = useState(false);

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
      loadProgress();
    };
    load(false);
    return () => ctrl.abort();
  }, [id, reload, loadProgress]);

  // Poll while the project is in production so the status badge stays current.
  const active = state.kind === "ready" && isActive(state.project.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      getProject(id).then(
        (project) => setState({ kind: "ready", project }),
        () => undefined,
      );
      loadProgress();
    }, 3000);
    return () => clearInterval(t);
  }, [active, id, loadProgress]);

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
  const finalVideo = progress.assets.find((a) => a.asset_type === "render") ?? null;
  const assumptions = blueprintAssumptions(p.production_config);
  const directions = sceneDirections(p.production_config);
  const fallbacks = Array.isArray(p.production_config.fallbacks)
    ? p.production_config.fallbacks.filter((f): f is string => typeof f === "string")
    : [];

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

  async function generate() {
    setBusy(true);
    setActionError(null);
    try {
      await generateProject(p.id, generateKey.current);
      generateKey.current = crypto.randomUUID();
      const project = await getProject(p.id);
      setState({ kind: "ready", project });
      loadProgress();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start production.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm("Stop production? Finished steps are kept.")) return;
    setBusy(true);
    setActionError(null);
    try {
      setState({ kind: "ready", project: await cancelProject(p.id) });
      loadProgress();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  async function retryScene(sceneId: string) {
    setRetrying(sceneId);
    setActionError(null);
    try {
      await retrySceneMedia(p.id, sceneId);
      setState({ kind: "ready", project: await getProject(p.id) });
      loadProgress();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not retry the scene.");
    } finally {
      setRetrying(null);
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
          <PipelineSteps steps={pipelineSteps(p, progress.jobs, progress.run)} />
          {p.status === "failed" && progress.run?.error_message && (
            <p className="alert error small-alert">{progress.run.error_message}</p>
          )}
          {assumptions.length > 0 && (
            <div className="notes assumptions">
              <p className="small">
                <strong>Assumptions made from your request</strong>
              </p>
              <ul className="notes">
                {assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {fallbacks.length > 0 && (
            <ul className="notes">
              {fallbacks.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {(p.status === "awaiting_render" || p.status === "rendering") && (
            <RenderPanel
              project={p}
              onBusyChange={setRendering}
              onFinished={() => {
                getProject(p.id).then(
                  (project) => setState({ kind: "ready", project }),
                  () => undefined,
                );
                loadProgress();
              }}
            />
          )}
          {EDITABLE.includes(p.status) && progress.scenes.length > 0 && !rendering && (
            <Link href={`/projects/${p.id}/edit`} className="btn wide primary">
              Edit video
            </Link>
          )}
          {STARTABLE.includes(p.status) && !rendering && (
            <button
              type="button"
              className={`btn wide${p.status === "awaiting_render" ? "" : " primary"}`}
              onClick={generate}
              disabled={busy}
            >
              {p.status === "created" ? "Generate video" : "Generate again"}
            </button>
          )}
          {CANCELLABLE.includes(p.status) && !rendering && (
            <button type="button" className="btn wide" onClick={cancel} disabled={busy}>
              Cancel production
            </button>
          )}
        </div>
      </div>

      {finalVideo && <FinalVideo asset={finalVideo} aspect={p.aspect_ratio} />}

      {progress.quality && ["completed", "failed"].includes(p.status) && (
        <QualityCard report={progress.quality} />
      )}

      <SceneList
        scenes={progress.scenes}
        assets={progress.assets}
        directions={directions}
        retrying={retrying}
        {...(p.status === "awaiting_render" && !rendering ? { onRetry: retryScene } : {})}
      />

      <div className="danger-zone">
        <button type="button" className="btn danger" onClick={remove} disabled={busy}>
          Delete project
        </button>
      </div>
    </section>
  );
}
