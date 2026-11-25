import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, urls } from "../shared/api.ts";
import { LIMITS } from "../shared/model.ts";
import { zipLayout, type ZipBody } from "../server/modules/downloads/zip.ts";
import { Client, member, openShare, patchUpload, send, start } from "./support/harness.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Opens the archive with Python's zipfile: CRC check of every member, names, and content hashes. */
function inspect(zip: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "relay-zip-"));
  try {
    const file = join(dir, "archive.zip");
    writeFileSync(file, zip);
    const script = `
import hashlib, json, struct, sys, zipfile
def modified(extra):
    at = 0
    while at + 4 <= len(extra):
        tag, size = struct.unpack_from("<HH", extra, at)
        if tag == 0x5455:
            return struct.unpack_from("<I", extra, at + 5)[0]
        at += 4 + size
    return None
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    infos = z.infolist()
    print(json.dumps({
        "bad": bad,
        "names": [i.filename for i in infos],
        "hashes": {i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in infos if not i.is_dir()},
        "dates": sorted({i.date_time[:3] for i in infos}),
        "stamps": {i.filename: [list(i.date_time), modified(i.extra)] for i in infos},
    }))`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", script, file], { maxBuffer: 64 * 1024 ** 2 }).toString(),
    ) as {
      bad: string | null;
      names: string[];
      hashes: Record<string, string>;
      dates: number[][];
      /** MS-DOS date and time fields, and the extended timestamp's seconds since 1970. */
      stamps: Record<string, [number[], number | null]>;
    };
    const unzip = spawnSync("unzip", ["-tqq", file]);
    return { ...result, unzip: unzip.error ? null : unzip.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fetchZip = async (client: Client, url: string, headers: Record<string, string> = {}) =>
  client.raw({ method: "GET", url, headers });

/** Bytes start..end of a laid-out archive. */
async function read(body: ZipBody, start: number, end = body.length - 1) {
  const parts: Buffer[] = [];
  for await (const chunk of body.chunks(start, end)) parts.push(chunk);
  return Buffer.concat(parts);
}

test("zipLayout keeps ZIP64 sizes and offsets above 4 GiB", async () => {
  const hugeSize = 0x1_0000_0000;
  const tail = Buffer.from("tail");
  const layout = zipLayout(
    [
      { path: "huge.bin", created: Date.UTC(2026, 0, 1), kind: "file", size: hugeSize, crc32: 0 },
      { path: "tail.txt", created: Date.UTC(2026, 0, 1), kind: "text", size: 0, crc32: null },
    ],
    (i) => (i === 0 ? { file: "/dev/null" } : { data: tail }),
  );
  assert(layout.length > hugeSize);

  // Only the headers are read; the 4 GiB file in between never is.
  const end = await read(layout, layout.length - 98);
  assert.equal(end.readUInt32LE(0), 0x06064b50);
  assert.equal(end.readBigUInt64LE(24), 2n);
  const directoryLength = Number(end.readBigUInt64LE(40));
  const directoryOffset = Number(end.readBigUInt64LE(48));
  assert.equal(end.readUInt32LE(56), 0x07064b50);
  assert.equal(end.readBigUInt64LE(64), BigInt(layout.length - 98));
  assert.equal(directoryOffset + directoryLength, layout.length - 98);
  const local = await read(layout, 0, 66);
  assert.equal(local.readUInt32LE(0), 0x04034b50);
  const tailLocal = await read(layout, local.length + hugeSize, local.length + hugeSize + 66);
  assert.equal(tailLocal.readUInt32LE(0), 0x04034b50);
  assert.equal(directoryOffset, local.length + hugeSize + tailLocal.length + tail.length);
  assert.deepEqual(await read(layout, directoryOffset - 4, directoryOffset - 1), tail);

  const central = await read(layout, directoryOffset, directoryOffset + directoryLength - 1);
  const centralEntry = (at: number) => {
    assert.equal(central.readUInt32LE(at), 0x02014b50);
    const nameLength = central.readUInt16LE(at + 28);
    const extraLength = central.readUInt16LE(at + 30);
    const name = central.subarray(at + 46, at + 46 + nameLength).toString();
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    let size: bigint | undefined;
    let offset: bigint | undefined;
    let modified: number | undefined;
    while (extraAt + 4 <= extraEnd) {
      const id = central.readUInt16LE(extraAt);
      const length = central.readUInt16LE(extraAt + 2);
      extraAt += 4;
      if (id === 1) {
        size = central.readBigUInt64LE(extraAt);
        assert.equal(central.readBigUInt64LE(extraAt + 8), size);
        offset = central.readBigUInt64LE(extraAt + 16);
      }
      if (id === 0x5455) modified = central.readUInt32LE(extraAt + 1);
      extraAt += length;
    }
    return { name, size, offset, modified, length: 46 + nameLength + extraLength };
  };
  const first = centralEntry(0);
  const second = centralEntry(first.length);
  assert.equal(first.length + second.length, directoryLength);
  assert.equal(first.name, "huge.bin");
  assert.equal(first.size, BigInt(hugeSize));
  assert.equal(first.offset, 0n);
  assert.equal(first.modified, Date.UTC(2026, 0, 1) / 1000);
  assert.equal(second.name, "tail.txt");
  assert.equal(second.size, 4n);
  assert.equal(second.offset, BigInt(local.length + hugeSize));
});

test("zipLayout: names stored before the name rules are written as they'd download, each unique in its folder", async () => {
  const text = Buffer.from("x");
  const entry = (path: string, kind: "folder" | "text" = "text") => ({
    path,
    created: Date.UTC(2026, 0, 1),
    kind,
    size: 0,
    crc32: null,
  });
  const entries = [
    entry("Reports", "folder"),
    // An override that shows "photo<U+202E>gpj.exe" as "photoexe.jpg", beside the name it cleans to.
    entry("Reports/photo\u202egpj.exe"),
    entry("Reports/photogpj.exe"),
    entry("old", "folder"),
    entry("Old\u202e", "folder"),
    entry("Old\u202e/a.txt"),
    entry("\u200b"),
    // Names that clean to "." or "..", or hold a backslash, which Windows tools read as a slash.
    entry(".\u200b.", "folder"),
    entry(".\u200b./x.txt"),
    entry("Reports/\u202e."),
    entry("..\\evil.txt"),
    // Names that clean to the same name in a folder that's cleaned too.
    entry("x    /y"),
    entry("x    /y\u200b"),
    // Spaces at the ends are taken off a folder's name and its contents' alike.
    entry("Docs ", "folder"),
    entry("Docs /a.txt"),
    // Control characters and a byte-order mark at the ends are cleaned too.
    entry("\tnotes.txt\t"),
    entry("\ufeffreport.pdf"),
  ];
  const zip = await read(
    zipLayout(entries, () => ({ data: text })),
    0,
  );
  const result = inspect(zip);
  assert.equal(result.bad, null);
  if (result.unzip !== null) assert.equal(result.unzip, 0);
  assert.deepEqual(result.names, [
    "Reports/",
    "Reports/photogpj (2).exe",
    "Reports/photogpj.exe",
    "old/",
    "Old (2)/",
    "Old (2)/a.txt",
    "Untitled",
    "Untitled (2)/",
    "Untitled (2)/x.txt",
    "Reports/Untitled",
    "..-evil.txt",
    "x/y",
    "x/y (2)",
    "Docs/",
    "Docs/a.txt",
    "notes.txt",
    "report.pdf",
  ]);
});

test("zipLayout: any range of an archive with a large directory is the same slice of the whole", async () => {
  const texts = Array.from({ length: 50 }, (_, i) => Buffer.from(`text ${i} `.repeat(i)));
  const entries = Array.from({ length: 3000 }, (_, i) => ({
    path: `folder ${String(i).padStart(4, "0")} ✓/${i % 60 < 50 ? "note.txt" : "sub"}`,
    created: Date.UTC(2026, 5, 1) + i * 1000,
    kind: i % 60 < 50 ? ("text" as const) : ("folder" as const),
    size: 0,
    crc32: null,
  }));
  const layout = zipLayout(entries, (i) => ({ data: texts[(i % 60) % 50] }));
  const whole = await read(layout, 0);
  assert.equal(whole.length, layout.length);
  const directoryOffset = Number(whole.readBigUInt64LE(whole.length - 98 + 48));
  assert.ok(whole.length - directoryOffset > 4 * 64 * 1024, "the directory spans several batches");
  const random = (below: number) => Math.floor(Math.random() * below);
  const ranges = [
    [0, 0],
    [directoryOffset - 1, directoryOffset + 1],
    [directoryOffset + 65_000, directoryOffset + 200_000],
    [whole.length - 99, whole.length - 1],
    ...Array.from({ length: 200 }, () => {
      const start = random(whole.length);
      return [start, start + random(Math.min(300_000, whole.length - start))];
    }),
  ];
  for (const [start, end] of ranges)
    assert.deepEqual(await read(layout, start, end), whole.subarray(start, end + 1), `${start}-${end}`);
});

test("item ZIP: folders, empty folders, text and Unicode names; valid for zipfile and unzip", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const big = randomBytes(300_000);
    const created = await client.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: client.tab,
        name: "Project files",
        text: "a note ✓",
        folders: ["Empty/Nested"],
        files: [
          { path: "src/main.ts", size: 11, mime: "" },
          { path: "src/assets/big.bin", size: big.length, mime: "" },
          { path: "Ünïcode ✓.txt", size: 3, mime: "" },
          { path: "empty.txt", size: 0, mime: "" },
        ],
      },
    });
    const bodies = [Buffer.from("console.log"), big, Buffer.from("abc"), Buffer.alloc(0)];
    for (const [i, upload] of created.uploads.entries())
      if (bodies[i].length) assert.equal((await patchUpload(client, upload.id, 0, bodies[i])).statusCode, 204);
    await client.call(api.transfers.complete, { params: { id: created.id }, body: { destination: { kind: "save" } } });
    // A pending file added later must not appear.
    await client.call(api.transfers.create, {
      body: {
        id: crypto.randomUUID(),
        tab: client.tab,
        name: null,
        folders: [],
        files: [{ path: "later.bin", size: 5, mime: "" }],
      },
    });

    const res = await fetchZip(client, urls.itemZip(created.itemId));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/zip");
    assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''Project%20files.zip");
    assert.equal(Number(res.headers["content-length"]), res.rawPayload.length);
    const zip = inspect(res.rawPayload);
    assert.equal(zip.bad, null);
    assert.deepEqual(zip.names, [
      "Empty/",
      "Empty/Nested/",
      "Text.txt",
      "empty.txt",
      "src/",
      "src/assets/",
      "src/assets/big.bin",
      "src/main.ts",
      "Ünïcode ✓.txt",
    ]);
    assert.equal(zip.hashes["src/assets/big.bin"], sha(big));
    assert.equal(zip.hashes["src/main.ts"], sha("console.log"));
    assert.equal(zip.hashes["Text.txt"], sha("a note ✓"));
    assert.equal(zip.hashes["empty.txt"], sha(""));
    const today = new Date();
    assert.deepEqual(zip.dates, [[today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()]]);
    if (zip.unzip !== null) assert.equal(zip.unzip, 0, "unzip -t");

    // Deterministic: the same contents give the same bytes and ETag.
    const again = await fetchZip(client, urls.itemZip(created.itemId));
    assert.equal(again.headers.etag, res.headers.etag);
    assert.deepEqual(again.rawPayload, res.rawPayload);

    // Ranges are exact slices of the full archive, including ones spanning several entries.
    const full = res.rawPayload;
    for (const [start, end] of [
      [0, 0],
      [0, 99],
      [25, 299_999],
      [full.length - 100, full.length - 1],
      [150_000, 150_010],
    ]) {
      const part = await fetchZip(client, urls.itemZip(created.itemId), { range: `bytes=${start}-${end}` });
      assert.equal(part.statusCode, 206);
      assert.equal(part.headers["content-range"], `bytes ${start}-${end}/${full.length}`);
      assert.deepEqual(part.rawPayload, full.subarray(start, end + 1), `${start}-${end}`);
    }
    const suffix = await fetchZip(client, urls.itemZip(created.itemId), { range: "bytes=-22" });
    assert.deepEqual(suffix.rawPayload, full.subarray(full.length - 22));
    const head = await client.raw({ method: "HEAD", url: urls.itemZip(created.itemId) });
    assert.equal(head.headers["content-length"], String(full.length));
    assert.equal(head.rawPayload.length, 0);
  } finally {
    await instance.close();
  }
});

