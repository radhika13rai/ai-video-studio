import {
  createProjectRequestSchema,
  listProjectsQuerySchema,
  updateProjectRequestSchema,
} from "@avs/schemas";
import {
  createProject,
  deleteProject,
  getLatestQualityReport,
  listAssets,
  listJobs,
  listProjects,
  listScenes,
  requireProject,
  updateProject,
  type User,
} from "../db";
import type { Env } from "../env";
import { jsonOk } from "../lib/http";
import { withIdempotency } from "../lib/idempotency";
import { parseOrThrow, readJson } from "../lib/request";
import type { Params, Router } from "../lib/router";
import { API_PREFIX, IDEMPOTENCY_HEADER } from "@avs/contracts";

export interface Ctx {
  request: Request;
  env: Env;
  db: D1Database;
  user: User;
  url: URL;
}

const id = (p: Params) => p.id ?? "";

export function registerProjectRoutes(router: Router<Ctx>): void {
  const base = `${API_PREFIX}/projects`;

  router.on("GET", `${API_PREFIX}/me`, async ({ user }) => jsonOk(user));

  router.on("POST", base, async ({ request, db, user }) =>
    withIdempotency(db, user.id, request.headers.get(IDEMPOTENCY_HEADER), request, async () => {
      const body = await readJson(request, createProjectRequestSchema);
      const project = await createProject(db, user.id, body);
      const res = jsonOk(project, 201);
      res.headers.set("location", `${base}/${project.id}`);
      return res;
    }),
  );

  router.on("GET", base, async ({ url, db, user }) => {
    const q = parseOrThrow(listProjectsQuerySchema, Object.fromEntries(url.searchParams));
    return jsonOk(
      await listProjects(db, user.id, {
        limit: q.limit,
        cursor: q.cursor ?? null,
        ...(q.status ? { status: q.status } : {}),
      }),
    );
  });

  router.on("GET", `${base}/:id`, async ({ db, user }, p) =>
    jsonOk(await requireProject(db, user.id, id(p))),
  );

  router.on("PATCH", `${base}/:id`, async ({ request, db, user }, p) => {
    const body = await readJson(request, updateProjectRequestSchema);
    const current = await requireProject(db, user.id, id(p));
    const patch: Parameters<typeof updateProject>[3] = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.style !== undefined) {
      const config = { ...current.production_config };
      if (body.style === null) delete config.style;
      else config.style = body.style;
      patch.production_config = config;
    }
    return jsonOk(await updateProject(db, user.id, id(p), patch));
  });

  router.on("DELETE", `${base}/:id`, async ({ env, db, user }, p) => {
    const { storage_keys } = await deleteProject(db, user.id, id(p));
    // The rows are gone; now remove the media. R2 deletes up to 1000 keys per call.
    if (env.MEDIA) {
      for (let i = 0; i < storage_keys.length; i += 1000)
        await env.MEDIA.delete(storage_keys.slice(i, i + 1000));
    } else if (storage_keys.length > 0) {
      console.warn(`MEDIA binding missing; ${storage_keys.length} R2 objects were not deleted`);
    }
    return jsonOk({ id: id(p), deleted: true, media_deleted: storage_keys.length });
  });

  router.on("GET", `${base}/:id/scenes`, async ({ db, user }, p) => {
    await requireProject(db, user.id, id(p));
    return jsonOk(await listScenes(db, user.id, id(p)));
  });

  router.on("GET", `${base}/:id/jobs`, async ({ db, user }, p) => {
    await requireProject(db, user.id, id(p));
    return jsonOk(await listJobs(db, user.id, id(p)));
  });

  router.on("GET", `${base}/:id/assets`, async ({ db, user }, p) => {
    await requireProject(db, user.id, id(p));
    return jsonOk(await listAssets(db, user.id, id(p)));
  });

  router.on("GET", `${base}/:id/quality`, async ({ db, user }, p) => {
    await requireProject(db, user.id, id(p));
    return jsonOk(await getLatestQualityReport(db, user.id, id(p)));
  });
}
