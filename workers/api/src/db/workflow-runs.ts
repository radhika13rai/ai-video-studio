import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from "@avs/types";
import { z } from "zod";
import { invalidData, invalidState, notFound } from "./errors";
import { newId, nowIso, OWNED } from "./util";

export interface WorkflowRun {
  id: string;
  project_id: string;
  workflow_name: string;
  workflow_instance_id: string | null;
  current_step: string | null;
  status: WorkflowRunStatus;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const TERMINAL: WorkflowRunStatus[] = ["completed", "failed", "cancelled"];

/**
 * Atomically terminates a run and its project only if that run is still the latest active run.
 * A late cancellation/failure from an older workflow cannot change a newer run's state.
 */
export async function terminateWorkflowRunIfLatest(
  db: D1Database,
  userId: string,
  projectId: string,
  runId: string,
  status: "failed" | "cancelled",
  projectStatuses: readonly import("@avs/types").ProjectStatus[],
  errorMessage: string,
): Promise<boolean> {
  const now = nowIso();
  const slots = projectStatuses.map(() => "?").join(", ");
  const [runUpdate, projectUpdate] = await db.batch([
    db
      .prepare(
        `UPDATE workflow_runs
         SET status = ?, error_message = ?, completed_at = ?
         WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'waiting')
           AND id = (
             SELECT id FROM workflow_runs
             WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
           )
           AND EXISTS (
             SELECT 1 FROM projects p
             WHERE p.id = ? AND p.user_id = ? AND p.status IN (${slots})
           )`,
      )
      .bind(status, errorMessage.slice(0, 500), now, runId, projectId, projectId, projectId, userId, ...projectStatuses),
    db
      .prepare(
        `UPDATE projects SET status = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status IN (${slots})
           AND EXISTS (
             SELECT 1 FROM workflow_runs wr
             WHERE wr.id = ? AND wr.project_id = projects.id AND wr.status = ?
           )
           AND (
             SELECT id FROM workflow_runs
             WHERE project_id = projects.id ORDER BY created_at DESC, id DESC LIMIT 1
           ) = ?`,
      )
      .bind(status, now, projectId, userId, ...projectStatuses, runId, status, runId),
  ]);
  return runUpdate.meta.changes === 1 && projectUpdate.meta.changes === 1;
}

export async function createWorkflowRun(
  db: D1Database,
  userId: string,
  projectId: string,
  input: { id?: string; workflow_name: string; workflow_instance_id?: string | null },
): Promise<WorkflowRun> {
  if (!input.workflow_name.trim()) throw invalidData("workflow_name is required");
  const id = input.id ?? newId();
  const now = nowIso();
  const res = await db
    .prepare(
      `INSERT INTO workflow_runs (id, project_id, workflow_name, workflow_instance_id, status,
         started_at, created_at)
       SELECT ?, id, ?, ?, 'running', ?, ? FROM projects WHERE id = ? AND user_id = ?`,
    )
    .bind(id, input.workflow_name, input.workflow_instance_id ?? null, now, now, projectId, userId)
    .run();
  if (res.meta.changes === 0) throw notFound("project");
  const run = await getWorkflowRun(db, userId, id);
  if (!run) throw new Error("workflow run insert failed");
  return run;
}

export async function getWorkflowRun(
  db: D1Database,
  userId: string,
  runId: string,
): Promise<WorkflowRun | null> {
  return db
    .prepare(`SELECT * FROM workflow_runs WHERE id = ? AND ${OWNED("project_id")}`)
    .bind(runId, userId)
    .first<WorkflowRun>();
}

export async function getLatestWorkflowRun(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<WorkflowRun | null> {
  return db
    .prepare(
      `SELECT * FROM workflow_runs WHERE project_id = ? AND ${OWNED("project_id")}
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(projectId, userId)
    .first<WorkflowRun>();
}

/** Updates step and/or status. Terminal runs can't be changed; completed_at is set on entry. */
export async function updateWorkflowRun(
  db: D1Database,
  userId: string,
  runId: string,
  patch: { status?: WorkflowRunStatus; current_step?: string; error_message?: string | null },
): Promise<WorkflowRun> {
  if (patch.status && !z.enum(WORKFLOW_RUN_STATUSES).safeParse(patch.status).success)
    throw invalidData("workflow status is not valid");
  const now = nowIso();
  const res = await db
    .prepare(
      `UPDATE workflow_runs SET
         status = COALESCE(?, status),
         current_step = COALESCE(?, current_step),
         error_message = CASE WHEN ? THEN ? ELSE error_message END,
         completed_at = CASE WHEN COALESCE(?, status) IN ('completed','failed','cancelled')
                             THEN ? ELSE completed_at END
       WHERE id = ? AND status NOT IN (${TERMINAL.map(() => "?").join(", ")}) AND ${OWNED("project_id")}`,
    )
    .bind(
      patch.status ?? null,
      patch.current_step ?? null,
      patch.error_message !== undefined ? 1 : 0,
      patch.error_message ?? null,
      patch.status ?? null,
      now,
      runId,
      ...TERMINAL,
      userId,
    )
    .run();
  if (res.meta.changes === 0) {
    const run = await getWorkflowRun(db, userId, runId);
    if (!run) throw notFound("workflow run");
    throw invalidState(`workflow run is already ${run.status}`);
  }
  const run = await getWorkflowRun(db, userId, runId);
  if (!run) throw notFound("workflow run");
  return run;
}
