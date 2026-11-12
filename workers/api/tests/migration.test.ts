import {
  ASSET_TYPES,
  ASPECT_RATIOS,
  JOB_STATUSES,
  PROJECT_STATUSES,
  PROVIDER_CAPABILITIES,
  PROVIDER_HEALTH_STATUSES,
  QUALITY_STATUSES,
  SCENE_STATUSES,
  SCENE_VISUAL_TYPES,
  TARGET_PLATFORMS,
  VIDEO_TYPES,
  WORKFLOW_RUN_STATUSES,
} from "@avs/types";
import { describe, expect, it } from "vitest";
import { db, makeProject, makeUser } from "./helpers";

const TABLES = [
  "assets",
  "jobs",
  "projects",
  "providers",
  "quality_reports",
  "scenes",
  "usage_events",
  "users",
  "workflow_runs",
];

describe("migration 0001", () => {
  it("creates the nine tables and the indexes", async () => {
    const { results } = await db()
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string; type: string }>();
    const tables = results.filter((r) => r.type === "table" && r.name !== "d1_migrations");
    expect(tables.map((t) => t.name).sort()).toEqual(TABLES);
    const indexes = results.filter((r) => r.type === "index" && r.name.startsWith("idx_"));
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        "idx_projects_user",
        "idx_projects_status",
        "idx_jobs_project",
        "idx_jobs_status",
        "idx_scenes_project",
        "idx_assets_project",
        "idx_workflows_project",
        "idx_usage_project",
      ]),
    );
  });

  it("enforces foreign keys", async () => {
    await expect(
      db()
        .prepare("INSERT INTO projects (id, user_id, title, prompt, video_type) VALUES (?,?,?,?,?)")
        .bind(crypto.randomUUID(), "no-such-user", "t", "p", "auto")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("cascades project deletes to child rows and keeps usage rows", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const d = db();
    await d.batch([
      d
        .prepare(
          "INSERT INTO scenes (id, project_id, scene_number, description) VALUES (?,?,1,'s')",
        )
        .bind(crypto.randomUUID(), p.id),
      d
        .prepare("INSERT INTO jobs (id, project_id, agent_name, job_type) VALUES (?,?,'a','t')")
        .bind(crypto.randomUUID(), p.id),
      d
        .prepare(
          "INSERT INTO usage_events (id, project_id, provider_name, capability, unit_type) VALUES (?,?,'x','text','tokens')",
        )
        .bind(crypto.randomUUID(), p.id),
    ]);
    await d.prepare("DELETE FROM projects WHERE id = ?").bind(p.id).run();
    const count = async (t: string) =>
      (
        await d
          .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`)
          .bind(p.id)
          .first<{ n: number }>()
      )?.n;
    expect(await count("scenes")).toBe(0);
    expect(await count("jobs")).toBe(0);
    const usage = await d
      .prepare("SELECT project_id FROM usage_events")
      .all<{ project_id: string | null }>();
    expect(usage.results).toEqual([{ project_id: null }]);
  });

  it("rejects invalid JSON and out-of-range values", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const d = db();
    await expect(
      d.prepare("UPDATE projects SET production_config = 'not json' WHERE id = ?").bind(p.id).run(),
    ).rejects.toThrow(/CHECK/i);
    await expect(
      d
        .prepare(
          "INSERT INTO jobs (id, project_id, agent_name, job_type, retry_count, max_retries) VALUES (?,?,'a','t',4,3)",
        )
        .bind(crypto.randomUUID(), p.id)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  // The CHECK lists in SQL must accept exactly the TypeScript vocabularies.
  const vocab: [string, string, readonly string[], (v: string) => string][] = [
    [
      "projects",
      "video_type",
      VIDEO_TYPES,
      (v) => `UPDATE projects SET video_type = '${v}' WHERE id = ?`,
    ],
    [
      "projects",
      "aspect_ratio",
      ASPECT_RATIOS,
      (v) => `UPDATE projects SET aspect_ratio = '${v}' WHERE id = ?`,
    ],
    [
      "projects",
      "target_platform",
      TARGET_PLATFORMS,
      (v) => `UPDATE projects SET target_platform = '${v}' WHERE id = ?`,
    ],
    [
      "projects",
      "status",
      PROJECT_STATUSES,
      (v) => `UPDATE projects SET status = '${v}' WHERE id = ?`,
    ],
    [
      "scenes",
      "status",
      SCENE_STATUSES,
      (v) => `UPDATE scenes SET status = '${v}' WHERE project_id = ?`,
    ],
    [
      "scenes",
      "visual_type",
      SCENE_VISUAL_TYPES,
      (v) => `UPDATE scenes SET visual_type = '${v}' WHERE project_id = ?`,
    ],
    ["jobs", "status", JOB_STATUSES, (v) => `UPDATE jobs SET status = '${v}' WHERE project_id = ?`],
    [
      "workflow_runs",
      "status",
      WORKFLOW_RUN_STATUSES,
      (v) => `UPDATE workflow_runs SET status = '${v}' WHERE project_id = ?`,
    ],
    [
      "quality_reports",
      "overall_status",
      QUALITY_STATUSES,
      (v) => `UPDATE quality_reports SET overall_status = '${v}' WHERE project_id = ?`,
    ],
    [
      "assets",
      "asset_type",
      ASSET_TYPES,
      (v) => `UPDATE assets SET asset_type = '${v}' WHERE project_id = ?`,
    ],
    [
      "usage_events",
      "capability",
      PROVIDER_CAPABILITIES,
      (v) => `UPDATE usage_events SET capability = '${v}' WHERE project_id = ?`,
    ],
  ];

  it("CHECK constraints match the shared TypeScript vocabularies", async () => {
    const u = await makeUser();
    const p = await makeProject(u.id);
    const d = db();
    await d.batch([
      d
        .prepare(
          "INSERT INTO scenes (id, project_id, scene_number, description) VALUES (?,?,1,'s')",
        )
        .bind(crypto.randomUUID(), p.id),
      d
        .prepare("INSERT INTO jobs (id, project_id, agent_name, job_type) VALUES (?,?,'a','t')")
        .bind(crypto.randomUUID(), p.id),
      d
        .prepare("INSERT INTO workflow_runs (id, project_id, workflow_name) VALUES (?,?,'w')")
        .bind(crypto.randomUUID(), p.id),
      d
        .prepare(
          "INSERT INTO quality_reports (id, project_id, overall_status) VALUES (?,?,'passed')",
        )
        .bind(crypto.randomUUID(), p.id),
      d
        .prepare(
          "INSERT INTO assets (id, project_id, asset_type, storage_key, mime_type) VALUES (?,?,'image',?,'image/png')",
        )
        .bind(crypto.randomUUID(), p.id, `projects/${p.id}/a.png`),
      d
        .prepare(
          "INSERT INTO usage_events (id, project_id, provider_name, capability, unit_type) VALUES (?,?,'x','text','tokens')",
        )
        .bind(crypto.randomUUID(), p.id),
    ]);
    for (const [table, col, values, sql] of vocab) {
      for (const v of values) {
        await expect(
          d.prepare(sql(v)).bind(p.id).run(),
          `${table}.${col}=${v}`,
        ).resolves.toBeTruthy();
      }
      await expect(
        d.prepare(sql("bogus")).bind(p.id).run(),
        `${table}.${col}=bogus`,
      ).rejects.toThrow(/CHECK/i);
    }
    for (const h of PROVIDER_HEALTH_STATUSES) {
      await d
        .prepare(
          "INSERT OR REPLACE INTO providers (id, provider_name, capability, health_status) VALUES ('p1','x','text',?)",
        )
        .bind(h)
        .run();
    }
    await expect(
      d.prepare("UPDATE providers SET health_status = 'bogus' WHERE id = 'p1'").run(),
    ).rejects.toThrow(/CHECK/i);
  });
});