test("folder ZIP is rooted at the folder's name and holds only its subtree", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const { result } = await send(client, [
      { path: "Outer/Inner/a.txt", data: "a" },
      { path: "Outer/Inner/Deeper/b.txt", data: "b" },
      { path: "Outer/c.txt", data: "c" },
      { path: "d.txt", data: "d" },
    ]);
    const inner = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.find(
      (n) => n.path === "Outer/Inner",
    )!;
    const res = await fetchZip(client, urls.itemZip(result.itemId, inner.id));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''Inner.zip");
    const zip = inspect(res.rawPayload);
    assert.equal(zip.bad, null);
    assert.deepEqual(zip.names, ["Inner/", "Inner/Deeper/", "Inner/Deeper/b.txt", "Inner/a.txt"]);
    assert.equal(zip.hashes["Inner/Deeper/b.txt"], sha("b"));

    const file = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.find(
      (n) => n.path === "d.txt",
    )!;
    assert.equal((await fetchZip(client, urls.itemZip(result.itemId, file.id))).statusCode, 404, "not a folder");
  } finally {
    await instance.close();
  }
});

test("a ZIP of 2,100 entries", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    // Most entries are empty, which skips their uploads: the ZIP is what's under test, and uploading
    // 2,100 files one by one took most of a minute.
    const data = (i: number) => (i % 100 === 0 ? `content ${i}` : "");
    const files = Array.from({ length: 2100 }, (_, i) => ({ path: `many/dir-${i % 10}/file-${i}.txt`, data: data(i) }));
    const { result } = await send(client, files);
    const res = await fetchZip(client, urls.itemZip(result.itemId));
    assert.equal(res.statusCode, 200);
    const zip = inspect(res.rawPayload);
    assert.equal(zip.bad, null);
    assert.equal(zip.names.length, 2100 + 11);
    assert.equal(Object.keys(zip.hashes).length, 2100);
    for (const i of [0, 777, 1500, 2099]) assert.equal(zip.hashes[`many/dir-${i % 10}/file-${i}.txt`], sha(data(i)));
    if (zip.unzip !== null) assert.equal(zip.unzip, 0, "unzip -t");
  } finally {
    await instance.close();
  }
});

