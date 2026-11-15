import { API_PATHS } from "@avs/contracts";
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  getProviderJob,
  listProvidersForCapability,
  listProviderJobs,
  type Provider,
} from "../src/db";
import { sniffMedia } from "../src/providers/media-bytes";
import { pollMediaJob, startMediaJob } from "../src/providers/jobs";
import { nextUtcMidnight, paidSettings, planRoute } from "../src/providers/policy";
import {
  generateMedia,
  NoProviderError,
  setMediaProvidersOverride,
} from "../src/providers/registry";
import {
  estimateCostUsd,
  httpError,
  ProviderError,
  unsupportedReason,
  withTimeout,
  type AsyncMediaProvider,
  type MediaRequest,
  type MediaResult,
  type PollResult,
  type SyncMediaProvider,
} from "../src/providers/types";
import { runMediaJob, type JobSteps } from "../src/workflows/media-jobs";
import { db, fakeFacts, makeProject, makeUser } from "./helpers";

afterEach(() => setMediaProvidersOverride(null));

const PNG = (() => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  new DataView(b.buffer).setUint32(16, 64);
  new DataView(b.buffer).setUint32(20, 64);
  return b;
})();
const media = (over: Partial<MediaResult> = {}): MediaResult => ({
  bytes: PNG,
  model: "fake",
  units: 1,
  unit_type: "x",
  ...sniffMedia(PNG)!,
  ...over,
});

const uniq = (base: string) => `${base}-${crypto.randomUUID().slice(0, 8)}`;

type Behaviour = (req: MediaRequest) => Promise<MediaResult> | MediaResult | Error;

function syncFake(
  base: string,
  behaviour: Behaviour = () => media(),
  over: Partial<SyncMediaProvider> = {},
): SyncMediaProvider & { calls: number } {
  const p = {
    ...fakeFacts(),
    name: uniq(base),
    capability: "image" as const,
    defaultPriority: 10,
    defaultDailyLimit: 100,
    calls: 0,
    ...over,
    async generate(req: MediaRequest) {
      p.calls++;
      const r = await behaviour(req);
      if (r instanceof Error) throw r;
      return r;
    },
  } as SyncMediaProvider & { calls: number };
  return p;
}

const owner = async () => {
  const u = await makeUser();
  const p = await makeProject(u.id);
  return { userId: u.id, projectId: p.id };
};
const image: MediaRequest = { capability: "image", prompt: "x", aspect_ratio: "9:16" };
const video: MediaRequest = {
  capability: "video",
  prompt: "x",
  aspect_ratio: "9:16",
  duration_seconds: 5,
};
const withEnv = (extra: Record<string, string>) => ({ ...env, ...extra }) as typeof env;

