import type {
  CreateProjectRequest,
  HealthData,
  Project,
  ProjectPage,
  UpdateProjectRequest,
  User,
} from "@avs/contracts";
import { API_PATHS, IDEMPOTENCY_HEADER } from "@avs/contracts";
import type { ProjectStatus } from "@avs/types";
import {
  errorEnvelopeSchema,
  healthDataSchema,
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

const countSchema = z.array(z.unknown()).transform((a) => a.length);
export const countScenes = (id: string) => request(API_PATHS.projectScenes(id), countSchema);
export const countJobs = (id: string) => request(API_PATHS.projectJobs(id), countSchema);
