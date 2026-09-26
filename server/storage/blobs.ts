import { existsSync, linkSync, mkdirSync } from "node:fs";
import { link, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore, Context } from "../context.ts";
import { fsyncDirectory, unlinkIfPresent } from "./files.ts";

const SHA = /^[0-9a-f]{64}$/;
/** Renditions (`<sha>-s.webp`, `<sha>-l.webp`) and the marker of an image that cannot be rendered. */
const THUMBNAIL_FILE = /^([0-9a-f]{64})(-[sl]\.webp|\.failed)$/;
export type ThumbnailSize = "s" | "l";
export const thumbnailPath = (root: string, sha256: string, size: ThumbnailSize) =>
  join(root, "thumbnails", `${sha256}-${size}.webp`);
export const thumbnailFailure = (root: string, sha256: string) => join(root, "thumbnails", `${sha256}.failed`);

export function createBlobStore(ctx: Context): BlobStore {
  const root = join(ctx.config.root, "blobs");

  const path = (sha256: string) => join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  const recorded = (sha256: string) => !!ctx.db.get("SELECT 1 FROM blobs WHERE sha256 = ?", sha256);

  const removeFiles = (sha256: string) => {
    unlinkIfPresent(path(sha256));
    unlinkIfPresent(thumbnailPath(ctx.config.root, sha256, "s"));
    unlinkIfPresent(thumbnailPath(ctx.config.root, sha256, "l"));
    unlinkIfPresent(thumbnailFailure(ctx.config.root, sha256));
  };

  return {
    path,

    async stage(file, sha256) {
      if (!SHA.test(sha256)) throw new Error("Invalid blob hash.");
      const target = path(sha256);
      const directory = dirname(target);
      const created = await mkdir(directory, { recursive: true });
      let linked = false;
      try {
        await link(file, target);
        linked = true;
      } catch (error) {
        // Content addressing: an existing file under this name holds the same bytes.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        if (created) for (const dir of [root, dirname(directory)]) await fsyncDirectory(dir, true);
        await fsyncDirectory(directory, true);
      } catch (error) {
        if (linked && !recorded(sha256)) unlinkIfPresent(target);
        throw error;
      }
    },

    unstage(sha256) {
      if (!recorded(sha256)) removeFiles(sha256);
    },

    adopt(file, sha256, size, crc32) {
      if (!SHA.test(sha256)) throw new Error("Invalid blob hash.");
      const target = path(sha256);
      let linked = false;
      try {
        if (!existsSync(target)) {
          const directory = dirname(target);
          const created = mkdirSync(directory, { recursive: true });
          linkSync(file, target);
          linked = true;
          if (created) for (const dir of [root, dirname(directory)]) fsyncDirectory(dir);
          fsyncDirectory(directory);
        }
        ctx.db.run(
          "INSERT INTO blobs(sha256, size, crc32, created) VALUES(?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING",
          sha256,
          size,
          crc32,
          Date.now(),
        );
      } catch (error) {
        if (linked && !recorded(sha256)) unlinkIfPresent(target);
        throw error;
      }
    },

    collect(candidates) {
      const removed: string[] = [];
      ctx.db.tx(() => {
        for (const sha256 of new Set(candidates)) {
          if (ctx.db.get("SELECT 1 FROM nodes WHERE blob = ? LIMIT 1", sha256)) continue;
          if (ctx.db.run("DELETE FROM blobs WHERE sha256 = ?", sha256).changes) removed.push(sha256);
        }
      });
      for (const sha256 of removed) removeFiles(sha256);
    },

    async reconcile() {
      const known = new Set(ctx.db.all<{ sha256: string }>("SELECT sha256 FROM blobs").map((r) => r.sha256));
      const found = new Set<string>();
      let removedFiles = 0;
      const remove = async (file: string) => {
        await unlink(file);
        removedFiles++;
      };
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        const name = entry.name;
        if (SHA.test(name) && entry.parentPath === dirname(path(name)) && known.has(name)) found.add(name);
        else await remove(join(entry.parentPath, name));
      }
      // Thumbnails of blobs that no longer exist, and renditions interrupted mid-write.
      const thumbnails = join(ctx.config.root, "thumbnails");
      for (const name of await readdir(thumbnails)) {
        const match = THUMBNAIL_FILE.exec(name);
        if (!match || !known.has(match[1])) await remove(join(thumbnails, name));
      }
      return { removedFiles, missing: [...known].filter((sha256) => !found.has(sha256)) };
    },
  };
}
