import {
  createProviderJob,
  getProviderJob,
  getProviderJobByKey,
  newId,
  recordProviderSuccess,
  recordUsage,
  releaseJobUsage,
  reservePaidSpend,
  settleJobUsage,
  TERMINAL_JOB_STATUSES,
  updateProviderJob,
  type ProviderJob,
} from "../db";
import type { Env } from "../env";
import { paidSettings, startOfUtcDay } from "./policy";
import { codeProviders, noteFailure, NoProviderError, routeFor, type Attempt } from "./registry";
import {
  ProviderError,
  withTimeout,
  type AsyncMediaProvider,
  type MediaRequest,
  type MediaResult,
} from "./types";

/**
 * Long-running provider work (ADR 040): submit once, then poll until the job succeeds, fails or
 * passes its deadline. Each function is one short, idempotent unit, so a Workflow step can run
 * it and retry it safely; waiting between polls is the workflow's job (step.sleep).
 */

export interface Owner {
  userId: string;
  projectId: string;
}

/**
 * Submits `request` to the best async provider not in `exclude`, as job `jobKey`. Returns the
 * existing job if this key was already submitted (a retried step). Throws NoProviderError when
 * no provider can take it.
 */
export async function startMediaJob(
  db: D1Database,
  env: Env,
  owner: Owner,
  jobKey: string,
  request: MediaRequest,
  exclude: ReadonlySet<string> = new Set(),
): Promise<ProviderJob> {
  const existing = await getProviderJobByKey(db, owner.userId, owner.projectId, jobKey);
  if (existing) return existing;

  const plan = await routeFor(db, env, owner.userId, request, { mode: "async", exclude });
  const attempts: Attempt[] = plan.skipped
    .filter((s) => s.reason !== "wrong_mode")
    .map((s) => ({ provider: s.provider, outcome: "skipped", detail: s.detail }));
  let retryable = false;
  const budget = paidSettings(env);

  for (const { provider: p, estimated_cost_usd } of plan.candidates) {
    const provider = p as AsyncMediaProvider;
    const jobId = newId();
    if (provider.tier === "paid") {
      const reserved = await reservePaidSpend(
        db,
        owner.userId,
        owner.projectId,
        {
          provider_name: provider.name,
          capability: provider.capability,
          unit_type: provider.cost.unit,
          estimated_cost_usd,
          job_id: jobId,
        },
        {
          daily_usd: budget.daily_usd,
          user_daily_usd: budget.user_daily_usd,
          since: startOfUtcDay(),
        },
      );
      if (!reserved) {
        attempts.push({ provider: provider.name, outcome: "over_budget" });
        continue;
      }
    }
    try {
      const { external_id } = await withTimeout(provider.name, provider.timeoutMs, (signal) =>
        provider.submit(request as never, signal),
      );
      return await createProviderJob(db, owner.userId, owner.projectId, {
        id: jobId,
        provider_name: provider.name,
        capability: provider.capability,
        job_key: jobKey,
        external_id,
        estimated_cost_usd,
        deadline_at: new Date(Date.now() + provider.maxWaitSeconds * 1000).toISOString(),
      });
    } catch (err) {
      await releaseJobUsage(db, jobId);
      if (!(err instanceof ProviderError)) throw err;
      attempts.push({
        provider: provider.name,
        outcome: err.kind === "quota" ? "quota" : err.kind === "timeout" ? "timeout" : "failed",
        detail: err.message,
      });
      if (err.kind !== "quota" && err.kind !== "unsupported") retryable ||= err.retryable;
      await noteFailure(db, provider, err);
    }
  }
  throw new NoProviderError(request.capability, attempts, retryable);
}

export type JobProgress =
  | { status: "running"; job: ProviderJob }
  | { status: "succeeded"; job: ProviderJob; result: MediaResult }
  | { status: "failed" | "timed_out" | "cancelled"; job: ProviderJob };

/**
 * Polls a job once. On success `onResult` stores the media (e.g. in R2) and returns its key;
 * usage and the actual cost are recorded. Past its deadline the job is timed out. A failed poll
 * call (network, timeout) leaves the job running unless the deadline has passed.
 */
export async function pollMediaJob(
  db: D1Database,
  env: Env,
  owner: Owner,
  jobId: string,
  onResult: (result: MediaResult, job: ProviderJob) => Promise<string>,
  now = new Date(),
): Promise<JobProgress> {
  const job = await getProviderJob(db, owner.userId, jobId);
  if (!job || job.project_id !== owner.projectId) throw new Error("provider job not found");
  if (TERMINAL_JOB_STATUSES.includes(job.status))
    return { status: job.status as "failed" | "timed_out" | "cancelled", job };
  const provider = codeProviders(env).find(
    (p): p is AsyncMediaProvider => p.name === job.provider_name && p.mode === "async",
  );
  const expired = new Date(job.deadline_at) <= now;
  if (!provider || expired) {
    const message = provider
      ? `no result after ${Math.round(provider.maxWaitSeconds / 60)} min`
      : "provider is no longer available";
    const done = await updateProviderJob(db, owner.userId, job.id, {
      status: "timed_out",
      error_message: message,
    });
    await releaseJobUsage(db, job.id);
    if (provider)
      await noteFailure(db, provider, new ProviderError(provider.name, message, "timeout", true));
    return { status: "timed_out", job: done };
  }

  let answer;
  try {
    answer = await withTimeout(provider.name, provider.timeoutMs, (signal) =>
      provider.poll(job.external_id ?? "", signal),
    );
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    // One bad poll isn't a failed job; try again next time (the deadline still applies).
    return {
      status: "running",
      job: await updateProviderJob(db, owner.userId, job.id, { status: "running", polled: true }),
    };
  }

  if (answer.status === "running")
    return {
      status: "running",
      job: await updateProviderJob(db, owner.userId, job.id, { status: "running", polled: true }),
    };

  if (answer.status === "failed") {
    const done = await updateProviderJob(db, owner.userId, job.id, {
      status: "failed",
      polled: true,
      error_message: answer.message,
    });
    await releaseJobUsage(db, job.id);
    await noteFailure(
      db,
      provider,
      new ProviderError(provider.name, answer.message, "unavailable", answer.retryable),
    );
    return { status: "failed", job: done };
  }

  const result = answer.result;
  const key = await onResult(result, job);
  const done = await updateProviderJob(db, owner.userId, job.id, {
    status: "succeeded",
    polled: true,
    result_key: key,
    actual_cost_usd: result.actual_cost_usd ?? null,
  });
  if (provider.tier === "paid")
    await settleJobUsage(db, job.id, {
      units_used: result.units,
      actual_cost_usd: result.actual_cost_usd ?? null,
    });
  else
    await recordUsage(db, owner.userId, owner.projectId, {
      provider_name: provider.name,
      capability: provider.capability,
      units_used: result.units,
      unit_type: result.unit_type,
      estimated_cost_usd: job.estimated_cost_usd,
      actual_cost_usd: result.actual_cost_usd ?? null,
      tier: provider.tier,
      job_id: job.id,
    });
  await recordProviderSuccess(db, provider.name, provider.capability);
  return { status: "succeeded", job: done, result };
}
