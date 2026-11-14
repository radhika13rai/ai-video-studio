import type { KokoroVoiceId } from "@avs/contracts";
import { loadDepthEstimator } from "./depth";
import { loadNarrator } from "./voice";

/**
 * Runs the voice (Kokoro) and depth models off the page's main thread, so the page stays
 * responsive and a slow phone can be timed out (the worker is simply terminated).
 */

export type MlRequest =
  | { id: number; kind: "load-voice" }
  | { id: number; kind: "load-depth" }
  | { id: number; kind: "speak"; text: string; voice: KokoroVoiceId; speed: number }
  | { id: number; kind: "depth"; image: Blob };

export type MlResponse =
  | { id: number; kind: "progress"; fraction: number }
  | { id: number; kind: "ok" }
  | { id: number; kind: "speech"; samples: Float32Array; sampleRate: number }
  | { id: number; kind: "depth"; data: Uint8Array; width: number; height: number }
  | { id: number; kind: "error"; message: string };

interface WorkerScope {
  postMessage(msg: MlResponse, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<MlRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const post = (msg: MlResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

scope.onmessage = async (e: MessageEvent<MlRequest>) => {
  const req = e.data;
  const progress = (fraction: number) => post({ id: req.id, kind: "progress", fraction });
  try {
    switch (req.kind) {
      case "load-voice":
        await loadNarrator(progress);
        post({ id: req.id, kind: "ok" });
        break;
      case "load-depth":
        await loadDepthEstimator(progress);
        post({ id: req.id, kind: "ok" });
        break;
      case "speak": {
        const narrator = await loadNarrator();
        const s = await narrator.speak(req.text, req.voice, req.speed);
        const samples = new Float32Array(s.samples); // own copy, so it can be transferred
        post({ id: req.id, kind: "speech", samples, sampleRate: s.sampleRate }, [samples.buffer]);
        break;
      }
      case "depth": {
        const estimate = await loadDepthEstimator();
        const d = await estimate(req.image);
        post({ id: req.id, kind: "depth", data: d.data, width: d.width, height: d.height }, [
          d.data.buffer,
        ]);
        break;
      }
    }
  } catch (err) {
    post({ id: req.id, kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