/** Paid generation on, with `headroom` dollars left today whatever earlier tests spent. */
async function paidOn(headroom = 1): Promise<typeof env> {
  const spent = await db()
    .prepare(
      "SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS s FROM usage_events WHERE tier = 'paid' AND created_at >= ?",
    )
    .bind(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
    .first<{ s: number }>();
  return withEnv({
    PAID_PROVIDERS: "on",
    PAID_DAILY_BUDGET_USD: String((spent?.s ?? 0) + headroom),
    FAKE_KEY: "k",
  });
}

const row = (name: string, over: Partial<Provider> = {}): Provider => ({
  id: name,
  provider_name: name,
  capability: "image",
  enabled: true,
  priority: 10,
  health_status: "unknown",
  quota: { daily_limit: 10 },
  consecutive_failures: 0,
  cooldown_until: null,
  last_error: null,
  updated_at: "",
  ...over,
});

describe("provider facts", () => {
  it("estimates cost from the provider's cost model", () => {
    const perSecond = { cost: { unit: "second" as const, usd_per_unit: 0.05, source: "t" } };
    expect(estimateCostUsd(perSecond, video)).toBe(0.25);
    const perChars = { cost: { unit: "1k_chars" as const, usd_per_unit: 0.03, source: "t" } };
    expect(estimateCostUsd(perChars, { capability: "voice", text: "a".repeat(2000) })).toBe(0.06);
    const perImage = { cost: { unit: "image" as const, usd_per_unit: 0.000634, source: "t" } };
    expect(estimateCostUsd(perImage, image)).toBe(0.000634);
  });

  it("checks capability and limits before a call", () => {
    const p = {
      capability: "video" as const,
      limits: { aspect_ratios: ["16:9"] as const, max_duration_seconds: 4 },
    };
    expect(unsupportedReason(p, image)).toBe("doesn't make image");
    expect(unsupportedReason(p, video)).toBe("doesn't support 9:16");
    expect(unsupportedReason(p, { ...video, aspect_ratio: "16:9" })).toBe("clips are at most 4 s");
    expect(unsupportedReason(p, { ...video, aspect_ratio: "16:9", duration_seconds: 4 })).toBe(
      null,
    );
  });

  it("times out slow calls and aborts them", async () => {
    let aborted = false;
    const slow = withTimeout("slow", 20, (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return new Promise(() => undefined);
    });
    await expect(slow).rejects.toMatchObject({ kind: "timeout", retryable: true });
    expect(aborted).toBe(true);
  });

  it("maps vendor HTTP errors", () => {
    expect(httpError("p", 401)).toMatchObject({ kind: "auth", retryable: false });
    expect(httpError("p", 429)).toMatchObject({ kind: "quota", retryable: false });
    expect(httpError("p", 422)).toMatchObject({ kind: "bad_response", retryable: false });
    expect(httpError("p", 503)).toMatchObject({ kind: "unavailable", retryable: true });
  });

  it("keeps paid generation off unless switched on with a budget", () => {
    expect(paidSettings(env).enabled).toBe(false);
    expect(paidSettings(withEnv({ PAID_PROVIDERS: "on" })).enabled).toBe(false); // no budget
    expect(
      paidSettings(
        withEnv({
          PAID_PROVIDERS: "on",
          PAID_DAILY_BUDGET_USD: "2",
          PAID_USER_DAILY_BUDGET_USD: "5",
        }),
      ),
    ).toEqual({ enabled: true, daily_usd: 2, user_daily_usd: 2 });
  });
});

describe("route planning", () => {
  const plan = (
    providers: SyncMediaProvider[],
    rows: Provider[],
    over: Partial<Parameters<typeof planRoute>[0]> = {},
  ) =>
    planRoute({
      request: image,
      providers,
      rows,
      usedToday: new Map(),
      spend: { total_usd: 0, user_usd: 0 },
      paid: { enabled: false, daily_usd: 0, user_daily_usd: 0 },
      hasCredential: () => true,
      now: new Date("2026-11-15T12:00:00Z"),
      ...over,
    });

  it("never uses a provider for a capability it doesn't declare", () => {
    const img = syncFake("img");
    const r = planRoute({
      request: video,
      providers: [img],
      rows: [row(img.name)],
      usedToday: new Map(),
      spend: { total_usd: 0, user_usd: 0 },
      paid: { enabled: false, daily_usd: 0, user_daily_usd: 0 },
      hasCredential: () => true,
      now: new Date(),
    });
    expect(r.candidates).toEqual([]);
  });

  it("skips providers that can't run now and says why", () => {
    const off = syncFake("off");
    const sq = syncFake("square", undefined, { limits: { aspect_ratios: ["1:1"] } });
    const keyed = syncFake("keyed", undefined, { credential: "FAKE_KEY" });
    const paid = syncFake("paid", undefined, { tier: "paid" });
    const paused = syncFake("paused");
    const capped = syncFake("capped");
    const ok = syncFake("ok");
    const r = plan(
      [off, sq, keyed, paid, paused, capped, ok],
      [
        row(off.name, { enabled: false }),
        row(sq.name),
        row(keyed.name),
        row(paid.name),
        row(paused.name, { cooldown_until: "2026-11-15T12:05:00Z" }),
        row(capped.name),
        row(ok.name),
      ],
      {
        hasCredential: (p) => p.name !== keyed.name,
        usedToday: new Map([[capped.name, 10]]),
      },
    );
    expect(r.candidates.map((c) => c.provider.name)).toEqual([ok.name]);
    expect(Object.fromEntries(r.skipped.map((s) => [s.provider, s.reason]))).toEqual({
      [off.name]: "disabled",
      [sq.name]: "unsupported",
      [keyed.name]: "no_credential",
      [paid.name]: "paid_off",
      [paused.name]: "cooling_down",
      [capped.name]: "over_daily_limit",
    });
  });

  it("tries a provider again once its pause has passed", () => {
    const p = syncFake("p");
    const r = plan([p], [row(p.name, { cooldown_until: "2026-11-15T11:59:00Z" })]);
    expect(r.candidates).toHaveLength(1);
  });

  it("keeps paid providers within today's budgets", () => {
    const paid = syncFake("paid", undefined, {
      tier: "paid",
      cost: { unit: "image", usd_per_unit: 0.3, source: "t" },
    });
    const on = { enabled: true, daily_usd: 1, user_daily_usd: 0.5 };
    expect(plan([paid], [row(paid.name)], { paid: on }).candidates).toHaveLength(1);
    const user = plan([paid], [row(paid.name)], {
      paid: on,
      spend: { total_usd: 0.3, user_usd: 0.3 },
    });
    expect(user.skipped[0]?.reason).toBe("over_budget");
  });

  it("orders by health, then priority, then estimated cost", () => {
    const a = syncFake("a", undefined, {
      cost: { unit: "image", usd_per_unit: 0.02, source: "t" },
    });
    const b = syncFake("b", undefined, {
      cost: { unit: "image", usd_per_unit: 0.01, source: "t" },
    });
    const c = syncFake("c");
    const d = syncFake("d");
    const r = plan(
      [a, b, c, d],
      [
        row(a.name, { health_status: "healthy" }),
        row(b.name, { health_status: "healthy" }),
        row(c.name, { health_status: "degraded", priority: 1 }),
        row(d.name, { health_status: "healthy", priority: 50 }),
      ],
    );
    expect(r.candidates.map((x) => x.provider.name)).toEqual([b.name, a.name, d.name, c.name]);
  });
});

describe("generateMedia with timeouts, circuit breaker and costs", () => {
  const stateOf = async (name: string) =>
    (await listProvidersForCapability(db(), "image", { includeDisabled: true })).find(
      (r) => r.provider_name === name,
    )!;

  it("moves on from a provider that doesn't answer in time", async () => {
    const slow = syncFake("slow", () => new Promise<MediaResult>(() => undefined), {
      timeoutMs: 30,
    });
    const fast = syncFake("fast", () => media(), { defaultPriority: 20 });
    setMediaProvidersOverride([slow, fast]);
    const r = await generateMedia(db(), env, await owner(), image);
    expect(r.provider).toBe(fast.name);
    expect(r.attempts[0]).toMatchObject({ provider: slow.name, outcome: "timeout" });
    expect((await stateOf(slow.name)).health_status).toBe("degraded");
  });

  it("pauses a provider after three failures in a row and skips it while paused", async () => {
    const flaky = syncFake("flaky", () => new ProviderError("flaky", "503", "unavailable", true));
    setMediaProvidersOverride([flaky]);
    const o = await owner();
    for (let i = 0; i < 3; i++)
      await expect(generateMedia(db(), env, o, image)).rejects.toBeInstanceOf(NoProviderError);
    const s = await stateOf(flaky.name);
    expect(s).toMatchObject({ health_status: "down", consecutive_failures: 3 });
    expect(new Date(s.cooldown_until!).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    const err = await generateMedia(db(), env, o, image).catch((e: NoProviderError) => e);
    expect(err).toBeInstanceOf(NoProviderError);
    expect((err as NoProviderError).attempts).toEqual([
      expect.objectContaining({ provider: flaky.name, outcome: "cooling_down" }),
    ]);
    expect(flaky.calls).toBe(3); // not called while paused
  });

  it("a success clears the failure count and pause", async () => {
    let fail = true;
    const p = syncFake("p", () =>
      fail ? new ProviderError("p", "503", "unavailable", true) : media(),
    );
    setMediaProvidersOverride([p]);
    const o = await owner();
    await expect(generateMedia(db(), env, o, image)).rejects.toBeInstanceOf(NoProviderError);
    fail = false;
    await generateMedia(db(), env, o, image);
    expect(await stateOf(p.name)).toMatchObject({
      health_status: "healthy",
      consecutive_failures: 0,
      cooldown_until: null,
    });
  });

  it("an exhausted allowance pauses until it resets without counting as broken", async () => {
    const retryAt = nextUtcMidnight();
    const p = syncFake("q", () => new ProviderError("q", "used up", "quota", false, retryAt));
    setMediaProvidersOverride([p]);
    const err = (await generateMedia(db(), env, await owner(), image).catch(
      (e: unknown) => e,
    )) as NoProviderError;
    expect(err.retryable).toBe(false);
    expect(await stateOf(p.name)).toMatchObject({
      consecutive_failures: 0,
      cooldown_until: retryAt,
    });
  });

  it("records estimated and actual cost; paid providers stay off by default", async () => {
    const paid = syncFake("paid", () => media({ actual_cost_usd: 0.04 }), {
      tier: "paid",
      credential: "FAKE_KEY",
      cost: { unit: "image", usd_per_unit: 0.05, source: "t" },
    });
    const free = syncFake("free", () => media(), {
      cost: { unit: "image", usd_per_unit: 0.0006, source: "t" },
      defaultPriority: 50,
    });
    setMediaProvidersOverride([paid, free]);
    const o = await owner();

    const off = await generateMedia(db(), withEnv({ FAKE_KEY: "k" }), o, image);
    expect(off.provider).toBe(free.name); // paid generation is off
    expect(paid.calls).toBe(0);

    // (A provider proven healthy is tried before an untested one, so offer only the paid one.)
    setMediaProvidersOverride([paid]);
    const on = await generateMedia(db(), await paidOn(), o, image);
    expect(on.provider).toBe(paid.name);
    const rows = await db()
      .prepare(
        "SELECT provider_name, tier, estimated_cost_usd, actual_cost_usd, user_id FROM usage_events WHERE project_id = ? ORDER BY created_at",
      )
      .bind(o.projectId)
      .all();
    expect(rows.results).toEqual([
      {
        provider_name: free.name,
        tier: "free",
        estimated_cost_usd: 0.0006,
        actual_cost_usd: null,
        user_id: o.userId,
      },
      {
        provider_name: paid.name,
        tier: "paid",
        estimated_cost_usd: 0.05,
        actual_cost_usd: 0.04,
        user_id: o.userId,
      },
    ]);
  });

  it("never spends past the budget and releases the reservation of a failed paid call", async () => {
    let fail = false;
    const paid = syncFake(
      "paid",
      () => (fail ? new ProviderError("paid", "500", "unavailable", true) : media()),
      { tier: "paid", cost: { unit: "image", usd_per_unit: 0.4, source: "t" } },
    );
    setMediaProvidersOverride([paid]);
    const o = await owner();
    const e = await paidOn(1000);
    const budget = await paidOn(1);
    await generateMedia(db(), budget, o, image); // 0.40
    await generateMedia(db(), budget, o, image); // 0.80
    const third = (await generateMedia(db(), budget, o, image).catch(
      (x: unknown) => x,
    )) as NoProviderError;
    expect(third.attempts[0]).toMatchObject({ outcome: "over_budget" });
    expect(paid.calls).toBe(2);

    fail = true;
    await expect(generateMedia(db(), e, o, image)).rejects.toBeInstanceOf(NoProviderError);
    const count = await db()
      .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE provider_name = ?")
      .bind(paid.name)
      .first<{ n: number }>();
    expect(count?.n).toBe(2); // the failed call's reservation was removed
  });
});

describe("long-running jobs", () => {
  function asyncFake(
    base: string,
    script: (PollResult | Error)[],
    over: Partial<AsyncMediaProvider> = {},
  ): AsyncMediaProvider & { submits: number; polls: number } {
    const p = {
      ...fakeFacts(),
      mode: "async" as const,
      name: uniq(base),
      capability: "video" as const,
      cost: { unit: "second" as const, usd_per_unit: 0.05, source: "t" },
      pollIntervalSeconds: 5,
      maxWaitSeconds: 300,
      defaultPriority: 10,
      defaultDailyLimit: 100,
      submits: 0,
      polls: 0,
      ...over,
      async submit() {
        p.submits++;
        return { external_id: `ext-${p.submits}` };
      },
      async poll() {
        const next = script[Math.min(p.polls++, script.length - 1)]!;
        if (next instanceof Error) throw next;
        return next;
      },
    } as AsyncMediaProvider & { submits: number; polls: number };
    return p;
  }
  const storeJob = (r: MediaResult, j: { id: string }) => store(r, j.id);
  const store = async (r: MediaResult, id: string) => {
    const key = `test/jobs/${id}.${r.extension}`;
    await env.MEDIA.put(key, r.bytes);
    return key;
  };

  it("submits once per key, polls until done, stores the result and records cost", async () => {
    const p = asyncFake("vid", [
      { status: "running" },
      new ProviderError("vid", "network", "unavailable", true), // one bad poll isn't fatal
      { status: "succeeded", result: media({ units: 5, actual_cost_usd: 0.2 }) },
    ]);
    setMediaProvidersOverride([p]);
    const o = await owner();
    const job = await startMediaJob(db(), env, o, "run:video:scene-1", video);
    expect(job).toMatchObject({
      status: "submitted",
      external_id: "ext-1",
      estimated_cost_usd: 0.25,
    });
    expect((await startMediaJob(db(), env, o, "run:video:scene-1", video)).id).toBe(job.id);
    expect(p.submits).toBe(1);

    expect((await pollMediaJob(db(), env, o, job.id, storeJob)).status).toBe("running");
    expect((await pollMediaJob(db(), env, o, job.id, storeJob)).status).toBe("running");
    const done = await pollMediaJob(db(), env, o, job.id, storeJob);
    expect(done.status).toBe("succeeded");
    expect(done.job).toMatchObject({ polls: 3, actual_cost_usd: 0.2 });
    expect(await env.MEDIA.head(done.job.result_key!)).not.toBeNull();
    const usage = await db()
      .prepare(
        "SELECT units_used, estimated_cost_usd, actual_cost_usd, job_id FROM usage_events WHERE job_id = ?",
      )
      .bind(job.id)
      .first();
    expect(usage).toEqual({
      units_used: 5,
      estimated_cost_usd: 0.25,
      actual_cost_usd: 0.2,
      job_id: job.id,
    });
    // A finished job never changes again.
    expect((await pollMediaJob(db(), env, o, job.id, storeJob)).status).toBe("succeeded");
    expect(p.polls).toBe(3);
  });

  it("times a job out at its deadline and releases a paid reservation", async () => {
    const p = asyncFake("paidvid", [{ status: "running" }], {
      tier: "paid",
      maxWaitSeconds: 60,
    });
    setMediaProvidersOverride([p]);
    const o = await owner();
    const e = await paidOn();
    const job = await startMediaJob(db(), e, o, "k1", video).catch((x: NoProviderError) => {
      throw new Error(JSON.stringify(x.attempts));
    });
    const reserved = await db()
      .prepare("SELECT estimated_cost_usd FROM usage_events WHERE job_id = ?")
      .bind(job.id)
      .first<{ estimated_cost_usd: number }>();
    expect(reserved?.estimated_cost_usd).toBe(0.25);
    const late = new Date(Date.now() + 61_000);
    const r = await pollMediaJob(db(), e, o, job.id, storeJob, late);
    expect(r.status).toBe("timed_out");
    expect(
      await db().prepare("SELECT id FROM usage_events WHERE job_id = ?").bind(job.id).first(),
    ).toBeNull();
    expect((await getProviderJob(db(), o.userId, job.id))?.error_message).toMatch(/no result/);
  });

  it("only the owner can see or poll a job", async () => {
    const p = asyncFake("vid", [{ status: "running" }]);
    setMediaProvidersOverride([p]);
    const o = await owner();
    const job = await startMediaJob(db(), env, o, "k", video);
    const other = await owner();
    expect(await getProviderJob(db(), other.userId, job.id)).toBeNull();
    await expect(pollMediaJob(db(), env, other, job.id, storeJob)).rejects.toThrow(/not found/);
  });

  it("the workflow helper waits between polls and falls over to the next provider", async () => {
    const broken = asyncFake("broken", [
      { status: "failed", message: "render error", retryable: true },
    ]);
    const good = asyncFake(
      "good",
      [{ status: "running" }, { status: "succeeded", result: media({ units: 5 }) }],
      { defaultPriority: 20 },
    );
    setMediaProvidersOverride([broken, good]);
    const o = await owner();
    const names: string[] = [];
    const steps: JobSteps = {
      do: async (name, fn) => (names.push(name), fn()),
      sleep: async (name) => void names.push(name),
    };
    const out = await runMediaJob(
      steps,
      { db: db(), env, owner: o },
      "video-scene-1",
      video,
      store,
    );
    expect(out).toMatchObject({ status: "ok", provider: good.name });
    expect(names).toEqual([
      "video-scene-1-submit-1",
      "video-scene-1-wait-1-1",
      "video-scene-1-poll-1-1",
      "video-scene-1-submit-2",
      "video-scene-1-wait-2-1",
      "video-scene-1-poll-2-1",
      "video-scene-1-wait-2-2",
      "video-scene-1-poll-2-2",
    ]);
    expect((await listProviderJobs(db(), o.userId, o.projectId)).map((j) => j.status)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  it("the workflow helper returns a fallback when no provider can take the work", async () => {
    setMediaProvidersOverride([]);
    const steps: JobSteps = { do: async (_n, fn) => fn(), sleep: async () => undefined };
    const out = await runMediaJob(
      steps,
      { db: db(), env, owner: await owner() },
      "video-scene-2",
      video,
      store,
    );
    expect(out).toEqual({ status: "fallback", reason: "No video provider is configured." });
  });
});

describe("provider status and costs endpoints", () => {
  const call = (path: string, extra: Record<string, string> = {}) =>
    SELF.fetch(`https://example.test${path}`, {
      headers: { "x-dev-user": "costs@example.com", ...extra },
    });

  it("lists every capability with each provider's tier, cost and pause state", async () => {
    const keyed = syncFake("keyed", undefined, {
      tier: "paid",
      credential: "NOT_SET_KEY",
      cost: { unit: "image", usd_per_unit: 0.04, source: "t" },
    });
    setMediaProvidersOverride([keyed]);
    const { data } = (await (await call(API_PATHS.providers)).json()) as {
      data: Record<string, unknown>[];
    };
    expect([...new Set(data.map((d) => d.capability))]).toEqual([
      "text",
      "image",
      "video",
      "image_to_video",
      "voice",
      "music",
      "sfx",
    ]);
    expect(data.find((d) => d.provider_name === keyed.name)).toMatchObject({
      available: false,
      tier: "paid",
      usd_per_unit: 0.04,
      credential_set: false,
      note: "Needs the NOT_SET_KEY secret.",
    });
    expect(JSON.stringify(data)).not.toMatch(/"k"/);
    expect(data.find((d) => d.capability === "voice")).toMatchObject({
      note: "Narration is voiced in your browser (Kokoro) when the video renders.",
    });
  });

  it("reports paid settings and spend", async () => {
    const res = await call(API_PATHS.providerCosts);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { paid: { enabled: boolean; daily_budget_usd: number }; last_30_days: unknown[] };
    };
    expect(data.paid).toMatchObject({ enabled: false, daily_budget_usd: 0 });
    expect(Array.isArray(data.last_30_days)).toBe(true);
  });
});
