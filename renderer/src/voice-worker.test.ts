import type { KokoroVoiceId } from "@avs/contracts";
import { describe, expect, it } from "vitest";
import type { Speech } from "./voice";
import { RestartingVoiceWorker, type VoiceWorker } from "./voice-worker";

const V = "af_heart" as KokoroVoiceId;
const speech = (n: number): Speech => ({ samples: new Float32Array(n), sampleRate: 24000 });

/**
 * A fake worker that behaves like ModelWorker: a line in `slow` "times out", which kills the
 * worker, so every later call fails at once.
 */
function fakeWorker(slow: Set<string>, log: string[], id: number): VoiceWorker {
  let dead: string | null = null;
  return {
    async loadVoice() {
      if (dead) throw new Error(dead);
      log.push(`load#${id}`);
    },
    async speak(text, _voice, _speed, timeoutMs) {
      if (dead) throw new Error(dead);
      log.push(`speak#${id}:${text}@${timeoutMs}`);
      if (slow.has(text)) {
        slow.delete(text); // slow once (cold or busy), fine on the retry
        dead = `Voicing a scene took longer than ${timeoutMs / 1000} s on this device`;
        throw new Error(dead);
      }
      return speech(text.length);
    },
    get stopped() {
      return dead !== null;
    },
    terminate() {
      dead ??= "render finished";
    },
  };
}

function setup(slow: string[], maxRestarts?: number) {
  const log: string[] = [];
  const slowSet = new Set(slow);
  let n = 0;
  const restarts: string[] = [];
  const w = new RestartingVoiceWorker(fakeWorker(slowSet, log, n++), {
    start: () => fakeWorker(slowSet, log, n++),
    loadVoiceMs: 300_000,
    retrySpeechMs: 120_000,
    ...(maxRestarts !== undefined ? { maxRestarts } : {}),
    onRestart: (r) => restarts.push(r),
  });
  return { w, log, restarts };
}

describe("restarting voice worker", () => {
  it("voices every scene after one slow line instead of dropping the rest", async () => {
    const { w, log, restarts } = setup(["two"]);
    const out: (Speech | null)[] = [];
    for (const line of ["one", "two", "three", "four", "five", "six"]) {
      out.push(await w.speak(line, V, 1, 60_000).catch(() => null));
    }
    expect(out.every((s) => s !== null)).toBe(true);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatch(/longer than 60 s/);
    // The slow line is retried in a fresh, reloaded worker with the warm-up time limit.
    expect(log).toEqual([
      "speak#0:one@60000",
      "speak#0:two@60000",
      "load#1",
      "speak#1:two@120000",
      "speak#1:three@60000",
      "speak#1:four@60000",
      "speak#1:five@60000",
      "speak#1:six@60000",
    ]);
    expect(w.stopped).toBe(false);
  });

  it("gives up after its restart budget, then fails fast", async () => {
    const { w, restarts } = setup(["a", "b", "c"], 1);
    await expect(w.speak("a", V, 1, 60_000)).resolves.toBeTruthy(); // restart 1, retry ok
    await expect(w.speak("b", V, 1, 60_000)).rejects.toThrow(/longer than/);
    expect(w.stopped).toBe(true);
    await expect(w.speak("d", V, 1, 60_000)).rejects.toThrow();
    expect(restarts).toHaveLength(1);
  });

  it("leaves failures of a still-running worker to the caller (no restart)", async () => {
    const log: string[] = [];
    let started = 0;
    const alive: VoiceWorker = {
      async loadVoice() {},
      async speak() {
        log.push("speak");
        throw new Error("unknown voice");
      },
      stopped: false,
      terminate() {},
    };
    const w = new RestartingVoiceWorker(alive, {
      start: () => (started++, alive),
      loadVoiceMs: 1,
      retrySpeechMs: 1,
    });
    await expect(w.speak("x", V, 1, 10)).rejects.toThrow("unknown voice");
    expect(started).toBe(0);
    expect(log).toEqual(["speak"]);
  });

  it("stops for good once the render finishes", async () => {
    const { w } = setup([]);
    w.terminate();
    expect(w.stopped).toBe(true);
    await expect(w.speak("x", V, 1, 10)).rejects.toThrow("render finished");
  });
});
