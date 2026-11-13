import type { Project } from "@avs/contracts";
import type { ProjectStatus } from "@avs/types";
import { useEffect, useState } from "react";
import { EmptyState, ErrorBox, Skeleton } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";
import {
  isActive,
  PLATFORM_LABELS,
  STATUS_DISPLAY,
  timeAgo,
  VIDEO_TYPE_LABELS,
} from "../lib/format";
import { Link } from "../lib/router";
import { listProjects } from "../services/api";

const FILTERS: (ProjectStatus | null)[] = [
  null,
  "created",
  "planning",
  "generating",
  "completed",
  "failed",
];

export function ProjectCard({ project }: { project: Project }) {
  return (
    <Link href={`/projects/${project.id}`} className="card project-card">
      <div className={`thumb ratio-${project.aspect_ratio.replace(":", "x")}`} aria-hidden="true">
        <span>{project.aspect_ratio}</span>
      </div>
      <div className="project-body">
        <div className="project-head">
          <h3>{project.title}</h3>
          <StatusBadge status={project.status} />
        </div>
        <p className="prompt">{project.prompt}</p>
        <p className="meta">
          {VIDEO_TYPE_LABELS[project.video_type]} · {project.duration_seconds}s ·{" "}
          {PLATFORM_LABELS[project.target_platform]} · {timeAgo(project.created_at)}
        </p>
      </div>
    </Link>
  );
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: Project[]; cursor: string | null; loadingMore: boolean };

export function ProjectsPage() {
  const [filter, setFilter] = useState<ProjectStatus | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  // Changing the filter or retrying shows the skeleton, then the effect below loads.
  const changeFilter = (f: ProjectStatus | null) => {
    if (f === filter) return;
    setState({ kind: "loading" });
    setFilter(f);
  };
  const retry = () => {
    setState({ kind: "loading" });
    setReloadKey((k) => k + 1);
  };

  useEffect(() => {
    const ctrl = new AbortController();
    listProjects({ status: filter }, ctrl.signal).then(
      (page) =>
        setState({
          kind: "ready",
          items: page.items,
          cursor: page.next_cursor,
          loadingMore: false,
        }),
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not load projects.",
        });
      },
    );
    return () => ctrl.abort();
  }, [filter, reloadKey]);

  // Refresh quietly while any visible project is in production.
  const anyActive = state.kind === "ready" && state.items.some((p) => isActive(p.status));
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => {
      listProjects({ status: filter }).then(
        (page) => {
          const fresh = new Map(page.items.map((p) => [p.id, p]));
          setState((cur) =>
            cur.kind === "ready"
              ? { ...cur, items: cur.items.map((p) => fresh.get(p.id) ?? p) }
              : cur,
          );
        },
        () => undefined,
      );
    }, 5000);
    return () => clearInterval(t);
  }, [anyActive, filter]);

  const loadMore = () => {
    if (state.kind !== "ready" || !state.cursor) return;
    const cur = state;
    setState({ ...cur, loadingMore: true });
    listProjects({ status: filter, cursor: cur.cursor }).then(
      (page) =>
        setState({
          kind: "ready",
          items: [...cur.items, ...page.items],
          cursor: page.next_cursor,
          loadingMore: false,
        }),
      (e: unknown) =>
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not load more.",
        }),
    );
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Your projects</h1>
          <p className="muted">Each project turns one prompt into a finished short video.</p>
        </div>
      </div>

      <div className="chips" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f ?? "all"}
            type="button"
            className={`chip${filter === f ? " active" : ""}`}
            aria-pressed={filter === f}
            onClick={() => changeFilter(f)}
          >
            {f ? STATUS_DISPLAY[f].label : "All"}
          </button>
        ))}
      </div>

      {state.kind === "loading" && <Skeleton />}
      {state.kind === "error" && <ErrorBox message={state.message} onRetry={retry} />}
      {state.kind === "ready" &&
        state.items.length === 0 &&
        (filter ? (
          <EmptyState title={`No ${STATUS_DISPLAY[filter].label.toLowerCase()} projects`}>
            <button type="button" className="btn" onClick={() => changeFilter(null)}>
              Show all projects
            </button>
          </EmptyState>
        ) : (
          <EmptyState title="No projects yet">
            <p className="muted">Describe the video you want and the studio plans it for you.</p>
            <Link href="/projects/new" className="btn primary">
              Create your first video
            </Link>
          </EmptyState>
        ))}
      {state.kind === "ready" && state.items.length > 0 && (
        <>
          <div className="grid">
            {state.items.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
          {state.cursor && (
            <div className="center">
              <button type="button" className="btn" onClick={loadMore} disabled={state.loadingMore}>
                {state.loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
