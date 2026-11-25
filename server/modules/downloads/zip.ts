// A deterministic, uncompressed ZIP64 archive laid out from stored sizes and CRC32s. Every byte's
// position is known before any is sent, so the archive has a Content-Length and serves ranges.
// Every entry carries ZIP64 sizes (and the central directory ZIP64 offsets), so no field overflows.
//
// Headers are written as they are sent rather than kept, so an archive costs a few numbers per
// entry: an item of any size can be downloaded without holding its whole directory in memory.
import { createReadStream } from "node:fs";
import { crc32 } from "node:zlib";
import { cleanFileName } from "../../../shared/text.ts";

export type ZipEntry = {
  /** Path inside the archive, "/"-separated, without a trailing slash. */
  path: string;
  created: number;
  kind: "folder" | "file" | "text";
  /** Stored size of a file, or a text's byte length when its CRC32 is given; ignored for folders. */
  size: number;
  /** Stored CRC32 of a file. A text without one is read when the archive is laid out, to measure it. */
  crc32: number | null;
};
/** Where a file's or text's bytes come from. Asked for again whenever those bytes are sent. */
export type ZipContent = { file: string } | { data: Buffer };
export type ZipBody = {
  length: number;
  /** Bytes start..end, inclusive. */
  chunks(start: number, end: number): AsyncGenerator<Buffer>;
};
/**
 * Where every byte of an archive goes, worked out once. The time zone changes only the MS-DOS times
 * inside headers, never a length or an offset, so a body in any zone costs nothing more.
 */
export type ZipPlan = {
  length: number;
  body(timeZone: string | null): ZipBody;
};

const VERSION = 45; // 4.5: ZIP64
const MADE_BY = (3 << 8) | VERSION; // Unix, so external attributes carry permissions
const UTF8 = 0x0800;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
// ZIP64 (sizes; the central record adds the offset) and an extended timestamp in UTC (0x5455),
// which unzip, macOS, 7-Zip and Python prefer to the time-zone-less MS-DOS fields.
const LOCAL_EXTRA = 20 + 9;
const CENTRAL_EXTRA = 28 + 9;
const END_LENGTH = 56 + 20 + 22;
const DIRECTORY_CHUNK = 64 * 1024;

/** The IANA time zone name, if this server knows it; MS-DOS times are written in it. */
export function validTimeZone(name: unknown): string | null {
  if (typeof name !== "string" || !name || name.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Shifts a time so its UTC fields read as the wall clock in `timeZone` (UTC when null). */
function wallClock(timeZone: string | null): (ms: number) => number {
  if (!timeZone) return (ms) => ms;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  // Offsets change at most every quarter hour, and an archive's files tend to share a few.
  const offsets = new Map<number, number>();
  return (ms) => {
    const quarter = Math.floor(ms / 900_000);
    let offset = offsets.get(quarter);
    if (offset === undefined) {
      const at = quarter * 900_000;
      const part = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, Number(p.value)]));
      offset = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - at;
      offsets.set(quarter, offset);
    }
    return ms + offset;
  };
}

/** MS-DOS date and time from a shifted time's UTC fields, clamped to the format's 1980–2107 range. */
function dosDateTime(ms: number) {
  const d = new Date(Math.min(Math.max(ms, Date.UTC(1980, 0, 1)), Date.UTC(2107, 11, 31, 23, 59, 58)));
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return ((date << 16) | time) >>> 0;
}

