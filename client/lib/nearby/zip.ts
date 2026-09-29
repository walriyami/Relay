// A stored (uncompressed) ZIP of files already received, for saving a whole transfer at once on a
// computer. Photos and videos are compressed already, so storing costs nothing, and the archive is
// assembled from the received files themselves without copying them. ZIP64 records are added where
// sizes or offsets pass 4 GiB.

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 of `bytes`, continuing from `previous` (the CRC of what came before). */
export function crc32(bytes: Uint8Array, previous = 0) {
  let c = ~previous;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export type ZipEntry = { path: string; file: Blob; crc: number; modified: number };

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const encoder = new TextEncoder();

function dosTime(time: number) {
  const d = new Date(time);
  // DOS dates start in 1980.
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** The archive of `entries` and `folders` (folders holding no file still appear). */
export function zip(entries: ZipEntry[], folders: string[] = []): Blob {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const withFiles = new Set(entries.flatMap((e) => ancestors(e.path)));
  const records = [
    ...folders
      .filter((f) => !withFiles.has(f))
      .map((f) => ({ path: `${f}/`, file: null, crc: 0, modified: Date.now() })),
    ...entries,
  ];
  for (const entry of records) {
    const name = encoder.encode(entry.path);
    const size = entry.file?.size ?? 0;
    const big = size >= MAX32;
    const { time, date } = dosTime(entry.modified);
    // Local header: sizes in a ZIP64 field when they don't fit.
    const local = new DataView(new ArrayBuffer(30 + name.length + (big ? 20 : 0)));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, big ? 45 : 20, true);
    local.setUint16(6, 0x0800, true); // Names are UTF-8.
    local.setUint16(8, 0, true); // Stored.
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, entry.crc, true);
    local.setUint32(18, big ? MAX32 : size, true);
    local.setUint32(22, big ? MAX32 : size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, big ? 20 : 0, true);
    new Uint8Array(local.buffer).set(name, 30);
    if (big) {
      const at = 30 + name.length;
      local.setUint16(at, 0x0001, true);
      local.setUint16(at + 2, 16, true);
      local.setBigUint64(at + 4, BigInt(size), true);
      local.setBigUint64(at + 12, BigInt(size), true);
    }
    parts.push(local.buffer);
    if (entry.file) parts.push(entry.file);
    // Central record: whatever doesn't fit goes in its ZIP64 field, in this order.
    const far = offset >= MAX32;
    const extra = (big ? 16 : 0) + (far ? 8 : 0);
    const record = new DataView(new ArrayBuffer(46 + name.length + (extra ? 4 + extra : 0)));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 45, true);
    record.setUint16(6, big || far ? 45 : 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, entry.crc, true);
    record.setUint32(20, big ? MAX32 : size, true);
    record.setUint32(24, big ? MAX32 : size, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, extra ? 4 + extra : 0, true);
    record.setUint32(38, entry.file ? 0 : 0x10, true); // Folders carry the directory attribute.
    record.setUint32(42, far ? MAX32 : offset, true);
    new Uint8Array(record.buffer).set(name, 46);
    if (extra) {
      let at = 46 + name.length;
      record.setUint16(at, 0x0001, true);
      record.setUint16(at + 2, extra, true);
      at += 4;
      if (big) {
        record.setBigUint64(at, BigInt(size), true);
        record.setBigUint64(at + 8, BigInt(size), true);
        at += 16;
      }
      if (far) record.setBigUint64(at, BigInt(offset), true);
    }
    central.push(new Uint8Array(record.buffer));
    offset += local.byteLength + size;
  }
  const start = offset;
  const length = central.reduce((n, r) => n + r.byteLength, 0);
  parts.push(...central.map((r) => r.buffer as ArrayBuffer));
  const count = records.length;
  if (count >= MAX16 || start >= MAX32 || length >= MAX32) {
    const end64 = new DataView(new ArrayBuffer(56 + 20));
    end64.setUint32(0, 0x06064b50, true);
    end64.setBigUint64(4, 44n, true);
    end64.setUint16(12, 45, true);
    end64.setUint16(14, 45, true);
    end64.setBigUint64(24, BigInt(count), true);
    end64.setBigUint64(32, BigInt(count), true);
    end64.setBigUint64(40, BigInt(length), true);
    end64.setBigUint64(48, BigInt(start), true);
    // The locator, pointing back at the record above.
    end64.setUint32(56, 0x07064b50, true);
    end64.setBigUint64(64, BigInt(start + length), true);
    end64.setUint32(72, 1, true);
    parts.push(end64.buffer);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Math.min(count, MAX16), true);
  end.setUint16(10, Math.min(count, MAX16), true);
  end.setUint32(12, Math.min(length, MAX32), true);
  end.setUint32(16, Math.min(start, MAX32), true);
  parts.push(end.buffer);
  return new Blob(parts, { type: "application/zip" });
}

/** "a/b/c.txt" → ["a", "a/b"]. */
function ancestors(path: string) {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
