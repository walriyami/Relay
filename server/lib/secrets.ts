import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CODE_LENGTH, formatCode } from "../../shared/codes.ts";
import { fsyncDirectory } from "../storage/files.ts";
import { fail } from "./errors.ts";
import type { PickupCodeKind } from "./pickup-codes.ts";

export { formatCode, normalizeCode } from "../../shared/codes.ts";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 ** 2 };

/**
 * Tests only: makes new password hashes cheap (about 2 ms instead of about 70 ms of CPU). Tests sign in
 * hundreds of times, so the production cost made up most of the suite's CPU time. Each hash records its
 * own cost, so verifying works either way. Nothing in the server calls this.
 */
export function useTestPasswordCost() {
  SCRYPT.N = 2 ** 10;
}

// One scrypt uses about 32 MiB. Limit active derivations and bound the wait list so a distributed
// burst at public setup/join/sign-in endpoints cannot turn into unbounded native work and memory.
// Browsers an account has signed in on before have a wait list of their own and go first, so a
// flood of strangers' guesses can't keep the account's owner out.
const MAX_ACTIVE_SCRYPT = 2;
const MAX_QUEUED_SCRYPT = 32;
const MAX_QUEUED_PRIORITY = 16;
let activeScrypt = 0;
const scryptQueue: Array<() => void> = [];
const priorityQueue: Array<() => void> = [];

async function withScrypt<T>(work: () => Promise<T>, priority = false): Promise<T> {
  if (activeScrypt >= MAX_ACTIVE_SCRYPT) {
    const queue = priority ? priorityQueue : scryptQueue;
    if (queue.length >= (priority ? MAX_QUEUED_PRIORITY : MAX_QUEUED_SCRYPT))
      fail(429, "Password service is busy. Try again shortly.");
    await new Promise<void>((resolve) => queue.push(resolve));
  } else {
    activeScrypt++;
  }

  try {
    return await work();
  } finally {
    const next = priorityQueue.shift() ?? scryptQueue.shift();
    if (next) next();
    else activeScrypt--;
  }
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** A fresh 256-bit bearer secret (session, invite, grant, CSRF). */
export const randomToken = () => randomBytes(32).toString("base64url");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = await withScrypt(() => scrypt(password.normalize("NFKC"), salt, 32, SCRYPT));
  return `scrypt$${SCRYPT.N}$${salt}$${key.toString("base64url")}`;
}
/** `priority` is for a browser the account has signed in on before. */
export async function verifyPassword(password: string, encoded: string, { priority = false } = {}): Promise<boolean> {
  const [scheme, n, salt, key] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await withScrypt(
    () =>
      scrypt(password.normalize("NFKC"), salt, expected.length, {
        ...SCRYPT,
        N: Number(n),
      }),
    priority,
  );
  return timingSafeEqual(actual, expected);
}
/** Compare against this when the account does not exist, so timing does not reveal usernames. */
export const dummyPasswordHash = () =>
  `scrypt$${SCRYPT.N}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

/** At least 32 visible characters, as RELAY_SECRET; a generated key is 43. */
const SECRET_KEY = /^[\x21-\x7e]{32,}$/;

export class SecretKeyInvalid extends Error {
  readonly code = "RELAY_SECRET_KEY_INVALID";
  constructor() {
    super(
      "Relay's key file (secret.key in the data folder) is empty or damaged, so Relay has stopped rather than " +
        "use a key anyone could guess. If you have a backup of the data folder, put its secret.key back. " +
        "Otherwise delete secret.key and start Relay again to make a new key: every file stays, but links, " +
        "requests, invitations and codes handed out before stop working and have to be shared again.",
    );
  }
}

/** Writes a new key in full before it appears under its name, so a crash can't leave it empty. */
function createKeyFile(dataRoot: string, file: string) {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      writeFileSync(fd, `${randomBytes(32).toString("base64url")}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A link, unlike a rename, never replaces a key that is already there.
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
  fsyncDirectory(dataRoot);
}

/**
 * Derives the bearer secrets of links and upload requests from their ids with a server key, so
 * the database holds only hashes, while the owner can still be shown the link. The key comes from
 * RELAY_SECRET, or from <data>/secret.key created on first start. Moving the data to another key
 * leaves the content intact but invalidates existing links.
 */
