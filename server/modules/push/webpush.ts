// Web Push without a third-party service or library: the message is encrypted for the browser
// (RFC 8291, aes128gcm from RFC 8188) and the request is signed with this server's own key
// (VAPID, RFC 8292). Only the browser's push service (Google, Mozilla, Apple, Microsoft) carries
// it, and it can't read it.
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PushKeys = { publicKey: string; privateKey: KeyObject };
export type Subscription = { endpoint: string; p256dh: string; auth: string };

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64url");
const unb64 = (text: string) => Buffer.from(text.replace(/=+$/, ""), "base64url");

/**
 * The server's push key pair, made on first use and kept in <root>/push-keys.json (owner-only). Browsers
 * tie each subscription to the public key, so replacing the file means devices must turn
 * notifications on again.
 */
export function loadPushKeys(root: string): PushKeys {
  const file = join(root, "push-keys.json");
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(file, JSON.stringify({ privateKey: privateKey.export({ format: "jwk" }) }), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const jwk = (JSON.parse(readFileSync(file, "utf8")) as { privateKey: JsonWebKey }).privateKey;
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  // The uncompressed point, as browsers want it for applicationServerKey.
  const publicKey = b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x!), unb64(jwk.y!)]));
  return { publicKey, privateKey };
}

/** A subscription's keys are an uncompressed P-256 point and a 16-byte secret. */
export function validKeys(p256dh: string, auth: string) {
  const point = unb64(p256dh);
  return point.length === 65 && point[0] === 4 && unb64(auth).length === 16;
}

/**
 * Encrypts `plaintext` for one subscription as a single aes128gcm record. `fixed` exists for the
 * RFC's test vector; real messages get a fresh key and salt each time.
 */
export function encrypt(
  plaintext: Uint8Array,
  subscription: { p256dh: string; auth: string },
  fixed?: { privateKey: Buffer; salt: Buffer },
) {
  const uaPublic = unb64(subscription.p256dh);
  const authSecret = unb64(subscription.auth);
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (only) record; no extra padding.
  const body = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body, cipher.getAuthTag()]);
}

/** A VAPID token for one push service, valid for 12 hours. */
export function vapidToken(keys: PushKeys, audience: string, subject: string, now = Date.now()) {
  const part = (value: object) => b64(Buffer.from(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${b64(signature)}`;
}

export type PushResult = "sent" | "gone" | "failed";

/** Sends one encrypted message. "gone": the browser dropped the subscription (404/410). */
export async function sendPush(
  keys: PushKeys,
  subject: string,
  subscription: Subscription,
  message: object,
  options: { ttl: number; urgency: "normal" | "high"; topic?: string },
): Promise<PushResult> {
  const audience = new URL(subscription.endpoint).origin;
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(options.ttl),
      Urgency: options.urgency,
      ...(options.topic ? { Topic: options.topic } : {}),
      Authorization: `vapid t=${vapidToken(keys, audience, subject)}, k=${keys.publicKey}`,
    },
    body: encrypt(Buffer.from(JSON.stringify(message)), subscription),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel().catch(() => {});
  if (response.status === 404 || response.status === 410) return "gone";
  return response.ok ? "sent" : "failed";
}
