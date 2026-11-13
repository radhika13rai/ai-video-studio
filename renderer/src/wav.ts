/** Encodes planar float audio as 16-bit PCM WAV (what FFmpeg reads to make AAC). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + frames * numCh * 2);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + frames * numCh * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numCh * 2, true);
  dv.setUint16(32, numCh * 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, frames * numCh * 2, true);
  let o = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return bytes;
}
