import { QUALITY_STATUSES, type QualityStatus } from "@avs/types";
import { z } from "zod";
import { invalidData, notFound } from "./errors";
import { jsonArray, jsonObject, type JsonObject } from "./schemas";
import { fromJson, newId, nowIso, OWNED, toJson } from "./util";

interface QualityRow {
  id: string;
  project_id: string;
  overall_status: string;
  score: number | null;
  checks_json: string;
  recommendations_json: string;
  created_at: string;
}

export interface QualityReport {
  id: string;
  project_id: string;
  overall_status: QualityStatus;
  score: number | null;
  checks: JsonObject;
  recommendations: unknown[];
  created_at: string;
}

const toReport = (r: QualityRow): QualityReport => ({
  id: r.id,
  project_id: r.project_id,
  overall_status: z.enum(QUALITY_STATUSES).parse(r.overall_status),
  score: r.score,
  checks: fromJson(jsonObject, r.checks_json, "checks_json"),
  recommendations: fromJson(jsonArray, r.recommendations_json, "recommendations_json"),
  created_at: r.created_at,
});

const createSchema = z.object({
  overall_status: z.enum(QUALITY_STATUSES),
  score: z.number().min(0).max(100).nullish(),
  checks: jsonObject.default({}),
  recommendations: jsonArray.default([]),
});
export type CreateQualityReportInput = z.input<typeof createSchema>;

export async function createQualityReport(
  db: D1Database,
  userId: string,
  projectId: string,
  input: CreateQualityReportInput,
): Promise<QualityReport> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid report");
  const q = parsed.data;
  const row = await db
    .prepare(
      `INSERT INTO quality_reports (id, project_id, overall_status, score, checks_json,
         recommendations_json, created_at)
       SELECT ?, id, ?, ?, ?, ?, ? FROM projects WHERE id = ? AND user_id = ?
       RETURNING *`,
    )
    .bind(
      newId(),
      q.overall_status,
      q.score ?? null,
      toJson(jsonObject, q.checks, "checks"),
      toJson(jsonArray, q.recommendations, "recommendations"),
      nowIso(),
      projectId,
      userId,
    )
    .first<QualityRow>();
  if (!row) throw notFound("project");
  return toReport(row);
}

export async function getLatestQualityReport(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<QualityReport | null> {
  const row = await db
    .prepare(
      `SELECT * FROM quality_reports WHERE project_id = ? AND ${OWNED("project_id")}
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(projectId, userId)
    .first<QualityRow>();
  return row ? toReport(row) : null;
}
