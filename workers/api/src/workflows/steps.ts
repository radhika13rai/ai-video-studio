import { NonRetryableError } from "cloudflare:workflows";
import { AgentError, type AgentResult } from "../agents";
import type { TextModel } from "../ai/text-model";
import {
  completeJob,
  createJob,
  failJob,
  getJob,
  recordUsage,
  startJob,
  type JsonObject,
} from "../db";

/** Retries for steps that call a model; the job's retry policy mirrors it exactly. */
export const AGENT_STEP_RETRIES = 2;
export function agentStepConfig(delay = "10 seconds") {
  return {
    retries: {
      limit: AGENT_STEP_RETRIES,
      delay: delay as `${number} seconds`,
      backoff: "exponential" as const,
    },
    timeout: "3 minutes" as const,
  };
}

/** A stable UUID derived from text, so a retried step reuses the same job row. */
export async function stableUuid(text: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // version 5-style
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const h = [...b.slice(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface StepContext {
  db: D1Database;
  userId: string;
  projectId: string;
  runId: string;
}

/**
 * Runs one agent as a tracked job. Safe to re-run when the workflow retries the step:
 * a completed job replays its saved output, an interrupted one counts as a failed attempt.
 * Errors a retry can't fix become NonRetryableError so the workflow stops immediately.
 */
export async function runAgentJob<T extends object>(
  ctx: StepContext,
  agent: string,
  jobType: string,
  model: TextModel | null,
  work: () => Promise<AgentResult<T>>,
  opts: { jobKey?: string; sceneId?: string } = {},
): Promise<T> {
  const { db, userId, projectId, runId } = ctx;
  const jobId = await stableUuid(`${runId}:${opts.jobKey ?? agent}`);
  let job =
    (await getJob(db, userId, jobId)) ??
    (await createJob(db, userId, projectId, {
      id: jobId,
      agent_name: agent,
      job_type: jobType,
      input: { workflow_run_id: runId },
      ...(opts.sceneId ? { scene_id: opts.sceneId } : {}),
      max_retries: AGENT_STEP_RETRIES,
    }));
  if (job.status === "completed") return (job.output?.result ?? {}) as T;
  if (job.status === "running") {
    job = await failJob(db, userId, jobId, "Attempt was interrupted.");
  }
  if (job.status !== "queued")
    throw new NonRetryableError(`${agent} job is ${job.status}; it can't run again in this run.`);

  await startJob(db, userId, jobId);
  try {
    const result = await work();
    await completeJob(db, userId, jobId, {
      result: result.output as unknown as JsonObject,
      meta: result.meta as unknown as JsonObject,
    });
    const tokens = (result.meta.usage?.input_tokens ?? 0) + (result.meta.usage?.output_tokens ?? 0);
    if (model && tokens > 0) {
      await recordUsage(db, userId, projectId, {
        provider_name: model.name.split(":")[0] ?? model.name,
        capability: "text",
        units_used: tokens,
        unit_type: "tokens",
      });
    }
    return result.output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fatal = err instanceof AgentError && !err.retryable;
    const failed = await failJob(db, userId, jobId, message, { final: fatal });
    if (fatal || !failed.will_retry) throw new NonRetryableError(message);
    throw err; // the workflow retries the step; the job is queued again
  }
}
