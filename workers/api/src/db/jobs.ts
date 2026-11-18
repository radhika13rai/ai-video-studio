import { JOB_RETRY_POLICY, JOB_STATUSES, type JobStatus } from "@avs/types";
import { z } from "zod";
import { invalidData, invalidState, notFound } from "./errors";
import { jsonObject, type JsonObject } from "./schemas";
import { fromJson, newId, nowIso, OWNED, toJson } from "./util";

interface JobRow {
  id: string;
  project_id: string;
  scene_id: string | null;
  agent_name: string;
  job_type: string;
  status: string;
  input_json: string;
  output_json: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Job extends Omit<JobRow, "status" | "input_json" | "output_json"> {
  status: JobStatus;
  input: JsonObject;
  output: JsonObject | null;
}

function toJob(r: JobRow): Job {
  const { input_json, output_json, ...rest } = r;
  return {
    ...rest,
    status: z.enum(JOB_STATUSES).parse(r.status),
    input: fromJson(jsonObject, input_json, "input_json"),
    output: output_json === null ? null : fromJson(jsonObject, output_json, "output_json"),
  };
}

const createJobSchema = z.object({
  /** Optional caller-chosen UUID, so a retried workflow step finds the same job. */
  id: z.uuid().optional(),
  agent_name: z.string().trim().min(1).max(100),
  job_type: z.string().trim().min(1).max(100),
  scene_id: z.string().nullish(),
  input: jsonObject.default({}),
  max_retries: z
    .number()
    .int()
    .min(0)
    .max(JOB_RETRY_POLICY.hardMaxRetries)
    .default(JOB_RETRY_POLICY.defaultMaxRetries),
});
export type CreateJobInput = z.input<typeof createJobSchema>;

export async function createJob(
  db: D1Database,
  userId: string,
  projectId: string,
  input: CreateJobInput,
): Promise<Job> {
  const parsed = createJobSchema.safeParse(input);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid job");
  const j = parsed.data;
  const id = j.id ?? newId();
  // The scene, if given, must belong to the same project.
  const res = await db
    .prepare(
      `INSERT INTO jobs (id, project_id, scene_id, agent_name, job_type, status, input_json,
         retry_count, max_retries, created_at)
       SELECT ?, p.id, ?, ?, ?, 'queued', ?, 0, ?, ? FROM projects p
       WHERE p.id = ? AND p.user_id = ?
         AND (? IS NULL OR EXISTS (SELECT 1 FROM scenes s WHERE s.id = ? AND s.project_id = p.id))`,
    )
    .bind(
      id,
      j.scene_id ?? null,
      j.agent_name,
      j.job_type,
      toJson(jsonObject, j.input, "input"),
      j.max_retries,
      nowIso(),
      projectId,
      userId,
      j.scene_id ?? null,
      j.scene_id ?? null,
    )
    .run();
  if (res.meta.changes === 0) throw notFound(j.scene_id ? "project or scene" : "project");
  return requireJob(db, userId, id);
}

export async function getJob(db: D1Database, userId: string, jobId: string): Promise<Job | null> {
  const row = await db
    .prepare(`SELECT * FROM jobs WHERE id = ? AND ${OWNED("project_id")}`)
    .bind(jobId, userId)
    .first<JobRow>();
  return row ? toJob(row) : null;
}

async function requireJob(db: D1Database, userId: string, jobId: string): Promise<Job> {
  const job = await getJob(db, userId, jobId);
  if (!job) throw notFound("job");
  return job;
}

export async function listJobs(db: D1Database, userId: string, projectId: string): Promise<Job[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM jobs WHERE project_id = ? AND ${OWNED("project_id")} ORDER BY created_at, id`,
    )
    .bind(projectId, userId)
    .all<JobRow>();
  return results.map(toJob);
}

/** Runs a guarded status transition; distinguishes "no such job" from "wrong state". */
async function transition(
  db: D1Database,
  userId: string,
  jobId: string,
  from: JobStatus[],
  sql: string,
  binds: unknown[],
): Promise<Job> {
  const res = await db
    .prepare(
      `UPDATE jobs SET ${sql} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")}) AND ${OWNED("project_id")}`,
    )
    .bind(...binds, jobId, ...from, userId)
    .run();
  if (res.meta.changes === 0) {
    const job = await requireJob(db, userId, jobId);
    throw invalidState(`job is ${job.status}; expected ${from.join(" or ")}`);
  }
  return requireJob(db, userId, jobId);
}

export const startJob = (db: D1Database, userId: string, jobId: string) =>
  transition(
    db,
    userId,
    jobId,
    ["queued"],
    "status = 'running', started_at = ?, error_message = NULL",
    [nowIso()],
  );

export const completeJob = (db: D1Database, userId: string, jobId: string, output: JsonObject) =>
  transition(
    db,
    userId,
    jobId,
    ["running"],
    "status = 'completed', output_json = ?, completed_at = ?",
    [toJson(jsonObject, output, "output"), nowIso()],
  );

export const cancelJob = (db: D1Database, userId: string, jobId: string) =>
  transition(db, userId, jobId, ["queued", "running"], "status = 'cancelled', completed_at = ?", [
    nowIso(),
  ]);

/**
 * Records a failed attempt. Applies the retry policy in one statement: if retries remain the job
 * returns to `queued` with retry_count + 1; otherwise it becomes `failed` for good.
 */
export async function failJob(
  db: D1Database,
  userId: string,
  jobId: string,
  errorMessage: string,
  opts: { final?: boolean } = {},
): Promise<Job & { will_retry: boolean }> {
  const now = nowIso();
  // `final` skips the retry policy for errors a retry can't fix (bad input, quota used up).
  const retry = opts.final ? "0" : "retry_count < max_retries";
  const job = await transition(
    db,
    userId,
    jobId,
    ["running"],
    `error_message = ?,
     status = CASE WHEN ${retry} THEN 'queued' ELSE 'failed' END,
     completed_at = CASE WHEN ${retry} THEN NULL ELSE ? END,
     retry_count = CASE WHEN ${retry} THEN retry_count + 1 ELSE retry_count END`,
    [errorMessage.slice(0, 2000), now],
  );
  return { ...job, will_retry: job.status === "queued" };
}

/** Cancels every queued or running job of a project (used when production is cancelled). */
export async function cancelOpenJobs(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'cancelled', completed_at = ?
       WHERE project_id = ? AND status IN ('queued', 'running') AND ${OWNED("project_id")}`,
    )
    .bind(nowIso(), projectId, userId)
    .run();
  return res.meta.changes;
}


/** Cancels only jobs belonging to one workflow run, never a newer run's jobs. */
export async function cancelOpenJobsForRun(
  db: D1Database,
  userId: string,
  projectId: string,
  runId: string,
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'cancelled', completed_at = ?
       WHERE project_id = ? AND status IN ('queued', 'running')
         AND json_extract(input_json, '$.workflow_run_id') = ?
         AND ${OWNED("project_id")}`,
    )
    .bind(nowIso(), projectId, runId, userId)
    .run();
  return res.meta.changes;
}