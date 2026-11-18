import { describe, expect, it } from "vitest";
import {
  deleteProject,
  getProject,
  getUserById,
  listProjects,
  RepositoryError,
  updateProject,
  upsertUserByEmail,
} from "../src/db";
import { db, makeProject, makeUser } from "./helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("users", () => {
  it("upserts by normalized email and is idempotent", async () => {
    const a = await upsertUserByEmail(db(), "  Bob@Example.com ", "Bob");
    const b = await upsertUserByEmail(db(), "bob@example.com");
    expect(a.id).toMatch(UUID);
    expect(b.id).toBe(a.id);
    expect(a.email).toBe("bob@example.com");
    expect(a.created_at).toMatch(ISO);
    expect(await getUserById(db(), a.id)).toEqual(a);
  });

  it("rejects an invalid email", async () => {
    await expect(upsertUserByEmail(db(), "not-an-email")).rejects.toMatchObject({
      kind: "invalid_data",
    });
  });
});

describe("projects", () => {
  it("creates with defaults, UUID id and UTC timestamps", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id, { style: "noir" });
    expect(p).toMatchObject({
      user_id: u.id,
      status: "created",
      video_type: "faceless",
      production_config: { style: "noir" },
    });
    expect(p.id).toMatch(UUID);
    expect(p.created_at).toMatch(ISO);
  });

  it("validates input before writing", async () => {
    const u = await makeUser();
    await expect(makeProject(u.id, { duration_seconds: 9999 })).rejects.toBeInstanceOf(
      RepositoryError,
    );
    await expect(makeProject(u.id, { title: "   " })).rejects.toMatchObject({
      kind: "invalid_data",
    });
    expect((await listProjects(db(), u.id)).items).toHaveLength(0);
  });

  it("enforces ownership on get, list, update and delete", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    const p = await makeProject(alice.id);

    expect(await getProject(db(), mallory.id, p.id)).toBeNull();
    expect((await listProjects(db(), mallory.id)).items).toEqual([]);
    await expect(updateProject(db(), mallory.id, p.id, { title: "pwned" })).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(deleteProject(db(), mallory.id, p.id)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await getProject(db(), alice.id, p.id))?.title).toBe("Ocean facts");
  });

  it("updates fields and bumps updated_at", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    await new Promise((r) => setTimeout(r, 5));
    const up = await updateProject(db(), u.id, p.id, {
      status: "planning",
      production_config: { music: "calm" },
    });
    expect(up.status).toBe("planning");
    expect(up.production_config).toEqual({ music: "calm" });
    expect(up.updated_at > p.updated_at).toBe(true);
    await expect(
      updateProject(db(), u.id, p.id, { status: "exploded" as never }),
    ).rejects.toMatchObject({ kind: "invalid_data" });
  });

  it("paginates newest first with a cursor and filters by status", async () => {
    const u = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await makeProject(u.id, { title: `P${i}` })).id);
    const first = await listProjects(db(), u.id, { limit: 2 });
    expect(first.items.map((p) => p.title)).toEqual(["P4", "P3"]);
    const second = await listProjects(db(), u.id, { limit: 2, cursor: first.next_cursor });
    expect(second.items.map((p) => p.title)).toEqual(["P2", "P1"]);
    const third = await listProjects(db(), u.id, { limit: 2, cursor: second.next_cursor });
    expect(third.items.map((p) => p.title)).toEqual(["P0"]);
    expect(third.next_cursor).toBeNull();

    await updateProject(db(), u.id, ids[0]!, { status: "completed" });
    const done = await listProjects(db(), u.id, { status: "completed" });
    expect(done.items.map((p) => p.id)).toEqual([ids[0]]);
    await expect(listProjects(db(), u.id, { cursor: "garbage!" })).rejects.toMatchObject({
      kind: "invalid_data",
    });
  });

  it("delete cascades and returns R2 keys to clean up", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const key = `projects/${p.id}/img.png`;
    await db()
      .prepare(
        "INSERT INTO assets (id, project_id, asset_type, storage_key, mime_type) VALUES (?,?,'image',?,'image/png')",
      )
      .bind(crypto.randomUUID(), p.id, key)
      .run();
    expect(await deleteProject(db(), u.id, p.id)).toEqual({
      storage_keys: [key],
      workflow_instance_id: null,
    });
    expect(await getProject(db(), u.id, p.id)).toBeNull();
    const left = await db().prepare("SELECT COUNT(*) AS n FROM assets").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
