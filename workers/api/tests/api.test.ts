import { API_PATHS } from "@avs/contracts";
import {
  errorEnvelopeSchema,
  projectPageSchema,
  projectSchema,
  successEnvelopeSchema,
  userSchema,
} from "@avs/schemas";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAsset } from "../src/db";

const url = (p: string) => `https://example.test${p}`;
const projectBody = successEnvelopeSchema(projectSchema);

function call(path: string, init: RequestInit & { user?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-dev-user", init.user ?? "alice@example.com");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(url(path), {
    ...init,
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
}

const NEW = {
  title: "The Future of Smart Watches",
  prompt: "Create an engaging product advertisement",
  video_type: "advertisement",
  style: "premium cinematic",
};

async function create(user = "alice@example.com", body: object = NEW) {
  const res = await call(API_PATHS.projects, { method: "POST", json: body, user });
  expect(res.status).toBe(201);
  return projectBody.parse(await res.json()).data;
}

async function error(res: Response) {
  return errorEnvelopeSchema.parse(await res.json()).error;
}

describe("project API", () => {
  it("GET /me returns the signed-in user", async () => {
    const res = await call(API_PATHS.me, { user: "bob@example.com" });
    const me = successEnvelopeSchema(userSchema).parse(await res.json()).data;
    expect(me.email).toBe("bob@example.com");
  });

  it("creates a project with defaults and a Location header", async () => {
    const res = await call(API_PATHS.projects, { method: "POST", json: NEW });
    expect(res.status).toBe(201);
    const p = projectBody.parse(await res.json()).data;
    expect(res.headers.get("location")).toBe(API_PATHS.project(p.id));
    expect(p).toMatchObject({
      status: "created",
      aspect_ratio: "9:16",
      duration_seconds: 30,
      target_platform: "youtube_shorts",
      production_config: { style: "premium cinematic" },
    });
  });

  it("rejects invalid bodies with VALIDATION_ERROR and the failing field", async () => {
    const res = await call(API_PATHS.projects, {
      method: "POST",
      json: { ...NEW, duration_seconds: 600 },
    });
    expect(res.status).toBe(400);
    const e = await error(res);
    expect(e).toMatchObject({ code: "VALIDATION_ERROR", retryable: false });
    expect(e.message).toMatch(/^duration_seconds:/);

    const notJson = await SELF.fetch(url(API_PATHS.projects), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(notJson.status).toBe(400);

    const wrongType = await SELF.fetch(url(API_PATHS.projects), { method: "POST", body: "x" });
    expect(wrongType.status).toBe(415);
    expect((await error(wrongType)).code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const huge = await call(API_PATHS.projects, {
      method: "POST",
      json: { ...NEW, prompt: "x".repeat(70_000) },
    });
    expect(huge.status).toBe(413);
  });

  it("lists with pagination and status filter", async () => {
    const user = `pager-${crypto.randomUUID()}@example.com`;
    for (let i = 0; i < 3; i++) await create(user, { ...NEW, title: `P${i}` });
    const page1 = projectPageSchema.parse(
      ((await (await call(`${API_PATHS.projects}?limit=2`, { user })).json()) as { data: unknown })
        .data,
    );
    expect(page1.items.map((p) => p.title)).toEqual(["P2", "P1"]);
    const page2 = projectPageSchema.parse(
      (
        (await (
          await call(
            `${API_PATHS.projects}?limit=2&cursor=${encodeURIComponent(page1.next_cursor ?? "")}`,
            { user },
          )
        ).json()) as { data: unknown }
      ).data,
    );
    expect(page2.items.map((p) => p.title)).toEqual(["P0"]);
    expect(page2.next_cursor).toBeNull();

    const bad = await call(`${API_PATHS.projects}?limit=0`, { user });
    expect(bad.status).toBe(400);
    const badStatus = await call(`${API_PATHS.projects}?status=exploded`, { user });
    expect(badStatus.status).toBe(400);
  });

  it("gets, patches and deletes a project", async () => {
    const p = await create();
    const got = projectBody.parse(await (await call(API_PATHS.project(p.id))).json()).data;
    expect(got.id).toBe(p.id);

    const patched = await call(API_PATHS.project(p.id), {
      method: "PATCH",
      json: { title: "Renamed", style: null },
    });
    expect(patched.status).toBe(200);
    expect(projectBody.parse(await patched.json()).data).toMatchObject({
      title: "Renamed",
      production_config: {},
    });

    const statusPatch = await call(API_PATHS.project(p.id), {
      method: "PATCH",
      json: { status: "completed" },
    });
    expect(statusPatch.status).toBe(400);
    const empty = await call(API_PATHS.project(p.id), { method: "PATCH", json: {} });
    expect(empty.status).toBe(400);

    const del = await call(API_PATHS.project(p.id), { method: "DELETE" });
    expect(await del.json()).toEqual({
      success: true,
      data: { id: p.id, deleted: true, media_deleted: 0 },
    });
    const gone = await call(API_PATHS.project(p.id));
    expect(gone.status).toBe(404);
    expect((await error(gone)).code).toBe("PROJECT_NOT_FOUND");
  });

  it("deleting a project removes its media from R2", async () => {
    const p = await create();
    const key = `projects/${p.id}/scene-1.png`;
    await env.MEDIA.put(key, "png-bytes");
    await createAsset(env.DB, p.user_id, p.id, {
      asset_type: "image",
      storage_key: key,
      mime_type: "image/png",
    });
    const del = await call(API_PATHS.project(p.id), { method: "DELETE" });
    expect(((await del.json()) as { data: { media_deleted: number } }).data.media_deleted).toBe(1);
    expect(await env.MEDIA.head(key)).toBeNull();
  });

  it("returns 404, never another user's data", async () => {
    const p = await create("alice@example.com");
    const asMallory = { user: "mallory@example.com" };
    for (const [path, method] of [
      [API_PATHS.project(p.id), "GET"],
      [API_PATHS.project(p.id), "DELETE"],
      [API_PATHS.projectScenes(p.id), "GET"],
      [API_PATHS.projectJobs(p.id), "GET"],
      [API_PATHS.projectAssets(p.id), "GET"],
      [API_PATHS.projectQuality(p.id), "GET"],
    ] as const) {
      const res = await call(path, { method, ...asMallory });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await error(res)).code).toBe("PROJECT_NOT_FOUND");
    }
    const patch = await call(API_PATHS.project(p.id), {
      method: "PATCH",
      json: { title: "pwned" },
      ...asMallory,
    });
    expect(patch.status).toBe(404);
    const list = await call(API_PATHS.projects, asMallory);
    expect(projectPageSchema.parse(((await list.json()) as { data: unknown }).data).items).toEqual(
      [],
    );
    // Alice's project is untouched.
    const mine = projectBody.parse(await (await call(API_PATHS.project(p.id))).json()).data;
    expect(mine.title).toBe(NEW.title);
  });

  it("serves the read-only project collections", async () => {
    const p = await create();
    for (const path of [
      API_PATHS.projectScenes(p.id),
      API_PATHS.projectJobs(p.id),
      API_PATHS.projectAssets(p.id),
    ]) {
      expect(await (await call(path)).json()).toEqual({ success: true, data: [] });
    }
    expect(await (await call(API_PATHS.projectQuality(p.id))).json()).toEqual({
      success: true,
      data: null,
    });
  });

  it("answers wrong methods with 405 and an Allow header", async () => {
    const res = await call(API_PATHS.projects, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, GET, HEAD");
  });
});

describe("Idempotency-Key", () => {
  const post = (key: string, body: object = NEW, user = "idem@example.com") =>
    call(API_PATHS.projects, {
      method: "POST",
      json: body,
      user,
      headers: { "Idempotency-Key": key },
    });

  it("replays the first response for a retried request", async () => {
    const key = `create-${crypto.randomUUID()}`;
    const first = await post(key);
    const second = await post(key);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const a = projectBody.parse(await first.json()).data;
    const b = projectBody.parse(await second.json()).data;
    expect(b.id).toBe(a.id);
    const list = await call(`${API_PATHS.projects}?limit=100`, { user: "idem@example.com" });
    const ids = projectPageSchema
      .parse(((await list.json()) as { data: unknown }).data)
      .items.map((p) => p.id);
    expect(ids.filter((i) => i === a.id)).toHaveLength(1);
  });

  it("rejects reuse of a key for a different request", async () => {
    const key = `create-${crypto.randomUUID()}`;
    await post(key);
    const res = await post(key, { ...NEW, title: "Something else" });
    expect(res.status).toBe(422);
    expect((await error(res)).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("keeps keys per user", async () => {
    const key = `shared-${crypto.randomUUID()}`;
    const a = projectBody.parse(await (await post(key, NEW, "u1@example.com")).json()).data;
    const b = projectBody.parse(await (await post(key, NEW, "u2@example.com")).json()).data;
    expect(a.id).not.toBe(b.id);
  });

  it("validates the key format", async () => {
    const res = await post("has space");
    expect(res.status).toBe(400);
  });
});
