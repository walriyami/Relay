// Filesystem steps shared by blob storage and uploads.
import { closeSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

export function unlinkIfPresent(path: string) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/** Makes directory entries durable; async mode keeps upload publication off the event loop. */
export function fsyncDirectory(path: string): void;
export function fsyncDirectory(path: string, async: true): Promise<void>;
export function fsyncDirectory(path: string, async = false): void | Promise<void> {
  if (async)
    return open(path, "r").then(async (handle) => {
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Directories listed at once by `eachFile`: enough to overlap storage latency, not flood libuv. */
const LIST_PARALLEL = 16;

/**
 * Calls `visit` with every entry under `root` that is not a directory, at any depth. Each directory's
 * entries are visited synchronously as soon as it is listed. The recursive `readdir` lists one
 * directory at a time, which made a restart over 100,000 stored files take three times as long.
 */
export function eachFile(root: string, visit: (directory: string, name: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // Depth first, so the directories still to list stay few however wide the tree is.
    const waiting = [root];
    let listing = 0;
    let failed = false;
    const fail = (error: Error) => {
      failed = true;
      reject(error);
    };
    const next = () => {
      if (failed) return;
      if (!waiting.length && !listing) return resolve();
      while (listing < LIST_PARALLEL && waiting.length) {
        const directory = waiting.pop()!;
        listing++;
        readdir(directory, { withFileTypes: true })
          .then((entries) => {
            listing--;
            if (failed) return;
            for (const entry of entries)
              if (entry.isDirectory()) waiting.push(join(directory, entry.name));
              else visit(directory, entry.name);
            next();
          })
          .catch(fail);
      }
    };
    next();
  });
}