export class Secrets {
  private readonly key: Buffer;
  constructor(dataRoot: string, configured?: string) {
    if (configured) {
      if (configured.length < 32) throw new Error("RELAY_SECRET must be at least 32 characters.");
      this.key = Buffer.from(configured);
      return;
    }
    const file = join(dataRoot, "secret.key");
    if (!existsSync(file)) createKeyFile(dataRoot, file);
    const key = readFileSync(file, "utf8").trim();
    // An empty or cut-short key would let anyone work out every link and request token from its id.
    // Making a new one would silently break every link already handed out, so the owner decides.
    if (!SECRET_KEY.test(key)) throw new SecretKeyInvalid();
    this.key = Buffer.from(key);
  }
  private mac(purpose: string, id: string) {
    return createHmac("sha256", this.key).update(`${purpose}:${id}`).digest();
  }
  linkToken(linkId: string) {
    return this.mac("link", linkId).toString("base64url");
  }
  requestToken(requestId: string) {
    return this.mac("request", requestId).toString("base64url");
  }
  inviteToken(inviteId: string) {
    return this.mac("invite", inviteId).toString("base64url");
  }
  nearbyToken(inviteId: string) {
    return this.mac("nearby", inviteId).toString("base64url");
  }
  /**
   * Vouches that an account signed in on one browser (`browser` is random, made at that sign-in)
   * while its password hash was `passwordHash`, so a new password forgets it (see `rememberBrowser`).
   */
  knownBrowserMac(userId: string, browser: string, passwordHash: string) {
    return this.mac("known-browser", `${userId}\n${browser}\n${passwordHash}`).toString("base64url").slice(0, 32);
  }
  /** A database-safe, purpose-separated digest for a low-entropy numeric pickup code. */
  pickupCodeHash(digits: string) {
    return `hmac-sha256:${this.mac("pickup-code", digits).toString("hex")}`;
  }
  /**
   * Names a session to Relay's local socket. The helper attaches it to every request it forwards
   * for a browser that set up its connection with that session; browsers never see it. It lasts as
   * long as the session does.
   */
  localToken(sessionHash: string) {
    return `${sessionHash}.${this.mac("local-session", sessionHash).toString("base64url")}`;
  }
  /** The session hash a local token names, or null when the token is not one of ours. */
  localSession(token: unknown): string | null {
    if (typeof token !== "string") return null;
    const [hash, mac, extra] = token.split(".");
    if (extra !== undefined || !/^[0-9a-f]{64}$/.test(hash) || !mac) return null;
    const expected = this.mac("local-session", hash);
    const actual = Buffer.from(mac, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? hash : null;
  }
  /** Stable sign-in URL secret for a pending device code; unlike the numeric code, this never rotates. */
  deviceToken(codeId: string) {
    return this.mac("device-code-link", codeId).toString("base64url");
  }
  pickupCode(linkId: string, nonce = 0) {
    return this.code("pickup", linkId, nonce);
  }
  requestPickupCode(requestId: string, nonce = 0) {
    return this.code("request-pickup", requestId, nonce);
  }
  invitePickupCode(inviteId: string, nonce = 0) {
    return this.code("invite-pickup", inviteId, nonce);
  }
  devicePickupCode(codeId: string, nonce = 0) {
    return this.code("device-pickup", codeId, nonce);
  }
  nearbyPickupCode(inviteId: string, nonce = 0) {
    return this.code("nearby-pickup", inviteId, nonce);
  }
  pickupCodeFor(kind: PickupCodeKind, id: string, nonce = 0) {
    switch (kind) {
      case "share":
        return this.pickupCode(id, nonce);
      case "request":
        return this.requestPickupCode(id, nonce);
      case "invitation":
        return this.invitePickupCode(id, nonce);
      case "device":
        return this.devicePickupCode(id, nonce);
      case "nearby":
        return this.nearbyPickupCode(id, nonce);
    }
  }
  private code(purpose: string, id: string, nonce: number) {
    const length = CODE_LENGTH;
    if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce >= 10 ** length)
      throw new Error("Invalid numeric pickup-code nonce.");
    const size = 10 ** length;
    // The length is part of the sequence's name, as it was when four-digit codes existed too.
    const start = this.mac(`${purpose}-${length}-start`, id).readUIntBE(0, 6) % size;
    let stride = this.mac(`${purpose}-${length}-stride`, id).readUIntBE(0, 6) % size || 1;
    // A coprime stride walks every value in the finite namespace exactly once.
    while (greatestCommonDivisor(stride, size) !== 1) stride = (stride % (size - 1)) + 1;
    const digits = String((start + nonce * stride) % size).padStart(length, "0");
    return formatCode(digits);
  }
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
