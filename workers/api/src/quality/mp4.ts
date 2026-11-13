/**
 * Minimal MP4 (ISO BMFF) reader: enough structure to quality-check a render without decoding it.
 * Reads through a random-access callback, so large files in R2 are inspected with small range reads.
 */

export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

export interface Mp4Track {
  kind: "video" | "audio" | "other";
  codec: string; // sample entry, e.g. "avc1", "mp4a"
  width?: number;
  height?: number;
  durationSeconds: number;
  sampleRate?: number;
  channels?: number;
}

export interface Mp4Info {
  brand: string;
  durationSeconds: number;
  /** moov before mdat: playback can start before the whole file downloads. */
  fastStart: boolean;
  hasMdat: boolean;
  tracks: Mp4Track[];
}

export class Mp4Error extends Error {}

interface Box {
  type: string;
  start: number; // offset of the box header
  headerSize: number;
  size: number; // whole box
}

const MAX_MOOV = 8 * 1024 * 1024;
const fourcc = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

async function topLevelBoxes(read: ReadAt, fileSize: number): Promise<Box[]> {
  const boxes: Box[] = [];
  let at = 0;
  while (at + 8 <= fileSize && boxes.length < 64) {
    const h = await read(at, 16);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = fourcc(h, 4);
    let headerSize = 8;
    if (size === 1) {
      if (h.length < 16) throw new Mp4Error("truncated 64-bit box header");
      size = Number(dv.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) size = fileSize - at;
    if (size < headerSize || at + size > fileSize + 8)
      throw new Mp4Error(`invalid box size for '${type}'`);
    boxes.push({ type, start: at, headerSize, size });
    at += size;
  }
  return boxes;
}

/** Children of a box inside an in-memory buffer. */
function children(buf: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = from;
  while (at + 8 <= to) {
    let size = dv.getUint32(at);
    const type = fourcc(buf, at + 4);
    let headerSize = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(at + 8));
      headerSize = 16;
    } else if (size === 0) size = to - at;
    if (size < headerSize || at + size > to) break;
    out.push({ type, start: at, headerSize, size });
    at += size;
  }
  return out;
}

const find = (buf: Uint8Array, box: Box, type: string) =>
  children(buf, box.start + box.headerSize, box.start + box.size).find((b) => b.type === type);

/** Reads a full box (version + flags), returning version and the payload offset. */
function fullBox(buf: Uint8Array, box: Box) {
  const o = box.start + box.headerSize;
  return { version: buf[o] ?? 0, payload: o + 4 };
}

function timescaleDuration(buf: Uint8Array, box: Box): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const { version, payload } = fullBox(buf, box);
  // v1: created(8) modified(8) timescale(4) duration(8); v0: created(4) modified(4) timescale(4) duration(4)
  const timescale = version === 1 ? dv.getUint32(payload + 16) : dv.getUint32(payload + 8);
  const duration =
    version === 1 ? Number(dv.getBigUint64(payload + 20)) : dv.getUint32(payload + 12);
  return timescale > 0 ? duration / timescale : 0;
}

function parseTrack(buf: Uint8Array, trak: Box): Mp4Track {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const mdia = find(buf, trak, "mdia");
  if (!mdia) return { kind: "other", codec: "", durationSeconds: 0 };
  const hdlr = find(buf, mdia, "hdlr");
  const handler = hdlr ? fourcc(buf, fullBox(buf, hdlr).payload + 4) : "";
  const mdhd = find(buf, mdia, "mdhd");
  const durationSeconds = mdhd ? timescaleDuration(buf, mdhd) : 0;
  const minf = find(buf, mdia, "minf");
  const stbl = minf ? find(buf, minf, "stbl") : undefined;
  const stsd = stbl ? find(buf, stbl, "stsd") : undefined;
  let codec = "";
  const track: Mp4Track = {
    kind: handler === "vide" ? "video" : handler === "soun" ? "audio" : "other",
    codec,
    durationSeconds,
  };
  if (stsd) {
    const first = stsd.start + stsd.headerSize + 8; // version/flags(4) + entry_count(4)
    codec = fourcc(buf, first + 4);
    track.codec = codec;
    const entry = first + 8; // after size + type
    if (track.kind === "video") {
      // VisualSampleEntry: reserved(6) dref(2) pre_defined/reserved(16) width(2) height(2)
      track.width = dv.getUint16(entry + 24);
      track.height = dv.getUint16(entry + 26);
    } else if (track.kind === "audio") {
      // AudioSampleEntry: reserved(6) dref(2) reserved(8) channels(2) samplesize(2) pre(2) res(2) rate(16.16)
      track.channels = dv.getUint16(entry + 16);
      track.sampleRate = dv.getUint32(entry + 24) >>> 16;
    }
  }
  return track;
}

export async function inspectMp4(read: ReadAt, fileSize: number): Promise<Mp4Info> {
  if (fileSize < 16) throw new Mp4Error("file is too small to be an MP4");
  const boxes = await topLevelBoxes(read, fileSize);
  const ftyp = boxes[0];
  if (!ftyp || ftyp.type !== "ftyp") throw new Mp4Error("file doesn't start with an 'ftyp' box");
  const brand = fourcc(await read(ftyp.start + ftyp.headerSize, 4), 0);
  const moovBox = boxes.find((b) => b.type === "moov");
  const mdat = boxes.find((b) => b.type === "mdat");
  if (!moovBox) throw new Mp4Error("missing 'moov' box (no track information)");
  if (moovBox.size > MAX_MOOV) throw new Mp4Error("'moov' box is unexpectedly large");
  const buf = await read(moovBox.start, moovBox.size);
  const moov: Box = { ...moovBox, start: 0 };
  const mvhd = find(buf, moov, "mvhd");
  const tracks = children(buf, moov.headerSize, moov.size)
    .filter((b) => b.type === "trak")
    .map((t) => parseTrack(buf, t));
  return {
    brand,
    durationSeconds: mvhd
      ? timescaleDuration(buf, mvhd)
      : Math.max(0, ...tracks.map((t) => t.durationSeconds)),
    fastStart: Boolean(mdat && moovBox.start < mdat.start),
    hasMdat: Boolean(mdat && mdat.size > mdat.headerSize),
    tracks,
  };
}

/** ReadAt over bytes already in memory. */
export const bytesReader =
  (b: Uint8Array): ReadAt =>
  async (offset, length) =>
    b.subarray(offset, Math.min(b.length, offset + length));

/** ReadAt over an R2 object, using ranged reads. */
export const r2Reader =
  (bucket: R2Bucket, key: string): ReadAt =>
  async (offset, length) => {
    const obj = await bucket.get(key, { range: { offset, length } });
    if (!obj) throw new Mp4Error("file is missing from storage");
    return new Uint8Array(await obj.arrayBuffer());
  };
