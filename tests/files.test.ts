import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { eachFile } from "../server/storage/files.ts";

test("every file at every depth is visited once, with the directory that holds it", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-walk-"));
  try {
    const expected = new Set<string>([join(root, "top")]);
    writeFileSync(join(root, "top"), "");
    for (let a = 0; a < 40; a++)
      for (let b = 0; b < 3; b++) {
        const directory = join(root, `a${a}`, `b${b}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "file"), "");
        expected.add(join(directory, "file"));
      }
    writeFileSync(join(root, "a0", "middle"), "");
    expected.add(join(root, "a0", "middle"));
    mkdirSync(join(root, "empty"));

    const seen: string[] = [];
    await eachFile(root, (directory, name) => seen.push(join(directory, name)));
    assert.equal(seen.length, expected.size);
    assert.deepEqual(new Set(seen), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that cannot be listed fails the walk", async () => {
  await assert.rejects(
    eachFile(join(tmpdir(), `relay-missing-${crypto.randomUUID()}`), () => {}),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});
