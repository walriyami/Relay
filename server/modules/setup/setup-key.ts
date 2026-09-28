import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fsyncDirectory } from "../../storage/files.ts";

const KEY = /^[A-Za-z0-9_-]{43}$/;

export const setupKeyPath = (root: string) => join(root, "setup.key");

/** Creates the first-admin credential once, durably, with owner-only permissions. */
export function ensureSetupKey(root: string): string {
  const path = setupKeyPath(root);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isFile() && !info.isSymbolicLink()) {
      const key = readFileSync(path, "utf8").trim();
      if (KEY.test(key)) {
        chmodSync(path, 0o600);
        return key;
      }
    }
    // An interrupted first write can leave an incomplete file before startup ever printed its
    // location. Rotate that unusable value so setup remains recoverable.
    unlinkSync(path);
    fsyncDirectory(root);
  }

  const key = randomBytes(32).toString("base64url");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, `${key}\n`);
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(root);
  return key;
}

export function hasSetupKey(root: string, candidate: string): boolean {
  const path = setupKeyPath(root);
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) return false;
  const expected = readFileSync(path, "utf8").trim();
  if (!KEY.test(expected)) return false;
  const supplied = Buffer.from(candidate);
  const stored = Buffer.from(expected);
  return supplied.length === stored.length && timingSafeEqual(supplied, stored);
}

export function removeSetupKey(root: string) {
  const path = setupKeyPath(root);
  try {
    unlinkSync(path);
    fsyncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