test("item ZIP: an item with more entries than one transfer allows still downloads", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "large-zip-owner");
    const { result } = await send(client, [{ path: "seed.txt", data: "seed" }]);
    const owner = instance.ctx.db.value<string>("SELECT owner FROM items WHERE id = ?", result.itemId)!;
    // Items grow with every transfer added to them, so no per-transfer limit bounds an archive.
    const folders = LIMITS.foldersPerTransfer + 1;
    instance.ctx.db.run(
      `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
       INSERT INTO nodes(id, item, owner, parent, name, kind, state, size, mime, blob, text, created, position)
       SELECT lower(hex(randomblob(16))), ?, ?, NULL, printf('folder-%05d', n), 'folder', 'ready', 0, '', NULL, NULL,
         ?, n + 1 FROM seq`,
      folders,
      result.itemId,
      owner,
      Date.now(),
    );

    const response = await fetchZip(client, urls.itemZip(result.itemId));
    assert.equal(response.statusCode, 200);
    const zip = inspect(response.rawPayload);
    assert.equal(zip.bad, null);
    assert.equal(zip.names.length, folders + 1);
    assert.equal(zip.hashes["seed.txt"], sha("seed"));
  } finally {
    await instance.close();
  }
});

test("ZIP times: MS-DOS fields in the downloader's time zone, and an exact UTC timestamp for every entry", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "zone-owner");
    const { result } = await send(client, [{ path: "photos/a.txt", data: "alpha" }]);
    const created = Date.UTC(2026, 0, 15, 22, 30, 10);
    instance.ctx.db.run("UPDATE nodes SET created = ? WHERE item = ?", created, result.itemId);
    const stamps = async (tz?: string) => {
      const url = urls.itemZip(result.itemId) + (tz ? `?tz=${encodeURIComponent(tz)}` : "");
      const response = await fetchZip(client, url);
      assert.equal(response.statusCode, 200);
      return { zip: inspect(response.rawPayload), etag: response.headers.etag };
    };
    // Muscat is four hours ahead of UTC all year; Los Angeles is eight behind in January.
    const muscat = await stamps("Asia/Muscat");
    assert.deepEqual(muscat.zip.stamps["photos/a.txt"], [[2026, 1, 16, 2, 30, 10], created / 1000]);
    assert.deepEqual(muscat.zip.stamps["photos/"], [[2026, 1, 16, 2, 30, 10], created / 1000]);
    const angeles = await stamps("America/Los_Angeles");
    assert.deepEqual(angeles.zip.stamps["photos/a.txt"], [[2026, 1, 15, 14, 30, 10], created / 1000]);
    assert.notEqual(angeles.etag, muscat.etag, "a resumed download never mixes two zones");
    // Without a zone Relay knows, the MS-DOS fields are UTC.
    for (const tz of [undefined, "Not/AZone", "x".repeat(100)])
      assert.deepEqual((await stamps(tz)).zip.stamps["photos/a.txt"], [[2026, 1, 15, 22, 30, 10], created / 1000]);
  } finally {
    await instance.close();
  }
});

