import {
  KOKORO_MODEL,
  KOKORO_VOICES,
  VENDOR_MODELS_BASE,
  type KokoroVoiceId,
} from "@avs/contracts";
import { configureModels } from "./models";

/**
 * Narration with Kokoro-82M (hexgrad/Kokoro-82M, Apache-2.0) running in the browser through
 * kokoro-js and ONNX Runtime Web. Free, no API key, no server time. The model (~92 MB, q8) is
 * downloaded once per browser and then served from its cache.
 */

export interface Speech {
  samples: Float32Array;
  sampleRate: number;
}

export interface Narrator {
  speak(text: string, voice: KokoroVoiceId, speed?: number): Promise<Speech>;
}

export const DEFAULT_VOICE: KokoroVoiceId = KOKORO_VOICES[0].id;
export const BACKUP_VOICE: KokoroVoiceId = KOKORO_VOICES[1].id;

let narrator: Promise<Narrator> | null = null;

/** Loads the voice model once per page. Rejects if the browser can't run it. */
export function loadNarrator(onProgress?: (fraction: number) => void): Promise<Narrator> {
  narrator ??= (async () => {
    const source = await configureModels(KOKORO_MODEL);
    if (source === "vendor") routeVoiceFiles();
    const { KokoroTTS } = await import("kokoro-js");
    const loaded = new Map<string, [number, number]>();
    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p: {
        status: string;
        file?: string;
        loaded?: number;
        total?: number;
      }) => {
        if (p.status !== "progress" || !p.file || !p.total) return;
        loaded.set(p.file, [p.loaded ?? 0, p.total]);
        let done = 0;
        let total = 0;
        for (const [d, t] of loaded.values()) {
          done += d;
          total += t;
        }
        onProgress?.(total > 0 ? done / total : 0);
      },
    });
    return {
      async speak(text, voice, speed = 1) {
        const audio = await tts.generate(text, { voice, speed });
        return { samples: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
      },
    } satisfies Narrator;
  })();
  narrator.catch(() => {
    narrator = null; // let a later render try again
  });
  return narrator;
}

const HF_VOICES = `https://huggingface.co/${KOKORO_MODEL}/resolve/main/voices/`;
let routed = false;

/**
 * kokoro-js fetches voice files from a fixed Hugging Face URL. Send those requests (and only
 * those) to our own /vendor/ copy instead.
 */
function routeVoiceFiles() {
  if (routed) return;
  routed = true;
  const original = globalThis.fetch.bind(globalThis);
  const local = `${globalThis.location?.origin ?? ""}${VENDOR_MODELS_BASE}/${KOKORO_MODEL}/voices/`;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(HF_VOICES)
      ? original(local + url.slice(HF_VOICES.length), init)
      : original(input, init);
  };
}

/** Speed that fits `spokenSeconds` of speech into `availableSeconds`, within natural limits. */
export function fitSpeed(spokenSeconds: number, availableSeconds: number): number {
  if (availableSeconds <= 0 || spokenSeconds <= availableSeconds) return 1;
  return Math.min(1.2, spokenSeconds / availableSeconds);
}
