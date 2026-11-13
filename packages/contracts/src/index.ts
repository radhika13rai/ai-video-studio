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
} as const;

/** Header that makes a POST safe to retry: the same key replays the first response. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

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
  Job,
  Project,
  ProjectPage,
  Scene,
  UpdateProjectRequest,
  User,
  WorkflowRun,
} from "@avs/schemas";
