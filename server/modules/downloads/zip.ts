// A deterministic, uncompressed ZIP64 archive laid out from stored sizes and CRC32s. Every byte's
// position is known before any is sent, so the archive has a Content-Length and serves ranges.
// Every entry carries ZIP64 sizes (and the central directory ZIP64 offsets), so no field overflows.
import { crc32 } from "node:zlib";
import type { Segment } from "./serve.ts";

export type ZipEntry = {
  /** Path inside the archive, "/"-separated, without a trailing slash. */
  path: string;
  created: number;
} & ({ kind: "folder" } | { kind: "file"; size: number; crc32: number; file: string } | { kind: "text"; data: Buffer });

const VERSION = 45; // 4.5: ZIP64
const MADE_BY = (3 << 8) | VERSION; // Unix, so external attributes carry permissions
const UTF8 = 0x0800;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** MS-DOS date and time in UTC, clamped to the format's 1980–2107 range. */
function dosDateTime(ms: number) {
  const d = new Date(Math.min(Math.max(ms, Date.UTC(1980, 0, 1)), Date.UTC(2107, 11, 31, 23, 59, 58)));
  return {
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

class Writer {
  readonly buffer: Buffer;
  private at = 0;
  constructor(size: number) {
    this.buffer = Buffer.alloc(size);
  }
  u16(v: number) {
    this.at = this.buffer.writeUInt16LE(v, this.at);
    return this;
  }
  u32(v: number) {
    this.at = this.buffer.writeUInt32LE(v >>> 0, this.at);
    return this;
  }
  u64(v: number) {
    this.at = this.buffer.writeBigUInt64LE(BigInt(v), this.at);
    return this;
  }
  bytes(b: Buffer) {
    this.at += b.copy(this.buffer, this.at);
    return this;
  }
}

export function zipLayout(entries: ZipEntry[]): { segments: Segment[]; length: number } {
  const segments: Segment[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const push = (segment: Segment) => {
    segments.push(segment);
    offset += segment.length;
  };

  for (const entry of entries) {
    const name = Buffer.from(entry.kind === "folder" ? `${entry.path}/` : entry.path, "utf8");
    const size = entry.kind === "file" ? entry.size : entry.kind === "text" ? entry.data.length : 0;
    const crc = entry.kind === "file" ? entry.crc32 : entry.kind === "text" ? crc32(entry.data) : 0;
    const { date, time } = dosDateTime(entry.created);
    const headerOffset = offset;

    const local = new Writer(30 + name.length + 20)
      .u32(0x04034b50)
      .u16(VERSION)
      .u16(UTF8)
      .u16(0) // stored
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(U32_MAX)
      .u32(U32_MAX)
      .u16(name.length)
      .u16(20)
      .bytes(name)
      .u16(0x0001)
      .u16(16)
      .u64(size)
      .u64(size).buffer;
    push({ length: local.length, data: local });
    if (entry.kind === "file") push({ length: entry.size, file: entry.file });
    if (entry.kind === "text") push({ length: entry.data.length, data: entry.data });

    const mode = entry.kind === "folder" ? 0o40755 : 0o100644;
    central.push(
      new Writer(46 + name.length + 28)
        .u32(0x02014b50)
        .u16(MADE_BY)
        .u16(VERSION)
        .u16(UTF8)
        .u16(0)
        .u16(time)
        .u16(date)
        .u32(crc)
        .u32(U32_MAX)
        .u32(U32_MAX)
        .u16(name.length)
        .u16(28)
        .u16(0) // comment
        .u16(0) // disk
        .u16(0) // internal attributes
        .u32(((mode << 16) | (entry.kind === "folder" ? 0x10 : 0)) >>> 0)
        .u32(U32_MAX)
        .bytes(name)
        .u16(0x0001)
        .u16(24)
        .u64(size)
        .u64(size)
        .u64(headerOffset).buffer,
    );
  }

  const directory = Buffer.concat(central);
  const directoryOffset = offset;
  push({ length: directory.length, data: directory });
  const end64Offset = offset;
  const count = entries.length;
  const end = new Writer(56 + 20 + 22)
    // ZIP64 end of central directory record
    .u32(0x06064b50)
    .u64(44)
    .u16(MADE_BY)
    .u16(VERSION)
    .u32(0)
    .u32(0)
    .u64(count)
    .u64(count)
    .u64(directory.length)
    .u64(directoryOffset)
    // ZIP64 end of central directory locator
    .u32(0x07064b50)
    .u32(0)
    .u64(end64Offset)
    .u32(1)
    // End of central directory record; saturated fields defer to the ZIP64 record
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(Math.min(count, U16_MAX))
    .u16(Math.min(count, U16_MAX))
    .u32(Math.min(directory.length, U32_MAX))
    .u32(Math.min(directoryOffset, U32_MAX))
    .u16(0).buffer;
  push({ length: end.length, data: end });
  return { segments, length: offset };
}
