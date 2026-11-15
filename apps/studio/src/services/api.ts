import type {
  Asset,
  CreateProjectRequest,
  ProviderStatus,
  ProviderCosts,
  QualityReport,
  RenderManifest,
  GenerateResponse,
  HealthData,
  Job,
  Scene,
  WorkflowRun,
  Project,
  ProjectPage,
  UpdateProjectRequest,
  User,
} from "@avs/contracts";
import { API_PATHS, IDEMPOTENCY_HEADER, RENDER_ATTEMPT_HEADER } from "@avs/contracts";
import type { ProjectStatus } from "@avs/types";
import {
  assetSchema,
  errorEnvelopeSchema,
  providerStatusSchema,
  providerCostsSchema,
  qualityReportSchema,
  renderManifestSchema,
  generateResponseSchema,
  healthDataSchema,
  jobSchema,
  sceneSchema,
  workflowRunSchema,
  projectPageSchema,
  projectSchema,
  userSchema,
} from "@avs/schemas";
import { z } from "zod";

const BASE_URL: string = import.meta.env?.VITE_API_BASE_URL ?? "";

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Calls the API and validates the envelope and data. Nothing unvalidated reaches the UI. */
export async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  opts: RequestOptions = {},
): Promise<z.output<S>> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiClientError("NETWORK_ERROR", "Could not reach the API.", true);
  }
  const body: unknown = await res.json().catch(() => null);
  const success = z.object({ success: z.literal(true), data: schema }).safeParse(body);
  if (success.success && res.ok) return (success.data as { data: z.output<S> }).data;
  const failure = errorEnvelopeSchema.safeParse(body);
  if (failure.success) {
    const { code, message, retryable } = failure.data.error;
    throw new ApiClientError(code, message, retryable, res.status);
  }
  throw new ApiClientError(
    "INVALID_RESPONSE",
    `Unexpected response (HTTP ${res.status}).`,
    false,
    res.status,
  );
}

export const getHealth = (fetchImpl?: typeof fetch): Promise<HealthData> =>
  request(API_PATHS.health, healthDataSchema, fetchImpl ? { fetchImpl } : {});

export const getMe = (): Promise<User> => request(API_PATHS.me, userSchema);

export function listProjects(
  query: { cursor?: string | null; status?: ProjectStatus | null; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ProjectPage> {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 12));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.status) params.set("status", query.status);
  return request(`${API_PATHS.projects}?${params}`, projectPageSchema, signal ? { signal } : {});
}

export const getProject = (id: string, signal?: AbortSignal): Promise<Project> =>
  request(API_PATHS.project(id), projectSchema, signal ? { signal } : {});

/** `idempotencyKey` should be created once per form submission so retries can't duplicate. */
export const createProject = (
  body: CreateProjectRequest,
  idempotencyKey: string,
): Promise<Project> =>
  request(API_PATHS.projects, projectSchema, {
    method: "POST",
    body,
    headers: { [IDEMPOTENCY_HEADER]: idempotencyKey },
  });

export const updateProject = (id: string, body: UpdateProjectRequest): Promise<Project> =>
  request(API_PATHS.project(id), projectSchema, { method: "PATCH", body });

const deletedSchema = z.object({ id: z.string(), deleted: z.literal(true) });
export const deleteProject = (id: string) =>
  request(API_PATHS.project(id), deletedSchema, { method: "DELETE" });

export const listScenes = (id: string): Promise<Scene[]> =>
  request(API_PATHS.projectScenes(id), z.array(sceneSchema));
export const listJobs = (id: string): Promise<Job[]> =>
  request(API_PATHS.projectJobs(id), z.array(jobSchema));
export const listAssets = (id: string): Promise<Asset[]> =>
  request(API_PATHS.projectAssets(id), z.array(assetSchema));
export const listProviders = (): Promise<ProviderStatus[]> =>
  request(API_PATHS.providers, z.array(providerStatusSchema));
