// Filesystem steps shared by blob storage and uploads.
import { closeSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";

export function unlinkIfPresent(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
