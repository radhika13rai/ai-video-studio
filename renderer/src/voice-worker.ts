import type { KokoroVoiceId } from "@avs/contracts";
import type { Speech } from "./voice";

/** The voice side of the model worker (`ModelWorker` in ml.ts satisfies it). */
export interface VoiceWorker {
  loadVoice(timeoutMs: number, onProgress?: (f: number) => void): Promise<void>;
  speak(text: string, voice: KokoroVoiceId, speed: number, timeoutMs: number): Promise<Speech>;
  readonly stopped: boolean;
  terminate(): void;
}

export interface RestartOptions {
  /** Starts a fresh worker; null where the browser can't. */
  start: () => VoiceWorker | null;
  /** Time limit for reloading the voice in a fresh worker. */
  loadVoiceMs: number;
  /** Time limit for the first line after a restart (it pays the warm-up again). */
  retrySpeechMs: number;
  /** How many fresh workers one render may use (default 2). */
  maxRestarts?: number;
  /** Called with the reason each time a fresh worker replaces a dead one. */
  onRestart?: (reason: string) => void;
}

/**
 * A voice worker that survives one slow or crashed line. `ModelWorker` terminates itself when a
 * call runs out of time (that is what really stops the work), and on its own every later scene
 * would then fail at once. This starts a fresh worker, reloads the voice and retries the line
 * (with the warm-up time limit), a bounded number of times, so one slow scene costs one scene at
 * most instead of all the narration after it.
 */
export class RestartingVoiceWorker implements VoiceWorker {
  private inner: VoiceWorker;
  private restarts = 0;
  private closed = false;
  private lastError: Error | null = null;
  private readonly max: number;

  constructor(
    first: VoiceWorker,
    private readonly opts: RestartOptions,
  ) {
    this.inner = first;
    this.max = opts.maxRestarts ?? 2;
  }

  get restartCount(): number {
    return this.restarts;
  }

  get stopped(): boolean {
    return this.closed || (this.inner.stopped && this.restarts >= this.max);
  }

  loadVoice(timeoutMs: number, onProgress?: (f: number) => void): Promise<void> {
    return this.inner.loadVoice(timeoutMs, onProgress);
  }

  async speak(
    text: string,
    voice: KokoroVoiceId,
    speed: number,
    timeoutMs: number,
  ): Promise<Speech> {
    if (this.closed) throw new Error("render finished");
    let limit = timeoutMs;
    if (this.inner.stopped) {
      await this.restart(this.lastError?.message ?? "the voice worker stopped");
      limit = Math.max(timeoutMs, this.opts.retrySpeechMs);
    }
    try {
      return await this.inner.speak(text, voice, speed, limit);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.lastError = err;
      // A worker that is still alive failed on this line only (e.g. a bad voice): let the
      // caller decide. A dead one gets replaced and the line tried once more.
      if (!this.inner.stopped || this.restarts >= this.max || this.closed) throw err;
      await this.restart(err.message);
      return await this.inner.speak(
        text,
        voice,
        speed,
        Math.max(timeoutMs, this.opts.retrySpeechMs),
      );
    }
  }

  private async restart(reason: string): Promise<void> {
    if (this.restarts >= this.max) throw this.lastError ?? new Error(reason);
    this.restarts++;
    this.inner.terminate();
    const fresh = this.opts.start();
    if (!fresh) {
      this.restarts = this.max;
      throw new Error(`couldn't restart the voice worker after: ${reason}`);
    }
    this.inner = fresh;
    this.opts.onRestart?.(reason);
    await this.inner.loadVoice(this.opts.loadVoiceMs);
  }

  terminate(): void {
    this.closed = true;
    this.inner.terminate();
  }
}
