import type { KokoroVoiceId } from "@avs/contracts";
import type { DepthMap } from "./depth";
import type { MlRequest, MlResponse } from "./ml.worker";
import type { Speech } from "./voice";

/**
 * Page-side handle to the model worker. Every call has a time limit; when one runs out the
 * worker is terminated (that really stops the work) and later calls fail at once, so the render
 * falls back to server narration or flat camera moves instead of hanging.
 */

export class TimeoutError extends Error {
  constructor(what: string, seconds: number) {
    super(`${what} took longer than ${seconds} s on this device`);
    this.name = "TimeoutError";
  }
}

type Pending = {
  resolve: (r: MlResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (fraction: number) => void;
};

type Body =
  | { kind: "load-voice" }
  | { kind: "load-depth" }
  | { kind: "speak"; text: string; voice: KokoroVoiceId; speed: number }
  | { kind: "depth"; image: Blob };

export class ModelWorker {
  private worker: Worker | null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead: string | null = null;

  constructor() {
    this.worker = new Worker(new URL("./ml.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<MlResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      if (e.data.kind === "progress") {
        p.onProgress?.(e.data.fraction);
        return;
      }
      this.pending.delete(e.data.id);
      if (e.data.kind === "error") p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    this.worker.onerror = (e) => this.kill(`the model worker crashed (${e.message || "error"})`);
  }

  private call(
    body: Body,
    timeoutMs: number,
    what: string,
    onProgress?: (f: number) => void,
  ): Promise<MlResponse> {
    if (this.dead || !this.worker) return Promise.reject(new Error(this.dead ?? "worker stopped"));
    const id = this.nextId++;
    const worker = this.worker;
    return new Promise<MlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new TimeoutError(what, Math.round(timeoutMs / 1000));
        this.kill(err.message);
        reject(err);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        ...(onProgress ? { onProgress } : {}),
      });
      worker.postMessage({ id, ...body } as MlRequest);
    });
  }

  async loadVoice(timeoutMs: number, onProgress?: (f: number) => void): Promise<void> {
    await this.call({ kind: "load-voice" }, timeoutMs, "Loading the voice", onProgress);
  }

  async loadDepth(timeoutMs: number, onProgress?: (f: number) => void): Promise<void> {
    await this.call({ kind: "load-depth" }, timeoutMs, "Loading the 3D model", onProgress);
  }

  async speak(
    text: string,
    voice: KokoroVoiceId,
    speed: number,
    timeoutMs: number,
  ): Promise<Speech> {
    const r = await this.call({ kind: "speak", text, voice, speed }, timeoutMs, "Voicing a scene");
    if (r.kind !== "speech") throw new Error("Unexpected reply from the voice worker");
    return { samples: r.samples, sampleRate: r.sampleRate };
  }

  async depth(image: Blob, timeoutMs: number): Promise<DepthMap> {
    const r = await this.call({ kind: "depth", image }, timeoutMs, "Depth for a picture");
    if (r.kind !== "depth") throw new Error("Unexpected reply from the depth worker");
    return { data: r.data, width: r.width, height: r.height };
  }

  get stopped(): boolean {
    return this.dead !== null;
  }

  private kill(reason: string) {
    if (this.dead) return;
    this.dead = reason;
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  terminate() {
    this.kill("render finished");
  }
}

/** Starts the model worker, or returns null where the browser can't run module workers. */
export function startModelWorker(): ModelWorker | null {
  try {
    return typeof Worker === "undefined" ? null : new ModelWorker();
  } catch {
    return null;
  }
}
