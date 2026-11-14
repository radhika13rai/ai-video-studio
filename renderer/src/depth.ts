import { DEPTH_MODEL } from "@avs/contracts";
import { configureModels } from "./models";

/**
 * Depth estimation with Depth Anything V2 Small (Apache-2.0) in the browser. The result is a
 * grayscale map where bright means near; the parallax renderer uses it to move the foreground
 * against the background, so a still picture behaves like a real camera move.
 */
export interface DepthMap {
  data: Uint8Array;
  width: number;
  height: number;
}

export type DepthEstimator = (image: Blob) => Promise<DepthMap>;

let estimator: Promise<DepthEstimator> | null = null;

export function loadDepthEstimator(
  onProgress?: (fraction: number) => void,
): Promise<DepthEstimator> {
  estimator ??= (async () => {
    await configureModels(DEPTH_MODEL);
    const { pipeline, RawImage } = await import("@huggingface/transformers");
    const pipe = await pipeline("depth-estimation", DEPTH_MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p: { status: string; loaded?: number; total?: number }) => {
        if (p.status === "progress" && p.total) onProgress?.((p.loaded ?? 0) / p.total);
      },
    });
    return async (blob: Blob) => {
      const input = await RawImage.fromBlob(blob);
      const out = (await pipe(input)) as unknown as {
        depth: {
          data: Uint8Array | Uint8ClampedArray;
          width: number;
          height: number;
          channels: number;
        };
      };
      const d = out.depth;
      const gray =
        d.channels === 1
          ? Uint8Array.from(d.data)
          : Uint8Array.from({ length: d.width * d.height }, (_, i) => d.data[i * d.channels] ?? 0);
      return { data: gray, width: d.width, height: d.height };
    };
  })();
  estimator.catch(() => {
    estimator = null;
  });
  return estimator;
}
