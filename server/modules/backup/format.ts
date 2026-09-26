// The backup directory layout, shared by the server (which writes it) and scripts/operations.ts
// (which verifies and restores it):
//
//   <backupDir>/snapshots/<name>/relay.sqlite   scrubbed database copy
//   <backupDir>/snapshots/<name>/manifest.json  checksums of the database and every blob it references
//   <backupDir>/blobs/aa/bb/<sha256>            content-addressed pool shared by all snapshots
//
// A snapshot directory without the ".partial" suffix is complete: it is renamed into place last.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

export const MANIFEST_VERSION = 1;
export type BlobEntry = { sha256: string; size: number };
export type Manifest = {
  version: typeof MANIFEST_VERSION;
  name: string;
  created: number;
  database: BlobEntry;
  blobs: BlobEntry[];
};
export type SnapshotInspection = { database: BlobEntry; blobs: BlobEntry[]; workerThreadId: number };

export const DATABASE_FILE = "relay.sqlite";
export const MANIFEST_FILE = "manifest.json";
export const PARTIAL = ".partial";
const SHA256 = /^[0-9a-f]{64}$/;

export const snapshotsDir = (backupDir: string) => join(backupDir, "snapshots");
export const snapshotDir = (backupDir: string, name: string) => join(snapshotsDir(backupDir), name);
export const poolDir = (backupDir: string) => join(backupDir, "blobs");
/** The same aa/bb/sha layout as a data directory's blobs/. */
export const blobPath = (blobsDir: string, sha256: string) =>
  join(blobsDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);

export async function hashFile(file: string, signal?: AbortSignal): Promise<BlobEntry> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file, { signal }) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

/** Complete snapshots, oldest first (names sort by creation time). */
export function listSnapshots(backupDir: string): string[] {
  const dir = snapshotsDir(backupDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.endsWith(PARTIAL))
    .map((e) => e.name)
    .sort();
}

export function readManifest(backupDir: string, name: string): Manifest {
  try {
    const manifest = JSON.parse(readFileSync(join(snapshotDir(backupDir, name), MANIFEST_FILE), "utf8")) as Manifest;
    if (
      manifest.version !== MANIFEST_VERSION ||
      manifest.name !== name ||
      !Number.isSafeInteger(manifest.created) ||
      !validEntry(manifest.database) ||
      !Array.isArray(manifest.blobs) ||
      !manifest.blobs.every(validEntry)
    )
      throw new Error("invalid manifest fields");
    return manifest;
  } catch {
    throw new Error(`Snapshot ${name} has an unreadable manifest.`);
  }
}

function validEntry(entry: BlobEntry | undefined): entry is BlobEntry {
  return !!entry && SHA256.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size >= 0;
}

/** Scrubs and hashes the copied database in a worker, keeping VACUUM and large database reads off the server loop. */
export function scrubSnapshot(file: string, signal?: AbortSignal): Promise<SnapshotInspection> {
  return runSnapshotWorker(file, "scrub", signal);
}

function inspectSnapshotDatabase(file: string): Promise<SnapshotInspection> {
  return runSnapshotWorker(file, "inspect");
}

function runSnapshotWorker(file: string, mode: "scrub" | "inspect", signal?: AbortSignal) {
  return new Promise<SnapshotInspection>((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { file, mode } });
    let settled = false;
    let aborting = false;
    let workerExited = false;
    let terminationFailure: Error | null = null;
    const finish = (error?: Error, result?: SnapshotInspection) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => {
      if (aborting || settled) return;
      aborting = true;
      const error = signal?.reason instanceof Error ? signal.reason : new Error("The backup was cancelled.");
      void worker.terminate().then(
        () => finish(error),
        (terminateError: unknown) => {
          const detail = terminateError instanceof Error ? terminateError.message : String(terminateError);
          terminationFailure = new Error(`${error.message} Worker shutdown also failed: ${detail}`, { cause: error });
          if (workerExited || worker.threadId === -1) finish(terminationFailure);
        },
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { result?: SnapshotInspection; error?: string }) => {
      if (aborting) return;
      if (message.error) finish(new Error(message.error));
      else if (message.result) finish(undefined, message.result);
      else finish(new Error("The snapshot worker returned no result."));
    });
    worker.once("error", (error: Error) => {
      if (!aborting) finish(error);
    });
    worker.once("exit", (code) => {
      workerExited = true;
      if (aborting) {
        if (terminationFailure) finish(terminationFailure);
        return;
      }
      if (code !== 0) finish(new Error(`The snapshot worker exited with code ${code}.`));
      else if (!settled) finish(new Error("The snapshot worker exited before returning a result."));
    });
  });
}

/** Walks the aa/bb/sha files of a blob directory. */
export async function* poolFiles(blobsDir: string): AsyncGenerator<{ sha256: string; file: string }> {
  if (!existsSync(blobsDir)) return;
  for (const a of await readdir(blobsDir))
    if (/^[0-9a-f]{2}$/.test(a))
      for (const b of await readdir(join(blobsDir, a)))
        for (const sha256 of await readdir(join(blobsDir, a, b)))
          if (SHA256.test(sha256)) yield { sha256, file: join(blobsDir, a, b, sha256) };
}

/**
 * Checks a snapshot end to end: the database checksum and integrity, that the manifest lists exactly
 * the blobs the database references, and every pool blob's size and SHA-256. Throws on any problem.
 */
export async function verifySnapshot(backupDir: string, name: string): Promise<Manifest> {
  const manifest = readManifest(backupDir, name);
  const database = join(snapshotDir(backupDir, name), DATABASE_FILE);
  const inspection = await inspectSnapshotDatabase(database);
  const actual = inspection.database;
  if (actual.sha256 !== manifest.database.sha256 || actual.size !== manifest.database.size)
    throw new Error("The snapshot database does not match its checksum.");
  const listed = new Map(manifest.blobs.map((b) => [b.sha256, b.size]));
  if (inspection.blobs.length !== listed.size || inspection.blobs.some((b) => listed.get(b.sha256) !== b.size))
    throw new Error("The snapshot manifest does not match the database.");
  for (const blob of manifest.blobs) {
    const file = blobPath(poolDir(backupDir), blob.sha256);
    if (!existsSync(file)) throw new Error(`Stored file ${blob.sha256} is missing from the backup.`);
    const found = await hashFile(file);
    if (found.sha256 !== blob.sha256 || found.size !== blob.size)
      throw new Error(`Stored file ${blob.sha256} does not match its checksum.`);
  }
  return manifest;
}

/** Verifies the snapshot, then writes it as a fresh data directory. The destination must be empty. */
export async function restoreSnapshot(backupDir: string, name: string, destination: string): Promise<Manifest> {
  const manifest = await verifySnapshot(backupDir, name);
  if (existsSync(destination) && readdirSync(destination).length)
    throw new Error("The restore destination must be an empty directory.");
  await mkdir(destination, { recursive: true });
  await copyFile(
    join(snapshotDir(backupDir, name), DATABASE_FILE),
    join(destination, DATABASE_FILE),
    constants.COPYFILE_EXCL,
  );
  const blobs = join(destination, "blobs");
  for (const blob of manifest.blobs) {
    const target = blobPath(blobs, blob.sha256);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(blobPath(poolDir(backupDir), blob.sha256), target, constants.COPYFILE_EXCL);
  }
  return manifest;
}
