import type { Asset, Job, Project, Scene, WorkflowRun } from "@avs/contracts";
import { assetUrl } from "../services/api";
import type { ProjectStatus } from "@avs/types";

type StepState = "done" | "active" | "pending" | "failed" | "skipped";

const ORDER: ProjectStatus[] = [
  "planning",
  "generating",
  "awaiting_render",
  "rendering",
  "quality_check",
  "completed",
];
const rank = (s: ProjectStatus) => ORDER.indexOf(s);

/** Works out each pipeline step's state from the project status and the agent jobs. */
export function pipelineSteps(project: Project, jobs: Job[], run: WorkflowRun | null) {
  const job = (agent: string) => jobs.find((j) => j.agent_name === agent);
  const failed = project.status === "failed";
  const stopped = project.status === "failed" || project.status === "cancelled";
  const fromJob = (agent: string): StepState => {
    const j = job(agent);
    if (!j) return "pending";
    if (j.status === "completed") return "done";
    if (j.status === "running" || j.status === "queued") return stopped ? "skipped" : "active";
    if (j.status === "failed") return "failed";
    return "skipped";
  };
  const fromStage = (stage: ProjectStatus): StepState => {
    const cur = rank(project.status);
    const at = rank(stage);
    if (cur < 0) {
      if (failed && run?.current_step && stageForStep(run.current_step) === stage) return "failed";
      return "pending";
    }
    if (cur > at) return "done";
    if (cur === at) return project.status === "completed" ? "done" : "active";
    return "pending";
  };
  return [
    {
      key: "director",
      label: "Plan the video",
      detail: "Picks the format, scenes and tone",
      state: fromJob("director"),
    },
    {
      key: "scriptwriter",
      label: "Write the script",
      detail: "Narration with a hook",
      state: fromJob("scriptwriter"),
    },
    {
      key: "storyboard",
      label: "Storyboard",
      detail: "Scenes with visual prompts",
      state: fromJob("storyboard"),
    },
    {
      key: "generating",
      label: "Images, video & voice",
      detail: "Media for each scene",
      state: fromStage("generating"),
    },
    {
      key: "render",
      label: "Render in your browser",
      detail: "Assembles the final video",
      state: fromStage("awaiting_render"),
    },
    {
      key: "quality",
      label: "Quality check",
      detail: "Final checks",
      state: fromStage("quality_check"),
    },
  ] satisfies { key: string; label: string; detail: string; state: StepState }[];
}

function stageForStep(step: string): ProjectStatus | null {
  if (step === "generate-assets") return "generating";
  if (step === "request-render" || step === "awaiting-render") return "awaiting_render";
  if (step === "quality-check") return "quality_check";
  return null;
}

const ICON: Record<StepState, string> = {
  done: "✓",
  active: "",
  pending: "",
  failed: "!",
  skipped: "–",
};

export function PipelineSteps({ steps }: { steps: ReturnType<typeof pipelineSteps> }) {
  return (
    <ol className="steps" aria-label="Production steps">
      {steps.map((s, i) => (
        <li key={s.key} className={`step state-${s.state}`} data-state={s.state}>
          <span className="step-num" aria-hidden="true">
            {ICON[s.state] || i + 1}
          </span>
          <span>
            <span className="step-label">{s.label}</span>
            <span className="sr-only"> ({s.state})</span>
            <small className="step-detail">{s.detail}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function SceneList({ scenes, assets = [] }: { scenes: Scene[]; assets?: Asset[] }) {
  const forScene = (id: string, type: Asset["asset_type"]) =>
    assets.find((a) => a.scene_id === id && a.asset_type === type);
  if (scenes.length === 0) return null;
  const total = scenes.reduce((n, s) => n + s.duration_seconds, 0);
  return (
    <div className="card">
      <h2>
        Storyboard{" "}
        <span className="muted small-inline">
          · {scenes.length} scenes · {Math.round(total)}s
        </span>
      </h2>
      <ol className="scenes">
        {scenes.map((s) => (
          <li key={s.id} className="scene">
            {(() => {
              const image = forScene(s.id, "image");
              return image ? (
                <img
                  className="scene-image"
                  src={assetUrl(image.project_id, image.id)}
                  alt={s.visual_prompt ?? `Scene ${s.scene_number}`}
                  loading="lazy"
                />
              ) : (
                <div className="scene-image placeholder" aria-hidden="true">
                  {s.visual_type === "text" ? "Text card" : "No image yet"}
                </div>
              );
            })()}
            <div className="scene-body">
              <div className="scene-head">
                <strong>Scene {s.scene_number}</strong>
                <span className="muted">
                  {s.duration_seconds}s · {s.visual_type}
                </span>
              </div>
              {s.voiceover && <p className="voiceover">“{s.voiceover}”</p>}
              {s.visual_prompt && <p className="visual muted">🎨 {s.visual_prompt}</p>}
              {(() => {
                const voice = forScene(s.id, "voiceover");
                return voice ? (
                  <audio
                    className="scene-audio"
                    controls
                    preload="none"
                    src={assetUrl(voice.project_id, voice.id)}
                    aria-label={`Narration for scene ${s.scene_number}`}
                  />
                ) : null;
              })()}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
