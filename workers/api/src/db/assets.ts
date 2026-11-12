import { ASSET_TYPES } from "@avs/types";
import { z } from "zod";
import { invalidData, notFound, rethrowConstraint } from "./errors";
import { jsonObject, type JsonObject } from "./schemas";
import { fromJson, newId, nowIso, OWNED, toJson } from "./util";

interface AssetRow {
  id: string;
  project_id: string;
  scene_id: string | null;
  asset_type: string;
  storage_key: string;
  mime_type: string;
  file_size: number | null;
  source_provider: string | null;
  license_metadata: string | null;
  metadata_json: string;
  created_at: string;
}

export interface Asset extends Omit<AssetRow, "asset_type" | "license_metadata" | "metadata_json"> {
  asset_type: (typeof ASSET_TYPES)[number];
  license: JsonObject | null;
  metadata: JsonObject;
}

function toAsset(r: AssetRow): Asset {
  const { license_metadata, metadata_json, ...rest } = r;
  return {
    ...rest,
    asset_type: z.enum(ASSET_TYPES).parse(r.asset_type),
    license: license_metadata === null ? null : fromJson(jsonObject, license_metadata, "license"),
    metadata: fromJson(jsonObject, metadata_json, "metadata"),
  };
}

/** R2 keys for a project's media all live under this prefix. */
export const assetKeyPrefix = (projectId: string) => `projects/${projectId}/`;

const createAssetSchema = z.object({
  asset_type: z.enum(ASSET_TYPES),
  storage_key: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\w\-./]+$/, "storage_key has invalid characters")
    .refine((k) => !k.includes(".."), "storage_key may not contain '..'"),
  mime_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, "mime_type is not valid"),
  file_size: z.number().int().nonnegative().nullish(),
  scene_id: z.string().nullish(),
  source_provider: z.string().max(100).nullish(),
  license: jsonObject.nullish(),
  metadata: jsonObject.default({}),
});
export type CreateAssetInput = z.input<typeof createAssetSchema>;

/** Records metadata for media already stored in R2. The key must sit under the project's prefix. */
export async function createAsset(
  db: D1Database,
  userId: string,
  projectId: string,
  input: CreateAssetInput,
): Promise<Asset> {
  const parsed = createAssetSchema.safeParse(input);
  if (!parsed.success) throw invalidData(parsed.error.issues[0]?.message ?? "invalid asset");
  const a = parsed.data;
  if (!a.storage_key.startsWith(assetKeyPrefix(projectId)))
    throw invalidData(`storage_key must start with ${assetKeyPrefix(projectId)}`);
  const id = newId();
  let changes: number;
  try {
    const res = await db
      .prepare(
        `INSERT INTO assets (id, project_id, scene_id, asset_type, storage_key, mime_type, file_size,
           source_provider, license_metadata, metadata_json, created_at)
         SELECT ?, p.id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM projects p
         WHERE p.id = ? AND p.user_id = ?
           AND (? IS NULL OR EXISTS (SELECT 1 FROM scenes s WHERE s.id = ? AND s.project_id = p.id))`,
      )
      .bind(
        id,
        a.scene_id ?? null,
        a.asset_type,
        a.storage_key,
        a.mime_type,
        a.file_size ?? null,
        a.source_provider ?? null,
        a.license ? toJson(jsonObject, a.license, "license") : null,
        toJson(jsonObject, a.metadata, "metadata"),
        nowIso(),
        projectId,
        userId,
        a.scene_id ?? null,
        a.scene_id ?? null,
      )
      .run();
    changes = res.meta.changes;
  } catch (err) {
    rethrowConstraint(err, "an asset with this storage_key already exists");
  }
  if (changes === 0) throw notFound(a.scene_id ? "project or scene" : "project");
  const asset = await getAsset(db, userId, id);
  if (!asset) throw new Error("asset insert failed");
  return asset;
}

export async function getAsset(
  db: D1Database,
  userId: string,
  assetId: string,
): Promise<Asset | null> {
  const row = await db
    .prepare(`SELECT * FROM assets WHERE id = ? AND ${OWNED("project_id")}`)
    .bind(assetId, userId)
    .first<AssetRow>();
  return row ? toAsset(row) : null;
}

export async function listAssets(
  db: D1Database,
  userId: string,
  projectId: string,
): Promise<Asset[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM assets WHERE project_id = ? AND ${OWNED("project_id")} ORDER BY created_at, id`,
    )
    .bind(projectId, userId)
    .all<AssetRow>();
  return results.map(toAsset);
}

/** Deletes the metadata row and returns the R2 key so the caller can delete the object. */
export async function deleteAsset(
  db: D1Database,
  userId: string,
  assetId: string,
): Promise<{ storage_key: string }> {
  const row = await db
    .prepare(`DELETE FROM assets WHERE id = ? AND ${OWNED("project_id")} RETURNING storage_key`)
    .bind(assetId, userId)
    .first<{ storage_key: string }>();
  if (!row) throw notFound("asset");
  return row;
}
