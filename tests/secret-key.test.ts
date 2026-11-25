import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets } from "../server/lib/secrets.ts";

test("secret.key: made once, in full and private, then reused", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-secret-"));
  try {
    const first = new Secrets(root).linkToken("link-id");
    const key = readFileSync(join(root, "secret.key"), "utf8");
    assert.match(key, /^[A-Za-z0-9_-]{43}\n$/);
    assert.equal(statSync(join(root, "secret.key")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(root), ["secret.key"], "no temporary file left behind");
    assert.equal(new Secrets(root).linkToken("link-id"), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret.key: an empty or short key stops startup instead of being used or replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-secret-"));
  try {
    for (const damaged of ["", "\n", "short-key\n", `${"a".repeat(20)} ${"b".repeat(20)}\n`]) {
      writeFileSync(join(root, "secret.key"), damaged);
      assert.throws(
        () => new Secrets(root),
        (error: Error & { code?: string }) =>
          error.code === "RELAY_SECRET_KEY_INVALID" && /secret\.key/.test(error.message),
      );
      assert.equal(readFileSync(join(root, "secret.key"), "utf8"), damaged, "the file is left for the owner");
    }
    // A link to a key that's gone is explained the same way, not replaced or shown as a stack trace.
    rmSync(join(root, "secret.key"));
    symlinkSync(join(root, "gone.key"), join(root, "secret.key"));
    assert.throws(() => new Secrets(root), { code: "RELAY_SECRET_KEY_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
