import { VENDOR_MODELS_BASE, VENDOR_ORT_BASE } from "@avs/contracts";

/**
 * Points transformers.js (used by the Kokoro voice and the depth model) at our own /vendor/ copy
 * of the models and the ONNX runtime, so nothing loads from a CDN at render time. If the
 * vendor copy isn't there (a fresh local checkout), models load from Hugging Face instead.
 */
export type ModelSource = "vendor" | "huggingface";

let configured: Promise<ModelSource> | null = null;

export function configureModels(
  probeModel: string,
  origin = globalThis.location?.origin ?? "",
): Promise<ModelSource> {
  configured ??= (async () => {
    const { env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const onnx = env.backends.onnx as { wasm?: { wasmPaths?: string; numThreads?: number } };
    if (onnx.wasm) {
      onnx.wasm.wasmPaths = `${origin}${VENDOR_ORT_BASE}`;
      // Threads need a cross-origin-isolated page; without it ONNX runs single-threaded anyway.
      if (!globalThis.crossOriginIsolated) onnx.wasm.numThreads = 1;
    }
    if (await vendorHas(`${origin}${VENDOR_MODELS_BASE}/${probeModel}/config.json`)) {
      env.remoteHost = `${origin}${VENDOR_MODELS_BASE}/`;
      env.remotePathTemplate = "{model}/";
      return "vendor";
    }
    return "huggingface";
  })();
  return configured;
}

async function vendorHas(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Test hook. */
export function resetModelConfig() {
  configured = null;
}
