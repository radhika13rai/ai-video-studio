import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { db, makeProject, makeUser } from "./helpers";

/**
 * Migration 0005 rebuilds `scenes` to allow 'graphics'. The rebuild is replayed here on a database
 * holding scenes with linked assets and jobs, to show that rows and links survive it.
 */
function rebuildStatements(): string[] {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0005_"));
  if (!m) throw new Error("migration 0005 not found");
  // Re-runnable part only: projects.graphics_theme already exists after the first run.
  return m.queries.filter((q) => !/ALTER TABLE projects/i.test(q));
}

describe("migration 0005 (graphics scenes)", () => {
  it("keeps scene rows, their asset and job links, and allows 'graphics'", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const d = db();
    const [s1, s2, a1, j1] = [1, 2, 3, 4].map(() => crypto.randomUUID()) as [
      string,
      string,
      string,
      string,
    ];
    await d.batch([
      d
        .prepare(
          "INSERT INTO scenes (id, project_id, scene_number, description, voiceover, visual_type, status) VALUES (?,?,1,'first','hello','image','ready')",
        )
        .bind(s1, p.id),
      d
        .prepare(
          "INSERT INTO scenes (id, project_id, scene_number, description, visual_type) VALUES (?,?,2,'second','text')",
        )
        .bind(s2, p.id),
      d
        .prepare(
          "INSERT INTO assets (id, project_id, scene_id, asset_type, storage_key, mime_type) VALUES (?,?,?,'image','k','image/png')",
        )
        .bind(a1, p.id, s1),
      d
        .prepare(
          "INSERT INTO jobs (id, project_id, scene_id, agent_name, job_type) VALUES (?,?,?,'a','t')",
        )
        .bind(j1, p.id, s2),
    ]);

    await d.batch(rebuildStatements().map((q) => d.prepare(q)));

    const scenes = await d
      .prepare(
        "SELECT id, scene_number, description, voiceover, visual_type, status, graphics_layout FROM scenes WHERE project_id = ? ORDER BY scene_number",
      )
      .bind(p.id)
      .all();
    expect(scenes.results).toEqual([
      {
        id: s1,
        scene_number: 1,
        description: "first",
        voiceover: "hello",
        visual_type: "image",
        status: "ready",
        graphics_layout: null,
      },
      {
        id: s2,
        scene_number: 2,
        description: "second",
        voiceover: null,
        visual_type: "text",
        status: "pending",
        graphics_layout: null,
      },
    ]);
    expect(
      await d.prepare("SELECT scene_id FROM assets WHERE id = ?").bind(a1).first("scene_id"),
    ).toBe(s1);
    expect(
      await d.prepare("SELECT scene_id FROM jobs WHERE id = ?").bind(j1).first("scene_id"),
    ).toBe(s2);

    // 'graphics' passes the CHECK and a layout can be stored; other values still fail.
    await d
      .prepare("UPDATE scenes SET visual_type = 'graphics', graphics_layout = ? WHERE id = ?")
      .bind(JSON.stringify({ preset: "headline_papers", headline: "HI" }), s2)
      .run();
    await expect(
      d.prepare("UPDATE scenes SET visual_type = 'bogus' WHERE id = ?").bind(s2).run(),
    ).rejects.toThrow(/CHECK/i);
    // The index and the cascade from projects survive the rebuild.
    const idx = await d
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_scenes_project'")
      .first("name");
    expect(idx).toBe("idx_scenes_project");
    await d.prepare("DELETE FROM projects WHERE id = ?").bind(p.id).run();
    expect(
      await d
        .prepare("SELECT COUNT(*) AS n FROM scenes WHERE project_id = ?")
        .bind(p.id)
        .first("n"),
    ).toBe(0);
    // No leftover helper table.
    expect(
      await d
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('scenes_new','scene_links_0005')")
        .first(),
    ).toBeNull();
  });

  it("adds projects.graphics_theme", async () => {
    const cols = await db().prepare("PRAGMA table_info(projects)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("graphics_theme");
  });
});
