import { PROVIDER_JOB_STATUSES, type ProviderCapability, type ProviderJobStatus } from "@avs/types";
import { z } from "zod";
import { invalidData, notFound } from "./errors";
import { newId, nowIso, OWNED } from "./util";

/** Long-running provider work (submit, then poll), one row per attempt (ADR 040). */
export interface ProviderJob {
  id: string;
  user_id: string;
  project_id: string;
  provider_name: string;
  capability: ProviderCapability;
  job_key: string;
  external_id: string | null;
  status: ProviderJobStatus;
  polls: number;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  result_key: string | null;
  error_message: string | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
}

export const TERMINAL_JOB_STATUSES: readonly ProviderJobStatus[] = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
];

const createSchema = z.object({
  provider_name: z.string().min(1).max(64),
  capability: z.string().min(1).max(32),
  job_key: z.string().min(1).max(200),
  external_id: z.string().min(1).max(500),
  estimated_cost_usd: z.number().nonnegative().finite(),
  deadline_at: z.iso.datetime(),
});

/** Records a submitted job for a project the user owns. Idempotent on (project, job_key). */
export async function createProviderJob(
  db: D1Database,
  userId: string,
  projectId: string,
  input: z.input<typeof createSchema> & { capability: ProviderCapability; id?: string },
): Promise<ProviderJob> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid job");
  const j = parsed.data;
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO provider_jobs (id, user_id, project_id, provider_name, capability, job_key,
         external_id, status, estimated_cost_usd, deadline_at, created_at, updated_at)
       SELECT ?, user_id, id, ?, ?, ?, ?, 'submitted', ?, ?, ?, ? FROM projects
       WHERE id = ? AND user_id = ?
       ON CONFLICT(project_id, job_key) DO NOTHING`,
    )
    .bind(
      input.id ?? newId(),
      j.provider_name,
      j.capability,
      j.job_key,
      j.external_id,
      j.estimated_cost_usd,
      j.deadline_at,
      now,
      now,
      projectId,
      userId,
    )
    .run();
  const job = await getProviderJobByKey(db, userId, projectId, j.job_key);
  if (!job) throw notFound("project");
  return job;
}

export async function getProviderJobByKey(
  db: D1Database,
  userId: string,
  projectId: string,
  jobKey: string,
): Promise<ProviderJob | null> {
  return db
    .prepare(
      `SELECT * FROM provider_jobs WHERE project_id = ? AND job_key = ? AND ${OWNED("project_id")}`,
    )
    .bind(projectId, jobKey, userId)
    .first<ProviderJob>();
}

export async function getProviderJob(
  db: D1Database,
  userId: string,
  jobId: string,
): Promise<ProviderJob | null> {
  return db
    .prepare(`SELECT * FROM provider_jobs WHERE id = ? AND ${OWNED("project_id")}`)
    .bind(jobId, userId)
    .first<ProviderJob>();
}

/**
 * Moves a job on. Terminal jobs never change again (the WHERE clause), so a late or repeated
 * poll can't overwrite a result. Returns the job as it is afterwards.
 */
export async function updateProviderJob(
  db: D1Database,
  userId: string,
  jobId: string,
  patch: {
    status: ProviderJobStatus;
    polled?: boolean;
    actual_cost_usd?: number | null;
    result_key?: string | null;
    error_message?: string | null;
  },
): Promise<ProviderJob> {
  if (!(PROVIDER_JOB_STATUSES as readonly string[]).includes(patch.status))
    throw invalidData("job status is not valid");
  await db
    .prepare(
      `UPDATE provider_jobs SET status = ?, polls = polls + ?,
         actual_cost_usd = COALESCE(?, actual_cost_usd), result_key = COALESCE(?, result_key),
         error_message = COALESCE(?, error_message), updated_at = ?
       WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled')
         AND ${OWNED("project_id")}`,
    )
    .bind(
      patch.status,
      patch.polled ? 1 : 0,
      patch.actual_cost_usd ?? null,
      patch.result_key ?? null,
      patch.error_message?.slice(0, 500) ?? null,
      nowIso(),
      jobId,
      userId,
    )
    .run();
  const job = await getProviderJob(db, userId, jobId);
  if (!job) throw notFound("provider job");
  return job;
}

export async function listProviderJobs(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<ProviderJob[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM provider_jobs WHERE project_id = ? AND ${OWNED("project_id")}
       ORDER BY created_at, id`,
    )
    .bind(projectId, userId)
    .all<ProviderJob>();
  return results;
}