class Writer {
  readonly buffer: Buffer;
  at = 0;
  constructor(size: number) {
    this.buffer = Buffer.alloc(size);
  }
  u8(v: number) {
    this.at = this.buffer.writeUInt8(v, this.at);
    return this;
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

/** The last index whose start is at or before `at`, in an ascending array of starts. */
function partAt(starts: Float64Array, count: number, at: number) {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= at) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * A path that an unzip tool could place outside the folder it unzips into, or that names its own
 * folder: one starting with a slash, with an empty, "." or ".." part, or with a backslash, which
 * Windows tools read as a slash.
 */
const OUTSIDE = /^\/|\/$|\/\/|(?:^|\/)\.{1,2}(?:\/|$)|\\/;

/** The most bytes a name may have on the file systems people unzip onto. */
const MAX_NAME_BYTES = 255;
/** Characters Windows can't hold in a name. */
const WINDOWS_CHARACTERS = /[<>:"|?*]/g;
/** Names Windows keeps for devices, whatever follows a dot: "CON", "nul.txt", "COM1.tar.gz". */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?=\s*(?:\.|$))/i;

/**
 * `name` with `suffix` before its extension (folders have none), shortened before the suffix and
 * extension, never within a character, to fit MAX_NAME_BYTES.
 */
function fitted(name: string, suffix: string, folder: boolean) {
  if (!suffix && name.length <= MAX_NAME_BYTES / 3) return name;
  const dot = folder ? -1 : name.lastIndexOf(".");
  // An "extension" longer than any real one is part of the name, so it can be shortened too.
  const split = dot > 0 && Buffer.byteLength(name.slice(dot)) <= 32;
  const extension = split ? name.slice(dot) : "";
  let stem = split ? name.slice(0, dot) : name;
  const room = MAX_NAME_BYTES - Buffer.byteLength(suffix + extension);
  let bytes = Buffer.byteLength(stem);
  if (bytes > room) {
    const characters = [...stem];
    while (bytes > room) bytes -= Buffer.byteLength(characters.pop()!);
    // Windows drops dots and spaces at the end of a name.
    stem = characters.join("").replace(/[. ]+$/, "");
  }
  return stem + suffix + extension;
}

/**
 * How a name in a ZIP is compared with the others in its folder: as macOS and Windows do, ignoring
 * case (in every script, not only ASCII) and how accented letters are put together.
 */
const folded = (path: string) =>
  /^[\x20-\x7e]*$/.test(path) ? path.toLowerCase() : path.toUpperCase().toLowerCase().normalize("NFC");

/**
 * One stored name as written: cleaned as a downloaded file's is; never "", ".", ".." or a slash;
 * holding nothing Windows can't (a reserved device name, `< > : " | ? *`, a dot or space at the
 * end); and at most MAX_NAME_BYTES long. These rewrites are only inside ZIPs: the files keep their names.
 */
function writtenName(name: string) {
  const clean = cleanFileName(name)
    .replace(/[/\\]/g, "-")
    .replace(WINDOWS_CHARACTERS, "-")
    .replace(/[. ]+$/, "")
    .replace(WINDOWS_DEVICE, "$&_");
  return fitted(clean || "Untitled", "", false);
}

/**
 * The paths that must be written differently, by entry. Names stored before Relay's name rules may
 * hide what they are (a direction override showing "…gpj.exe" as "…exe.jpg", 50 spaces before
 * ".exe"), and an unzip tool shows them as they are; others are fine here but can't be unzipped on
 * Windows; and two names Relay keeps apart ("É.txt" and "é.txt") can land on one file on macOS or
 * Windows. Each name in a path is written as `writtenName` says, so a folder's new name carries over
 * to everything inside it. Paths that need no change keep their place first, in the archive's
 * order; a path that would land on one before it in its folder, ignoring case and how its letters
 * are put together, gets a number, kept within MAX_NAME_BYTES. Nothing may put an entry outside its
 * folder when unzipped: a name that is, or cleans to, "." or ".." or nothing is written "Untitled",
 * and a slash or backslash "-". Null when nothing needs it, as for nearly every archive.
 */
function cleanedPaths(entries: readonly ZipEntry[]): Map<number, string> | null {
  const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  const leafOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  // Folded paths already written, whether as stored or changed.
  const taken = new Set<string>();
  // Whether a path, and every folder above it, is written as stored.
  const asStored = new Map<string, boolean>();
  const stored = (path: string): boolean => {
    let known = asStored.get(path);
    if (known === undefined) {
      // The folders above are judged first, so each one written as stored claims its place first.
      const above = !path.includes("/") || stored(parentOf(path));
      const key = folded(path);
      known = above && writtenName(leafOf(path)) === leafOf(path) && !taken.has(key);
      if (known) taken.add(key);
      asStored.set(path, known);
    }
    return known;
  };
  const changed = entries.flatMap((entry, i) => (stored(entry.path) ? [] : [i]));
  if (!changed.length) return null;
  // Each original path (a folder's, or an entry's) and what it's written as; and for each changed
  // path, the next number to try, so many names cleaning to one don't each count up from 2.
  const written = new Map<string, string>();
  const next = new Map<string, number>();
  const write = (path: string, folder: boolean): string => {
    if (stored(path)) return path;
    let result = written.get(path);
    if (result !== undefined) return result;
    const into = path.includes("/") ? `${write(parentOf(path), true)}/` : "";
    const clean = writtenName(leafOf(path));
    result = into + clean;
    const key = folded(result);
    if (taken.has(key)) {
      let n = next.get(key) ?? 2;
      while (taken.has(folded((result = into + fitted(clean, ` (${n})`, folder))))) n++;
      next.set(key, n + 1);
    }
    taken.add(folded(result));
    written.set(path, result);
    return result;
  };
  const paths = new Map<number, string>();
  for (const i of changed) paths.set(i, write(entries[i].path, entries[i].kind === "folder"));
  return paths;
}

export function zipLayout(
  entries: readonly ZipEntry[],
  content: (index: number) => ZipContent,
  timeZone: string | null = null,
): ZipBody {
  return zipPlan(entries, content).body(timeZone);
}

export function zipPlan(entries: readonly ZipEntry[], content: (index: number) => ZipContent): ZipPlan {
  const count = entries.length;
  const nameLength = new Uint32Array(count);
  const sizes = new Float64Array(count);
  const crcs = new Uint32Array(count);
  const seconds = new Uint32Array(count);
  // Where each entry's local header starts, and where its record starts within the directory.
  const headerAt = new Float64Array(count + 1);
  const recordAt = new Float64Array(count + 1);
  const cleaned = cleanedPaths(entries);
  const pathOf = (i: number) => cleaned?.get(i) ?? entries[i].path;
  // Whatever the names, no entry may land outside the folder the archive is unzipped into.
  if (cleaned)
    for (const path of cleaned.values()) if (OUTSIDE.test(path)) throw new Error("An archive path escapes its folder.");
  let offset = 0;
  let directory = 0;
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    const path = pathOf(i);
    nameLength[i] = Buffer.byteLength(path) + (entry.kind === "folder" ? 1 : 0);
    if (nameLength[i] > U16_MAX) throw new Error(`A path in this archive is too long: ${path.slice(0, 80)}…`);
    if (entry.kind === "text" && entry.crc32 === null) {
      const { data } = content(i) as { data: Buffer };
      sizes[i] = data.length;
      crcs[i] = crc32(data);
    } else if (entry.kind !== "folder") {
      sizes[i] = entry.size;
      crcs[i] = entry.crc32 ?? 0;
    }
    // The extended timestamp is a signed 32-bit count of seconds since 1970, in UTC.
    seconds[i] = Math.min(Math.max(Math.floor(entry.created / 1000), 0), 0x7fffffff);
    headerAt[i] = offset;
    offset += 30 + nameLength[i] + LOCAL_EXTRA + sizes[i];
    recordAt[i] = directory;
    directory += 46 + nameLength[i] + CENTRAL_EXTRA;
  }
  headerAt[count] = offset;
  recordAt[count] = directory;
  const directoryStart = offset;
  const endStart = directoryStart + directory;
  const length = endStart + END_LENGTH;
  return { length, body: (timeZone) => zipBody(timeZone) };

  function zipBody(timeZone: string | null): ZipBody {
    // Written as each header goes out: a body costs nothing until bytes are asked for.
    const shift = wallClock(timeZone);
    const stamp = (i: number) => dosDateTime(shift(entries[i].created));
    const name = (i: number) => Buffer.from(entries[i].kind === "folder" ? `${pathOf(i)}/` : pathOf(i), "utf8");
    const timestamp = (w: Writer, i: number) => w.u16(0x5455).u16(5).u8(1).u32(seconds[i]);
    const localHeader = (i: number) => {
      const dos = stamp(i);
      const w = new Writer(30 + nameLength[i] + LOCAL_EXTRA)
        .u32(0x04034b50)
        .u16(VERSION)
        .u16(UTF8)
        .u16(0) // stored
        .u16(dos & 0xffff)
        .u16(dos >>> 16)
        .u32(crcs[i])
        .u32(U32_MAX)
        .u32(U32_MAX)
        .u16(nameLength[i])
        .u16(LOCAL_EXTRA)
        .bytes(name(i))
        .u16(0x0001)
        .u16(16)
        .u64(sizes[i])
        .u64(sizes[i]);
      return timestamp(w, i).buffer;
    };
    const centralRecord = (w: Writer, i: number) => {
      const folder = entries[i].kind === "folder";
      const mode = folder ? 0o40755 : 0o100644;
      const dos = stamp(i);
      w.u32(0x02014b50)
        .u16(MADE_BY)
        .u16(VERSION)
        .u16(UTF8)
        .u16(0)
        .u16(dos & 0xffff)
        .u16(dos >>> 16)
        .u32(crcs[i])
        .u32(U32_MAX)
        .u32(U32_MAX)
        .u16(nameLength[i])
        .u16(CENTRAL_EXTRA)
        .u16(0) // comment
        .u16(0) // disk
        .u16(0) // internal attributes
        .u32(((mode << 16) | (folder ? 0x10 : 0)) >>> 0)
        .u32(U32_MAX)
        .bytes(name(i))
        .u16(0x0001)
        .u16(24)
        .u64(sizes[i])
        .u64(sizes[i])
        .u64(headerAt[i]);
      timestamp(w, i);
    };
    const endRecord = () =>
      new Writer(END_LENGTH)
        // ZIP64 end of central directory record
        .u32(0x06064b50)
        .u64(44)
        .u16(MADE_BY)
        .u16(VERSION)
        .u32(0)
        .u32(0)
        .u64(count)
        .u64(count)
        .u64(directory)
        .u64(directoryStart)
        // ZIP64 end of central directory locator
        .u32(0x07064b50)
        .u32(0)
        .u64(endStart)
        .u32(1)
        // End of central directory record; saturated fields defer to the ZIP64 record
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(Math.min(count, U16_MAX))
        .u16(Math.min(count, U16_MAX))
        .u32(Math.min(directory, U32_MAX))
        .u32(Math.min(directoryStart, U32_MAX))
        .u16(0).buffer;

    async function* chunks(start: number, end: number) {
      // The part of [partStart, partStart + part.length) that falls inside start..end.
      const clip = (part: Buffer, partStart: number) =>
        part.subarray(Math.max(start - partStart, 0), Math.min(end - partStart + 1, part.length));
      if (start < directoryStart) {
        for (let i = partAt(headerAt, count, start); i < count && headerAt[i] <= end; i++) {
          const header = localHeader(i);
          if (headerAt[i] + header.length > start) yield clip(header, headerAt[i]);
          const dataStart = headerAt[i] + header.length;
          if (!sizes[i] || dataStart + sizes[i] <= start || dataStart > end) continue;
          const from = Math.max(start - dataStart, 0);
          const to = Math.min(end - dataStart, sizes[i] - 1);
          const source = content(i);
          if ("data" in source) yield source.data.subarray(from, to + 1);
          else yield* createReadStream(source.file, { start: from, end: to }) as AsyncIterable<Buffer>;
        }
      }
      if (end >= directoryStart && start < endStart) {
        // Records go out in batches, starting from the one that holds `start`.
        let i = partAt(recordAt, count, Math.max(start - directoryStart, 0));
        while (i < count && directoryStart + recordAt[i] <= end) {
          const first = i;
          let size = 0;
          while (i < count && (size === 0 || size + recordAt[i + 1] - recordAt[i] <= DIRECTORY_CHUNK)) {
            size += recordAt[i + 1] - recordAt[i];
            i++;
          }
          const w = new Writer(size);
          for (let j = first; j < i; j++) centralRecord(w, j);
          yield clip(w.buffer, directoryStart + recordAt[first]);
        }
      }
      if (end >= endStart) yield clip(endRecord(), endStart);
    }

    return { length, chunks };
  }
}
