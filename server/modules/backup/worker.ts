// CPU and synchronous SQLite work for snapshot preparation and verification.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, threadId, workerData } from "node:worker_threads";
import type { BlobEntry, SnapshotInspection } from "./format.ts";

type Request = { file: string; mode: "scrub" | "inspect" };

async function hashFile(file: string): Promise<BlobEntry> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

function snapshotBlobs(file: string, mode: Request["mode"]): BlobEntry[] {
  const db = mode === "inspect" ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
  try {
    if (mode === "scrub") {
      db.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA foreign_keys = ON;
        BEGIN;
        DELETE FROM login_codes;
        DELETE FROM sessions;
        DELETE FROM guest_grants;
        DELETE FROM uploads;
        DELETE FROM transfers;
        DELETE FROM tabs;
        DELETE FROM nodes WHERE state = 'pending';
        DELETE FROM items WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE nodes.item = items.id);
        DELETE FROM blobs WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE nodes.blob = blobs.sha256);
        COMMIT;
        VACUUM;
      `);
    } else {
      const integrity = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
        throw new Error("The snapshot database failed its integrity check.");
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("The snapshot database has broken references.");
    }
    return db
      .prepare("SELECT sha256, size FROM blobs WHERE sha256 IN (SELECT blob FROM nodes) ORDER BY sha256")
      .all() as BlobEntry[];
  } finally {
    db.close();
  }
}

async function syncDatabase(file: string) {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  if (isMainThread || !parentPort) throw new Error("Snapshot work must run in a worker thread.");
  const { file, mode } = workerData as Request;
  const blobs = snapshotBlobs(file, mode);
  if (mode === "scrub") await syncDatabase(file);
  const database = await hashFile(file);
  const result: SnapshotInspection = { database, blobs, workerThreadId: threadId };
  parentPort.postMessage({ result });
}

void main().catch((error: unknown) => {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
});
