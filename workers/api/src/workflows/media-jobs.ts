import type { WorkflowSleepDuration } from "cloudflare:workers";
import type { Env } from "../env";
import { pollMediaJob, startMediaJob, type Owner } from "../providers/jobs";
import { codeProviders, NoProviderError } from "../providers/registry";
import type { MediaRequest, MediaResult } from "../providers/types";

/**
 * Runs one piece of long-running media work inside a Workflow (ADR 040): submit as a durable
 * step, wait with step.sleep (no Worker time is used while waiting), poll as a step, and on a
 * failed or timed-out job try the next provider. Step names are derived from `name`, the attempt
 * and the poll number, so a replay takes the same path. Polls are capped, so a slow provider
 * can't use up the workflow's step budget.
 */

/** The parts of WorkflowStep this helper uses (a fake can stand in for it in tests). */
export interface JobSteps {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: WorkflowSleepDuration): Promise<void>;
}

export const MAX_JOB_ATTEMPTS = 3;
export const MAX_POLLS_PER_ATTEMPT = 30;

export type JobOutcome =
  | { status: "ok"; provider: string; result_key: string; job_id: string }
  | { status: "fallback"; reason: string };

export async function runMediaJob(
  step: JobSteps,
  ctx: { db: D1Database; env: Env; owner: Owner },
  name: string,
  /** The request, or a builder run inside the submit step (e.g. to read an image from R2). */
  request: MediaRequest | (() => Promise<MediaRequest>),
  /** Stores the finished media (e.g. in R2) and returns its storage key. */
  store: (result: MediaResult, jobId: string) => Promise<string>,
): Promise<JobOutcome> {
  const tried: string[] = [];
  let lastReason = "no provider could make it";
  for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
    const started = await step.do(`${name}-submit-${attempt}`, async () => {
      try {
        const job = await startMediaJob(
          ctx.db,
          ctx.env,
          ctx.owner,
          `${name}:${attempt}`,
          typeof request === "function" ? await request() : request,
          new Set(tried),
        );
        return { ok: true as const, job_id: job.id, provider: job.provider_name };
      } catch (err) {
        if (err instanceof NoProviderError && !err.retryable)
          return { ok: false as const, reason: err.message };
        throw err; // transient: the step's own retries handle it
      }
    });
    if (!started.ok) {
      lastReason = started.reason;
      break;
    }
    const provider = codeProviders(ctx.env).find((p) => p.name === started.provider);
    const interval =
      provider?.mode === "async"
        ? Math.max(
            provider.pollIntervalSeconds,
            Math.ceil(provider.maxWaitSeconds / MAX_POLLS_PER_ATTEMPT),
          )
        : 15;

    for (let poll = 1; poll <= MAX_POLLS_PER_ATTEMPT + 1; poll++) {
      await step.sleep(`${name}-wait-${attempt}-${poll}`, `${interval} seconds`);
      const progress = await step.do(`${name}-poll-${attempt}-${poll}`, async () => {
        const p = await pollMediaJob(ctx.db, ctx.env, ctx.owner, started.job_id, (result, job) =>
          store(result, job.id),
        );
        return {
          status: p.status,
          result_key: p.job.result_key,
          error: p.job.error_message,
        };
      });
      if (progress.status === "running") continue;
      if (progress.status === "succeeded" && progress.result_key)
        return {
          status: "ok",
          provider: started.provider,
          result_key: progress.result_key,
          job_id: started.job_id,
        };
      lastReason = `${started.provider}: ${progress.error ?? progress.status}`;
      break;
    }
    tried.push(started.provider);
  }
  return { status: "fallback", reason: lastReason };
}
