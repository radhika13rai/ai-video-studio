/** How the frontend and the API talk: paths, response envelope and error codes. */

export const API_PREFIX = "/api/v1";

export const API_PATHS = {
  health: `${API_PREFIX}/health`,
  me: `${API_PREFIX}/me`,
  projects: `${API_PREFIX}/projects`,
  project: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}`,
  projectScenes: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/scenes`,
  projectJobs: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/jobs`,
  projectAssets: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/assets`,
  projectQuality: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/quality`,
  projectGenerate: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/generate`,
  projectCancel: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/cancel`,
  projectRun: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/run`,
  assetContent: (projectId: string, assetId: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/content`,
  providers: `${API_PREFIX}/providers`,
  projectRender: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/render`,
  projectRenderUpload: (id: string, renderRequestId: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(id)}/render/upload?render_request_id=${encodeURIComponent(renderRequestId)}`,
  projectRenderComplete: (id: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(id)}/render/complete`,
  projectRenderAbort: (id: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(id)}/render/abort`,
} as const;

/** Header that makes a POST safe to retry: the same key replays the first response. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** Largest final video the API accepts (Workers allow 100 MB request bodies on the free plan). */
export const MAX_RENDER_BYTES = 95 * 1024 * 1024;

/** Where the FFmpeg.wasm core is served from (same origin; see docs/RENDERER.md). */
export const FFMPEG_CORE_VERSION = "0.12.10";
export const FFMPEG_CORE_BASE = `/vendor/ffmpeg-core/${FFMPEG_CORE_VERSION}`;

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "PROJECT_NOT_FOUND",
  "ACCESS_DENIED",
  "CONFLICT",
  "INVALID_STATE",
  "IDEMPOTENCY_KEY_REUSED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_QUOTA_EXCEEDED",
  "GENERATION_FAILED",
  "RENDER_FAILED",
  "QUALITY_CHECK_FAILED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function fail(code: ErrorCode, message: string, retryable = false): ApiFailure {
  return { success: false, error: { code, message, retryable } };
}

export type {
  BindingCheck,
  CreateProjectRequest,
  GenerateResponse,
  HealthData,
  Asset,
  Job,
  Project,
  ProviderStatus,
  RenderManifest,
  ProjectPage,
  Scene,
  UpdateProjectRequest,
  User,
  WorkflowRun,
} from "@avs/schemas";
