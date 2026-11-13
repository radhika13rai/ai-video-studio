/**
 * Identifies media from its bytes. Live testing showed Workers AI documents PNG but returns JPEG
 * for SDXL, and MP3 but returns WAV for MeloTTS, so the declared type is never trusted.
 */
export interface Sniffed {
  mime_type: string;
  extension: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
}

const ascii = (b: Uint8Array, from: number, len: number) =>
  String.fromCharCode(...b.subarray(from, from + len));

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1] ?? 0;
    const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xc3)
      return {
        height: ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0),
        width: ((b[i + 7] ?? 0) << 8) | (b[i + 8] ?? 0),
      };
    i += 2 + len;
  }
  return undefined;
}

export function sniffMedia(b: Uint8Array): Sniffed | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { mime_type: "image/jpeg", extension: "jpg", ...jpegSize(b) };
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG")
    return {
      mime_type: "image/png",
      extension: "png",
      width: dv.getUint32(16),
      height: dv.getUint32(20),
    };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP")
    return { mime_type: "image/webp", extension: "webp" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") {
    // Walk chunks for fmt (byte rate) and data (length) to get the duration.
    let i = 12;
    let byteRate = 0;
    let dataLen = 0;
    while (i + 8 <= b.length) {
      const id = ascii(b, i, 4);
      const size = dv.getUint32(i + 4, true);
      if (id === "fmt ") byteRate = dv.getUint32(i + 16, true);
      if (id === "data") {
        dataLen = Math.min(size, b.length - i - 8);
        break;
      }
      i += 8 + size + (size % 2);
    }
    return {
      mime_type: "audio/wav",
      extension: "wav",
      ...(byteRate > 0 ? { duration_seconds: Math.round((dataLen / byteRate) * 100) / 100 } : {}),
    };
  }
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))
    return { mime_type: "audio/mpeg", extension: "mp3" };
  return null;
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Normalizes the many shapes an AI binding can return binary data in. */
export async function toBytes(value: unknown, base64Key?: string): Promise<Uint8Array | null> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof ReadableStream)
    return new Uint8Array(await new Response(value).arrayBuffer());
  if (value instanceof Response) return new Uint8Array(await value.arrayBuffer());
  if (base64Key && typeof value === "object" && value !== null) {
    const v = (value as Record<string, unknown>)[base64Key];
    if (typeof v === "string" && v.length > 0) return base64ToBytes(v);
  }
  return null;
}
