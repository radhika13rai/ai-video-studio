import { describe, expect, it } from "vitest";
import {
  cancelJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  listJobs,
  listScenes,
  replaceScenes,
  startJob,
  updateSceneStatus,
} from "../src/db";
import { db, makeProject, makeUser } from "./helpers";

describe("scenes", () => {
  it("replaces the storyboard atomically and keeps order", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const s = await replaceScenes(db(), u.id, p.id, [
      { scene_number: 2, description: "Second" },
      { scene_number: 1, description: "First", voiceover: "Hello", visual_type: "video" },
    ]);
    expect(s.map((x) => x.description)).toEqual(["First", "Second"]);
    expect(s[0]).toMatchObject({ status: "pending", visual_type: "video", duration_seconds: 5 });

    const s2 = await replaceScenes(db(), u.id, p.id, [{ scene_number: 1, description: "Only" }]);
    expect(s2.map((x) => x.description)).toEqual(["Only"]);
  });

  it("rolls back the whole batch when one insert fails", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    await replaceScenes(db(), u.id, p.id, [{ scene_number: 1, description: "Keep me" }]);
    // Invalid input is rejected before anything is deleted.
    await expect(
      replaceScenes(db(), u.id, p.id, [
        { scene_number: 1, description: "a" },
        { scene_number: 1, description: "dup" },
      ]),
    ).rejects.toMatchObject({ kind: "invalid_data" });
    expect((await listScenes(db(), u.id, p.id)).map((x) => x.description)).toEqual(["Keep me"]);
  });

  it("D1 batches are transactional (a failing statement undoes the delete)", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    await replaceScenes(db(), u.id, p.id, [{ scene_number: 1, description: "Keep me" }]);
    const d = db();
    await expect(
      d.batch([
        d.prepare("DELETE FROM scenes WHERE project_id = ?").bind(p.id),
        d
          .prepare(
            "INSERT INTO scenes (id, project_id, scene_number, description, duration_seconds) VALUES (?,?,1,'bad',0)",
          )
          .bind(crypto.randomUUID(), p.id),
      ]),
    ).rejects.toThrow(/CHECK/i);
    expect((await listScenes(db(), u.id, p.id)).map((x) => x.description)).toEqual(["Keep me"]);
  });

  it("enforces ownership", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    const p = await makeProject(alice.id);
    const [scene] = await replaceScenes(db(), alice.id, p.id, [
      { scene_number: 1, description: "x" },
    ]);
    await expect(
      replaceScenes(db(), mallory.id, p.id, [{ scene_number: 1, description: "pwned" }]),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(await listScenes(db(), mallory.id, p.id)).toEqual([]);
    await expect(updateSceneStatus(db(), mallory.id, scene!.id, "ready")).rejects.toMatchObject({
      kind: "not_found",
    });
    await updateSceneStatus(db(), alice.id, scene!.id, "ready");
    expect((await listScenes(db(), alice.id, p.id))[0]?.status).toBe("ready");
  });

  it("caps scenes at the project limit", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const many = Array.from({ length: 21 }, (_, i) => ({ scene_number: i + 1, description: "s" }));
    await expect(replaceScenes(db(), u.id, p.id, many)).rejects.toMatchObject({
      kind: "invalid_data",
    });
  });
});

describe("jobs", () => {
  it("runs the happy path queued → running → completed", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const j = await createJob(db(), u.id, p.id, {
      agent_name: "scriptwriter",
      job_type: "write_script",
      input: { tone: "fun" },
    });
    expect(j).toMatchObject({
      status: "queued",
      retry_count: 0,
      max_retries: 3,
      input: { tone: "fun" },
    });
    const running = await startJob(db(), u.id, j.id);
    expect(running.status).toBe("running");
    expect(running.started_at).not.toBeNull();
    const done = await completeJob(db(), u.id, j.id, { script: "..." });
    expect(done).toMatchObject({ status: "completed", output: { script: "..." } });
    expect(done.completed_at).not.toBeNull();
  });

  it("applies the retry policy, then fails permanently", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const j = await createJob(db(), u.id, p.id, { agent_name: "a", job_type: "t", max_retries: 2 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await startJob(db(), u.id, j.id);
      const f = await failJob(db(), u.id, j.id, `boom ${attempt}`);
      expect(f).toMatchObject({ status: "queued", retry_count: attempt, will_retry: true });
    }
    await startJob(db(), u.id, j.id);
    const last = await failJob(db(), u.id, j.id, "final");
    expect(last).toMatchObject({
      status: "failed",
      retry_count: 2,
      will_retry: false,
      error_message: "final",
    });
    expect(last.completed_at).not.toBeNull();
  });

  it("guards transitions", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const j = await createJob(db(), u.id, p.id, { agent_name: "a", job_type: "t" });
    await expect(completeJob(db(), u.id, j.id, {})).rejects.toMatchObject({
      kind: "invalid_state",
    });
    await expect(failJob(db(), u.id, j.id, "x")).rejects.toMatchObject({ kind: "invalid_state" });
    await cancelJob(db(), u.id, j.id);
    await expect(startJob(db(), u.id, j.id)).rejects.toMatchObject({ kind: "invalid_state" });
    await expect(startJob(db(), u.id, crypto.randomUUID())).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(
      createJob(db(), u.id, p.id, { agent_name: "a", job_type: "t", max_retries: 11 }),
    ).rejects.toMatchObject({ kind: "invalid_data" });
  });

  it("enforces ownership, including a scene from another project", async () => {
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    const p = await makeProject(alice.id);
    const other = await makeProject(alice.id);
    const [foreignScene] = await replaceScenes(db(), alice.id, other.id, [
      { scene_number: 1, description: "x" },
    ]);
    const j = await createJob(db(), alice.id, p.id, { agent_name: "a", job_type: "t" });

    await expect(
      createJob(db(), mallory.id, p.id, { agent_name: "a", job_type: "t" }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      createJob(db(), alice.id, p.id, {
        agent_name: "a",
        job_type: "t",
        scene_id: foreignScene!.id,
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(await getJob(db(), mallory.id, j.id)).toBeNull();
    expect(await listJobs(db(), mallory.id, p.id)).toEqual([]);
    await expect(startJob(db(), mallory.id, j.id)).rejects.toMatchObject({ kind: "not_found" });
    expect((await listJobs(db(), alice.id, p.id)).map((x) => x.id)).toEqual([j.id]);
  });
});
