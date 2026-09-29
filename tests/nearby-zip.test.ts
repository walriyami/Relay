// The archive Nearby saves a whole transfer as: standard, and read back exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { crc32, zip, type ZipEntry } from "../client/lib/nearby/zip.ts";

/** Each central directory record's name and whether it says the name is UTF-8. */
function names(archive: Buffer) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const found: { name: string; utf8: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const length = archive.readUInt16LE(at + 28);
    found.push({
      name: archive.toString("utf8", at + 46, at + 46 + length),
      utf8: (archive.readUInt16LE(at + 8) & 0x0800) !== 0,
    });
    at += 46 + length + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return found;
}

test("crc32 matches zlib's, whole or in pieces", () => {
  const data = randomBytes(100_003);
  assert.equal(crc32(data), zlibCrc32(data));
  assert.equal(crc32(data.subarray(40_000), crc32(data.subarray(0, 40_000))), zlibCrc32(data));
  assert.equal(crc32(new Uint8Array()), 0);
});

test("an archive of files and folders that unzip checks and reads back", async (t) => {
  let unzip = true;
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
  } catch {
    unzip = false;
  }
  if (!unzip) return t.skip("unzip isn't installed");
  // "Trip" holds files, so only the empty folder gets a record of its own.
  const files = new Map([
    ["Trip/IMG_0001.jpg", randomBytes(70_000)],
    ["Trip/Day 2/Café – notes.txt".normalize("NFC"), Buffer.from("déjà vu\n")],
    ["empty.bin", Buffer.alloc(0)],
  ]);
  const entries: ZipEntry[] = [...files].map(([path, data]) => ({
    path,
    file: new Blob([data]),
    crc: crc32(data),
    modified: Date.UTC(2026, 8, 29, 10, 30),
  }));
  const archive = Buffer.from(await zip(entries, ["Trip", "Trip/Empty"]).arrayBuffer());
  assert.deepEqual(
    names(archive),
    ["Trip/Empty/", ...files.keys()].map((name) => ({ name, utf8: true })),
  );
  const dir = await mkdtemp(join(tmpdir(), "relay-zip-"));
  try {
    const path = join(dir, "transfer.zip");
    await writeFile(path, archive);
    // Every CRC and size checks out.
    execFileSync("unzip", ["-tq", path]);
    // Some unzips ignore the UTF-8 flag when naming what they extract, so only ASCII names are
    // looked up; the CRC check above already covers the rest.
    for (const [name, data] of files)
      if (/^[\x20-\x7e]+$/.test(name)) assert.deepEqual(execFileSync("unzip", ["-p", path, name]), data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
