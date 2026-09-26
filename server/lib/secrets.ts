import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CODE_LENGTH, formatCode, type CodeLength } from "../../shared/codes.ts";

export { formatCode, normalizeCode } from "../../shared/codes.ts";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 ** 2 };

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** A fresh 256-bit bearer secret (session, invite, grant, CSRF). */
export const randomToken = () => randomBytes(32).toString("base64url");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(password.normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt}$${key.toString("base64url")}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, n, salt, key] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
    ...SCRYPT,
    N: Number(n),
  });
  return timingSafeEqual(actual, expected);
}
/** Compare against this when the account does not exist, so timing does not reveal usernames. */
export const DUMMY_PASSWORD_HASH = "scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Derives the bearer secrets of links and upload requests from their ids with a server key, so
 * the database (and its backups) hold only hashes, while the owner can still be shown the link.
 * The key comes from RELAY_SECRET, or from <data>/secret.key created on first start. Restoring a
 * backup with a different key leaves the content intact but invalidates existing links.
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
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
    this.key = Buffer.from(readFileSync(file, "utf8").trim());
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
  /** A database-safe, purpose-separated digest for a low-entropy numeric pickup code. */
  pickupCodeHash(digits: string) {
    return `hmac-sha256:${this.mac("pickup-code", digits).toString("hex")}`;
  }
  /** Stable sign-in URL secret for a pending device code; unlike the numeric code, this never rotates. */
  deviceToken(codeId: string) {
    return this.mac("device-code-link", codeId).toString("base64url");
  }
  pickupCode(linkId: string, nonce = 0, length: CodeLength = DEFAULT_CODE_LENGTH) {
    return this.code("pickup", linkId, nonce, length);
  }
  requestPickupCode(requestId: string, nonce = 0, length: CodeLength = DEFAULT_CODE_LENGTH) {
    return this.code("request-pickup", requestId, nonce, length);
  }
  invitePickupCode(inviteId: string, nonce = 0, length: CodeLength = DEFAULT_CODE_LENGTH) {
    return this.code("invite-pickup", inviteId, nonce, length);
  }
  devicePickupCode(codeId: string, nonce = 0, length: CodeLength = DEFAULT_CODE_LENGTH) {
    return this.code("device-pickup", codeId, nonce, length);
  }
  pickupCodeFor(
    kind: "share" | "request" | "invitation" | "device",
    id: string,
    nonce = 0,
    length: CodeLength = DEFAULT_CODE_LENGTH,
  ) {
    switch (kind) {
      case "share":
        return this.pickupCode(id, nonce, length);
      case "request":
        return this.requestPickupCode(id, nonce, length);
      case "invitation":
        return this.invitePickupCode(id, nonce, length);
      case "device":
        return this.devicePickupCode(id, nonce, length);
    }
  }
  private code(purpose: string, id: string, nonce: number, length: CodeLength) {
    if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce >= 10 ** length)
      throw new Error("Invalid numeric pickup-code nonce.");
    const size = 10 ** length;
    // Each length walks its own sequence: were they shared, a four-digit replacement would be the
    // last four digits of the six-digit code it retired.
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