export const getProviderCosts = (): Promise<ProviderCosts> =>
  request(API_PATHS.providerCosts, providerCostsSchema);
export const assetUrl = (projectId: string, assetId: string) =>
  `${BASE_URL}${API_PATHS.assetContent(projectId, assetId)}`;
/** Starts a render; `takeover` replaces a render that's running in another tab or device. */
export const startRender = (id: string, takeover = false): Promise<RenderManifest> =>
  request(`${API_PATHS.projectRender(id)}${takeover ? "?takeover=1" : ""}`, renderManifestSchema, {
    method: "POST",
  });
export const completeRender = (
  id: string,
  renderRequestId: string,
  attemptToken: string,
  assetId: string,
) =>
  request(API_PATHS.projectRenderComplete(id), z.object({ status: z.string() }), {
    method: "POST",
    body: { render_request_id: renderRequestId, asset_id: assetId },
    headers: { [RENDER_ATTEMPT_HEADER]: attemptToken },
  });
export const abortRender = (id: string, attemptToken: string) =>
  request(API_PATHS.projectRenderAbort(id), projectSchema, {
    method: "POST",
    headers: { [RENDER_ATTEMPT_HEADER]: attemptToken },
  });

/** Uploads the finished MP4 as the raw request body (no multipart, no base64). */
export async function uploadRender(
  id: string,
  renderRequestId: string,
  attemptToken: string,
  mp4: Uint8Array,
  info: {
    durationSeconds: number;
    encoder: string;
    narration?: { kind: string; voiced: number; total: number };
  },
): Promise<Asset> {
  const res = await fetch(`${BASE_URL}${API_PATHS.projectRenderUpload(id, renderRequestId)}`, {
    method: "POST",
    headers: {
      "content-type": "video/mp4",
      [RENDER_ATTEMPT_HEADER]: attemptToken,
      "x-video-duration": String(info.durationSeconds),
      "x-video-encoder": info.encoder,
      ...(info.narration
        ? {
            "x-video-narration": info.narration.kind,
            "x-video-narrated-scenes": `${info.narration.voiced}/${info.narration.total}`,
          }
        : {}),
    },
    body: new Blob([mp4 as BlobPart], { type: "video/mp4" }),
  }).catch(() => {
    throw new ApiClientError("NETWORK_ERROR", "Upload failed: could not reach the API.", true);
  });
  const body: unknown = await res.json().catch(() => null);
  const ok = z.object({ success: z.literal(true), data: assetSchema }).safeParse(body);
  if (ok.success && res.ok) return ok.data.data;
  const failure = errorEnvelopeSchema.safeParse(body);
  if (failure.success)
    throw new ApiClientError(
      failure.data.error.code,
      failure.data.error.message,
      failure.data.error.retryable,
      res.status,
    );
  throw new ApiClientError(
    "INVALID_RESPONSE",
    `Upload failed (HTTP ${res.status}).`,
    false,
    res.status,
  );
}

export const getQuality = (id: string): Promise<QualityReport | null> =>
  request(API_PATHS.projectQuality(id), qualityReportSchema.nullable());
export const retrySceneMedia = (projectId: string, sceneId: string) =>
  request(
    API_PATHS.sceneRetryMedia(projectId, sceneId),
    z.object({ fallbacks: z.array(z.string()) }).loose(),
    {
      method: "POST",
    },
  );

export const getRun = (id: string): Promise<WorkflowRun | null> =>
  request(API_PATHS.projectRun(id), workflowRunSchema.nullable());

export const generateProject = (id: string, idempotencyKey: string): Promise<GenerateResponse> =>
  request(API_PATHS.projectGenerate(id), generateResponseSchema, {
    method: "POST",
    headers: { [IDEMPOTENCY_HEADER]: idempotencyKey },
  });
export const cancelProject = (id: string): Promise<Project> =>
  request(API_PATHS.projectCancel(id), projectSchema, { method: "POST" });
