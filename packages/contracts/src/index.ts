/** How the frontend and the API talk: paths, response envelope and error codes. */

export const API_PREFIX = "/api/v1";

export const API_PATHS = {
  health: `${API_PREFIX}/health`,
} as const;

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "PROJECT_NOT_FOUND",
  "ACCESS_DENIED",
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

export type { BindingCheck, CreateProjectRequest, HealthData } from "@avs/schemas";
