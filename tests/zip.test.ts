import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, urls } from "../shared/api.ts";
import { zipLayout } from "../server/modules/downloads/zip.ts";
import { type Client, member, patchUpload, send, start } from "./support/harness.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Opens the archive with Python's zipfile: CRC check of every member, names, and content hashes. */
function inspect(zip: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "relay-zip-"));
  try {
    const file = join(dir, "archive.zip");
    writeFileSync(file, zip);
    const script = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    infos = z.infolist()
    print(json.dumps({
        "bad": bad,
        "names": [i.filename for i in infos],
        "hashes": {i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in infos if not i.is_dir()},
        "dates": sorted({i.date_time[:3] for i in infos}),
    }))`;
    const result = JSON.parse(
      execFileSync("python3", ["-c", script, file], { maxBuffer: 64 * 1024 ** 2 }).toString(),
    ) as {
      bad: string | null;
      names: string[];
      hashes: Record<string, string>;
      dates: number[][];
    };
    const unzip = spawnSync("unzip", ["-tqq", file]);
    return { ...result, unzip: unzip.error ? null : unzip.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fetchZip = async (client: Client, url: string, headers: Record<string, string> = {}) =>
  client.raw({ method: "GET", url, headers });

test("zipLayout keeps ZIP64 sizes and offsets above 4 GiB", () => {
  const hugeSize = 0x1_0000_0000;
  const layout = zipLayout([
    { path: "huge.bin", created: Date.UTC(2026, 0, 1), kind: "file", size: hugeSize, crc32: 0, file: "/dev/null" },
    { path: "tail.txt", created: Date.UTC(2026, 0, 1), kind: "text", data: Buffer.from("tail") },
  ]);
  assert(layout.length > hugeSize);

  const local = layout.segments[0];
  const tailLocal = layout.segments[2];
  const tailData = layout.segments[3];
  const central = layout.segments[4];
  const end = layout.segments[5];
  assert("data" in local && "data" in tailLocal && "data" in tailData && "data" in central && "data" in end);
  assert.equal(local.data.readUInt32LE(0), 0x04034b50);
  assert.equal(tailLocal.data.readUInt32LE(0), 0x04034b50);
  assert.equal(central.data.readUInt32LE(0), 0x02014b50);

  const centralEntry = (at: number) => {
    assert.equal(central.data.readUInt32LE(at), 0x02014b50);
    const nameLength = central.data.readUInt16LE(at + 28);
    const extraLength = central.data.readUInt16LE(at + 30);
    const name = central.data.subarray(at + 46, at + 46 + nameLength).toString();
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    let size: bigint | undefined;
    let offset: bigint | undefined;
    while (extraAt + 4 <= extraEnd) {
      const id = central.data.readUInt16LE(extraAt);
      const length = central.data.readUInt16LE(extraAt + 2);
      extraAt += 4;
      if (id === 1) {
        size = central.data.readBigUInt64LE(extraAt);
        assert.equal(central.data.readBigUInt64LE(extraAt + 8), size);
        offset = central.data.readBigUInt64LE(extraAt + 16);
      }
      extraAt += length;
    }
    return { name, size, offset, length: 46 + nameLength + extraLength };
  };
  const first = centralEntry(0);
  const second = centralEntry(first.length);
  assert.equal(first.name, "huge.bin");
  assert.equal(first.size, BigInt(hugeSize));
  assert.equal(first.offset, 0n);
  assert.equal(second.name, "tail.txt");
  assert.equal(second.size, 4n);
  assert.equal(second.offset, BigInt(local.data.length + hugeSize));

  const directoryOffset = BigInt(local.data.length + hugeSize + tailLocal.data.length + tailData.data.length);
  assert.equal(end.data.readUInt32LE(0), 0x06064b50);
  assert.equal(end.data.readBigUInt64LE(24), 2n);
  assert.equal(end.data.readBigUInt64LE(40), BigInt(central.data.length));
  assert.equal(end.data.readBigUInt64LE(48), directoryOffset);
  assert.equal(end.data.readUInt32LE(56), 0x07064b50);
  assert.equal(end.data.readBigUInt64LE(64), BigInt(layout.length - end.data.length));
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
    const files = Array.from({ length: 2100 }, (_, i) => ({
      path: `many/dir-${i % 10}/file-${i}.txt`,
      data: `content ${i}`,
    }));
    const { result } = await send(client, files);
    const res = await fetchZip(client, urls.itemZip(result.itemId));
    assert.equal(res.statusCode, 200);
    const zip = inspect(res.rawPayload);
    assert.equal(zip.bad, null);
    assert.equal(zip.names.length, 2100 + 11);
    assert.equal(Object.keys(zip.hashes).length, 2100);
    for (const i of [0, 777, 2099]) assert.equal(zip.hashes[`many/dir-${i % 10}/file-${i}.txt`], sha(`content ${i}`));
    if (zip.unzip !== null) assert.equal(zip.unzip, 0, "unzip -t");
  } finally {
    await instance.close();
  }
});
