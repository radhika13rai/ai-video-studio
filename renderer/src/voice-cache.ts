/**
 * Kokoro narration cached in the browser (IndexedDB), keyed by text, voice and speed (ADR 046).
 * The live preview voices a scene once; the export (and later previews) reuse it instead of
 * running the model again. Every operation fails soft: without IndexedDB (private windows,
 * tests) the cache is simply empty.
 */

export interface CachedSpeech {
  samples: Float32Array;
  sampleRate: number;
}

export interface VoiceCache {
  get(key: string): Promise<CachedSpeech | null>;
  put(key: string, speech: CachedSpeech): Promise<void>;
}

/** A stable key for one spoken line (SHA-256 of voice, speed and text). */
export async function speechKey(text: string, voice: string, speed: number): Promise<string> {
  const data = new TextEncoder().encode(`v1|${voice}|${speed.toFixed(3)}|${text.trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DB = "avs-voice-cache";
const STORE = "speech";
/** Keep the cache small on phones: the oldest lines are dropped past this many. */
export const MAX_CACHED_LINES = 200;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

let shared: VoiceCache | null = null;

export function browserVoiceCache(): VoiceCache {
  shared ??= (() => {
    const db = open();
    return {
      async get(key) {
        const d = await db;
        if (!d) return null;
        try {
          const tx = d.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(key);
          const v = await new Promise<unknown>((resolve) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
          });
          const s = v as { samples?: Float32Array; sampleRate?: number } | null;
          return s?.samples instanceof Float32Array && typeof s.sampleRate === "number"
            ? { samples: s.samples, sampleRate: s.sampleRate }
            : null;
        } catch {
          return null;
        }
      },
      async put(key, speech) {
        const d = await db;
        if (!d) return;
        try {
          const tx = d.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          store.put({ ...speech, at: Date.now() }, key);
          const count = store.count();
          count.onsuccess = () => {
            if (count.result <= MAX_CACHED_LINES) return;
            // Drop the oldest entries.
            const all = store.openCursor();
            const rows: { key: IDBValidKey; at: number }[] = [];
            all.onsuccess = () => {
              const c = all.result;
              if (c) {
                rows.push({ key: c.key, at: (c.value as { at?: number }).at ?? 0 });
                c.continue();
                return;
              }
              rows.sort((a, b) => a.at - b.at);
              for (const r of rows.slice(0, rows.length - MAX_CACHED_LINES)) store.delete(r.key);
            };
          };
          await txDone(tx);
        } catch {
          // Quota or blocked storage: the voice is still used, just not cached.
        }
      },
    } satisfies VoiceCache;
  })();
  return shared;
}

/** For tests and environments without IndexedDB. */
export function memoryVoiceCache(): VoiceCache & { size: () => number } {
  const m = new Map<string, CachedSpeech>();
  return {
    size: () => m.size,
    get: async (k) => m.get(k) ?? null,
    put: async (k, s) => void m.set(k, s),
  };
}
