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
  providerCosts: `${API_PREFIX}/providers/costs`,
  projectTimeline: (id: string) => `${API_PREFIX}/projects/${id}/timeline`,
  projectTimelineRevisions: (id: string) => `${API_PREFIX}/projects/${id}/timeline/revisions`,
  projectTimelineRestore: (id: string, rev: number) =>
    `${API_PREFIX}/projects/${id}/timeline/revisions/${rev}/restore`,
  projectRender: (id: string) => `${API_PREFIX}/projects/${encodeURIComponent(id)}/render`,
  projectRenderUpload: (id: string, renderRequestId: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(id)}/render/upload?render_request_id=${encodeURIComponent(renderRequestId)}`,
  projectRenderComplete: (id: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(id)}/render/complete`,
  sceneRetryMedia: (projectId: string, sceneId: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/retry-media`,
  projectRenderAbort: (id: string) =>
    `${API_PREFIX}/projects/${encodeURIComponent(id)}/render/abort`,
} as const;

/** Header that makes a POST safe to retry: the same key replays the first response. */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** Largest final video the API accepts (Workers allow 100 MB request bodies on the free plan). */
export const MAX_RENDER_BYTES = 95 * 1024 * 1024;

/**
 * Header carrying the browser render's attempt token (from the render manifest) on upload,
 * complete and abort. Only the render holding the project may finish or cancel it.
 */
export const RENDER_ATTEMPT_HEADER = "x-render-attempt";
/** How long a render holds a project before another device may start one without taking over. */
export const RENDER_LEASE_MINUTES = 30;

/** Where the FFmpeg.wasm core is served from (same origin; see docs/RENDERER.md). */
export const FFMPEG_CORE_VERSION = "0.12.10";
export const FFMPEG_CORE_BASE = `/vendor/ffmpeg-core/${FFMPEG_CORE_VERSION}`;

/**
 * Every third-party file the browser renderer loads, served from R2 under /vendor/ (same
 * origin, no CDN at runtime). `npm` files are copied from node_modules at the pinned package
 * version; `url` files are downloaded once at deploy time and must match `sha256`.
 */
export type VendorSource =
  { kind: "npm"; package: string; file: string } | { kind: "url"; url: string; sha256: string };
export interface VendorFile {
  /** Path under /vendor/ (also the R2 key under vendor/). */
  path: string;
  contentType: string;
  source: VendorSource;
}

export const TRANSFORMERS_VERSION = "3.8.1";
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_MODEL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
export const DEPTH_MODEL_REVISION = "4472b7362082ad9968fee890ca0f1e5aca36b93d";
/** Base the renderer gives transformers.js: `${VENDOR_MODELS_BASE}/${model}/<file>`. */
export const VENDOR_MODELS_BASE = "/vendor/models";
export const VENDOR_ORT_BASE = `/vendor/transformers/${TRANSFORMERS_VERSION}/`;

/** Narration voices (Kokoro-82M). The first is the default; the second is the backup. */
export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart (warm American woman)" },
  { id: "am_michael", label: "Michael (American man)" },
] as const;
export type KokoroVoiceId = (typeof KOKORO_VOICES)[number]["id"];

const hf = (model: string, revision: string, file: string, sha256: string): VendorFile => ({
  path: `models/${model}/${file}`,
  contentType: file.endsWith(".json") ? "application/json" : "application/octet-stream",
  source: {
    kind: "url",
    url: `https://huggingface.co/${model}/resolve/${revision}/${file}`,
    sha256,
  },
});

export const VENDOR_FILES: VendorFile[] = [
  ...["ffmpeg-core.js", "ffmpeg-core.wasm"].map((f): VendorFile => ({
    path: `ffmpeg-core/${FFMPEG_CORE_VERSION}/${f}`,
    contentType: f.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    source: { kind: "npm", package: "@ffmpeg/core", file: `dist/esm/${f}` },
  })),
  ...["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"].map(
    (f): VendorFile => ({
      path: `transformers/${TRANSFORMERS_VERSION}/${f}`,
      contentType: f.endsWith(".wasm") ? "application/wasm" : "text/javascript",
      source: { kind: "npm", package: "@huggingface/transformers", file: `dist/${f}` },
    }),
  ),
  hf(
    KOKORO_MODEL,
    KOKORO_MODEL_REVISION,
    "config.json",
    "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
  ),
  hf(
    KOKORO_MODEL,
    KOKORO_MODEL_REVISION,
    "tokenizer.json",
    "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  ),
  hf(
    KOKORO_MODEL,
    KOKORO_MODEL_REVISION,
    "tokenizer_config.json",
    "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  ),
  hf(
    KOKORO_MODEL,
    KOKORO_MODEL_REVISION,
    "onnx/model_quantized.onnx",
    "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
  ),
  ...KOKORO_VOICES.map((v): VendorFile => ({
    path: `models/${KOKORO_MODEL}/voices/${v.id}.bin`,
    contentType: "application/octet-stream",
    source: { kind: "npm", package: "kokoro-js", file: `voices/${v.id}.bin` },
  })),
  hf(
    DEPTH_MODEL,
    DEPTH_MODEL_REVISION,
    "config.json",
    "3aee5b9bc4f711ee885c2526d871f0c8c6c8c4b26b8e04253d0167f6a83264f5",
  ),
  hf(
    DEPTH_MODEL,
    DEPTH_MODEL_REVISION,
    "preprocessor_config.json",
    "03576db3c13dd0471fdf5f5e1428befcb95de063fe699879150b293dc9e0a2c6",
  ),
  hf(
    DEPTH_MODEL,
    DEPTH_MODEL_REVISION,
    "onnx/model_quantized.onnx",
    "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d",
  ),
];

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
  ProviderCosts,
  QualityReport,
  RenderManifest,
  ProjectPage,
  Scene,
  UpdateProjectRequest,
  User,
  WorkflowRun,
} from "@avs/schemas";