// Working out a ZIP checks every file on disk. A HEAD, a resumed download or a download manager's
// ranges must not repeat that each time, or a link holder can make the server do it at will.
test("a ZIP is worked out once and reused until the item changes", async () => {
  const instance = await start();
  try {
    const client = await member(instance, "tia");
    const { result } = await send(
      client,
      [
        { path: "Photos/a.txt", data: "alpha" },
        { path: "Photos/b.txt", data: "bravo" },
        { path: "c.txt", data: "charlie" },
      ],
      { text: "a note" },
    );
    const link = await client.call(api.links.create, {
      body: { id: crypto.randomUUID(), item: result.itemId, days: 7 },
    });
    const visitor = new Client(instance);
    await openShare(visitor, link.token);
    const blobs = instance.ctx.blobs as { verify: (...args: unknown[]) => Promise<unknown> };
    const verify = blobs.verify.bind(blobs);
    let checked = 0;
    blobs.verify = (...args) => {
      checked++;
      return verify(...args);
    };
    const head = (url: string) => visitor.raw({ method: "HEAD", url });

    // Asked for many times at once, it's worked out once.
    const first = await Promise.all(Array.from({ length: 5 }, () => head(urls.shareZip(link.token))));
    assert.ok(first.every((res) => res.statusCode === 200));
    assert.equal(checked, 3, "each file checked once");
    const length = first[0].headers["content-length"];

    // Later HEADs, ranges and other time zones reuse it: a zone moves only times inside headers.
    for (let i = 0; i < 5; i++) assert.equal((await head(urls.shareZip(link.token))).statusCode, 200);
    const ranged = await fetchZip(visitor, urls.shareZip(link.token, undefined, "Asia/Tokyo"), {
      range: "bytes=0-99",
    });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers["content-range"], `bytes 0-99/${length}`);
    assert.notEqual(ranged.headers.etag, first[0].headers.etag, "another zone is another archive");
    const whole = await fetchZip(visitor, urls.shareZip(link.token));
    assert.equal(whole.rawPayload.length, Number(length));
    const zip = inspect(whole.rawPayload);
    assert.equal(zip.bad, null);
    assert.equal(zip.hashes["c.txt"], sha("charlie"));
    assert.equal(zip.hashes["Text.txt"], sha("a note"));
    assert.equal(checked, 3);

    // A folder is its own archive.
    const photos = (await client.call(api.items.get, { params: { id: result.itemId } })).nodes.find(
      (n) => n.path === "Photos",
    )!;
    assert.equal((await head(urls.shareZip(link.token, photos.id))).statusCode, 200);
    assert.equal(checked, 5);

    // New contents are a new archive.
    await send(client, [{ path: "d.txt", data: "delta" }], { item: result.itemId });
    const grown = await head(urls.shareZip(link.token));
    assert.ok(Number(grown.headers["content-length"]) > Number(length));
    assert.equal(checked, 9);

    // So is a stored copy found damaged since: nobody is handed an archive that can't finish.
    const blob = instance.ctx.db.value<string>(
      "SELECT blob FROM nodes WHERE item = ? AND name = 'a.txt'",
      result.itemId,
    )!;
    instance.ctx.db.run("UPDATE blobs SET integrity = 'missing' WHERE sha256 = ?", blob);
    assert.equal((await head(urls.shareZip(link.token))).statusCode, 503);
  } finally {
    await instance.close();
  }
});
