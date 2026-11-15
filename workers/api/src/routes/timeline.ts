import { API_PREFIX } from "@avs/contracts";
import { MAX_TIMELINE_BYTES, saveTimelineRequestSchema, type StoredTimeline } from "@avs/schemas";
import { z } from "zod";
import {
  getTimelineRevision,
  listTimelineRevisions,
  requireProject,
  saveTimeline,
  type Project,
} from "../db";
import { ApiError } from "../lib/errors";
import { jsonOk } from "../lib/http";
import { readJson } from "../lib/request";
import type { Router } from "../lib/router";
import {
  currentMedia,
  currentTimeline,
  parseTimeline,
  referenceProblems,
  repairTimeline,
} from "../timeline";
import type { Ctx } from "./projects";

/** States in which the production is still making (and replacing) the media. */
const BUSY = ["created", "planning", "generating"];

function requireEditable(project: Project): void {
  if (BUSY.includes(project.status))
    throw new ApiError(
      409,
      "INVALID_STATE",
      project.status === "created"
        ? "Generate the video first; then you can edit it."
        : "The video is still being produced. Edit it once production reaches “Ready to render”.",
    );
}

const CONFLICT = () =>
  new ApiError(
    409,
    "CONFLICT",
    "This video was changed in another tab or device. Reload to see the latest version.",
  );

export function registerTimelineRoutes(router: Router<Ctx>): void {
  const base = `${API_PREFIX}/projects/:id/timeline`;

  /** The timeline: the saved edit, or (revision 0) the one the production implies. */
  router.on("GET", base, async ({ db, user }, p) => {
    const project = await requireProject(db, user.id, p.id ?? "");
    requireEditable(project);
    const t = await currentTimeline(db, user.id, project);
    const body: StoredTimeline = {
      project_id: project.id,
      revision: t.revision,
      timeline: t.timeline,
      updated_at: t.updated_at,
    };
    return jsonOk(body);
  });

  /** Saves an edit made from `base_revision`; refused with 409 if another save came first. */
  router.on("PUT", base, async ({ request, db, user }, p) => {
    const project = await requireProject(db, user.id, p.id ?? "");
    requireEditable(project);
    const body = await readJson(request, saveTimelineRequestSchema, MAX_TIMELINE_BYTES);
    const parsed = parseTimeline(body.timeline);
    if (!parsed.ok) throw new ApiError(400, "VALIDATION_ERROR", parsed.message);
    const { scenes, assets } = await currentMedia(db, user.id, project.id);
    const problems = referenceProblems(parsed.timeline, scenes, assets);
    if (problems.length) throw new ApiError(400, "VALIDATION_ERROR", problems[0] ?? "");
    const res = await saveTimeline(db, user.id, project.id, body.base_revision, parsed.timeline);
    if (!res.ok) throw CONFLICT();
    const out: StoredTimeline = {
      project_id: project.id,
      revision: res.saved.revision,
      timeline: res.saved.timeline,
      updated_at: res.saved.updated_at,
    };
    return jsonOk(out);
  });

  /** Version history: the snapshots kept for this project, newest first. */
  router.on("GET", `${base}/revisions`, async ({ db, user }, p) => {
    const project = await requireProject(db, user.id, p.id ?? "");
    return jsonOk(await listTimelineRevisions(db, user.id, project.id));
  });

  /**
   * Restores a snapshot as the newest revision. References to media that was replaced since
   * point at the scene's current media (or are cleared).
   */
  router.on("POST", `${base}/revisions/:rev/restore`, async ({ request, db, user }, p) => {
    const project = await requireProject(db, user.id, p.id ?? "");
    requireEditable(project);
    const rev = Number(p.rev);
    if (!Number.isInteger(rev) || rev < 1) throw new ApiError(404, "NOT_FOUND", "No such version.");
    const body = await readJson(request, z.object({ base_revision: z.number().int().min(0) }));
    const snapshot = await getTimelineRevision(db, user.id, project.id, rev);
    if (!snapshot) throw new ApiError(404, "NOT_FOUND", "No such version.");
    const { assets } = await currentMedia(db, user.id, project.id);
    const { timeline } = repairTimeline(snapshot, assets);
    const res = await saveTimeline(
      db,
      user.id,
      project.id,
      body.base_revision,
      timeline,
      `restore ${rev}`,
    );
    if (!res.ok) throw CONFLICT();
    const out: StoredTimeline = {
      project_id: project.id,
      revision: res.saved.revision,
      timeline: res.saved.timeline,
      updated_at: res.saved.updated_at,
    };
    return jsonOk(out);
  });
}
