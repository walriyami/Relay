// Limits on wrong passwords that cost the person guessing, not the account's owner.
//
// - Each network (an IPv4 /24 or IPv6 /48) gets a few wrong passwords per account an hour.
// - Each account gets a few more an hour from browsers it has never signed in on. A browser the
//   account has signed in on before carries a signed "known browser" cookie and skips that limit,
//   so someone guessing from elsewhere can't lock the owner out of their own devices. Each browser's
//   cookie is its own, and a new password forgets them all.
// - A new browser on a network the account has signed in from before (home, work) skips that
//   limit too. Letting a right password through the limit from anywhere would turn the limit into
//   a way to test guesses; a network the owner uses is one a stranger elsewhere can't borrow, and
//   it still has its own few wrong passwords an hour. A new password forgets these networks too.
// - Each network may have only a couple of password checks running at once. Known browsers have
//   room of their own in the password queue, and so do networks that haven't been getting passwords
//   wrong, so a flood of guesses waits behind everyone else's sign-ins and is turned away first.
// Wrong passwords are counted in the database, so a restart forgives nobody.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../../context.ts";
import { cookieOptions, knownBrowserCookie } from "../../lib/auth.ts";
import { fail } from "../../lib/errors.ts";
import { sha256, verifyPassword } from "../../lib/secrets.ts";
import { FailureCounter } from "../../lib/failures.ts";
import { wideNetworkOf } from "./limits.ts";
import { recordHistory } from "../history/index.ts";

const HOUR = 3_600_000;
/** Wrong passwords for one account from one network in an hour: plenty of room for typos. */
const PER_NETWORK = { max: 10, windowMs: HOUR };
/** Wrong passwords for one account from browsers it has never signed in on, in an hour. */
const PER_ACCOUNT = { max: 20, windowMs: HOUR };
/** Password checks one network may have running or waiting at once. */
const CONCURRENT_PER_NETWORK = 2;
/** Wrong passwords from one network in an hour (any account) after which its checks wait behind everyone else's. */
const SUSPECT_AFTER = 3;
/** Networks an account remembers signing in from, most recent first. */
const KNOWN_NETWORKS = 20;
/** How long a browser stays known to the accounts that signed in on it. */
const KNOWN_MS = 400 * 24 * HOUR;
/** Accounts one browser remembers, newest first. */
const KNOWN_ACCOUNTS = 5;

type Limits = {
  /** Per account and network. */
  network: FailureCounter;
  account: FailureCounter;
  /** Per network, whatever the account: who keeps getting it wrong. */
  anyAccount: FailureCounter;
  running: Map<string, number>;
};
const registry = new WeakMap<Context, Limits>();
function limitsOf(ctx: Context) {
  let limits = registry.get(ctx);
  if (!limits)
    registry.set(
      ctx,
      (limits = {
        network: new FailureCounter(ctx, "password-network", PER_NETWORK.windowMs),
        account: new FailureCounter(ctx, "password-account", PER_ACCOUNT.windowMs),
        anyAccount: new FailureCounter(ctx, "password-any-account", HOUR),
        running: new Map(),
      }),
    );
  return limits;
}

/** Ties a remembered network to the account's current password. */
const passwordDigest = (passwordHash: string) => sha256(`sign-in-network:${passwordHash}`);

/** Remembers that the account signed in from this address's network with the password it has now. */
function rememberNetwork(ctx: Context, userId: string, ip: string, hash: string) {
  // The direct-transfer helper's private socket has no address, and names no network.
  if (!ip) return;
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO sign_in_networks(user_id, network, password, last) VALUES(?, ?, ?, ?)
       ON CONFLICT(user_id, network) DO UPDATE SET password = excluded.password, last = excluded.last`,
      userId,
      wideNetworkOf(ip),
      passwordDigest(hash),
      Date.now(),
    );
    ctx.db.run(
      `DELETE FROM sign_in_networks WHERE user_id = ? AND network NOT IN
         (SELECT network FROM sign_in_networks WHERE user_id = ? ORDER BY last DESC LIMIT ?)`,
      userId,
      userId,
      KNOWN_NETWORKS,
    );
  });
}

/** Whether the account signed in from this network, with the password it has now, within the time a browser stays known. */
const knowsNetwork = (ctx: Context, userId: string, network: string, passwordHash: string, now: number) =>
  !!ctx.db.get(
    "SELECT 1 FROM sign_in_networks WHERE user_id = ? AND network = ? AND password = ? AND last > ?",
    userId,
    network,
    passwordDigest(passwordHash),
    now - KNOWN_MS,
  );

/** This browser's entries, `userId.browser.mac`, newest first; each is checked only when used. */
const knownEntries = (ctx: Context, req: FastifyRequest) =>
  (req.cookies?.[knownBrowserCookie(ctx, req)] ?? "").split("~").filter(Boolean).slice(0, KNOWN_ACCOUNTS);

/** Whether the account signed in on this browser with the password it has now. */
function knowsBrowser(ctx: Context, req: FastifyRequest, userId: string, passwordHash: string) {
  return knownEntries(ctx, req).some((entry) => {
    const [id, browser, mac, extra] = entry.split(".");
    if (id !== userId || !browser || !mac || extra !== undefined) return false;
    const expected = Buffer.from(ctx.secrets.knownBrowserMac(id, browser, passwordHash));
    const given = Buffer.from(mac);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * Marks this browser, and its network, as ones the account signs in on (every way of signing in
 * ends here), so guessing elsewhere never locks it out.
 */
export function rememberBrowser(ctx: Context, reply: FastifyReply, userId: string) {
  const passwordHash = ctx.db.value<string>("SELECT password_hash FROM users WHERE id = ?", userId);
  if (!passwordHash) return;
  rememberNetwork(ctx, userId, reply.request.ip, passwordHash);
  const browser = randomBytes(12).toString("base64url");
  const others = knownEntries(ctx, reply.request).filter((entry) => entry.split(".")[0] !== userId);
  const value = [`${userId}.${browser}.${ctx.secrets.knownBrowserMac(userId, browser, passwordHash)}`, ...others]
    .slice(0, KNOWN_ACCOUNTS)
    .join("~");
  reply.setCookie(knownBrowserCookie(ctx, reply.request), value, cookieOptions(ctx, reply.request, KNOWN_MS));
}

/** Tells administrators an account is being refused for wrong passwords; repeats within the hour add to one entry. */
function lockedOut(ctx: Context, account: { username: string; userId: string | null }) {
  if (account.userId)
    recordHistory(
      ctx,
      { kind: "signin", username: account.username, reason: "locked" },
      account.userId,
      `signin:${account.userId}:locked`,
    );
}

const minutesUntil = (log: FailureCounter, key: string, max: number, now: number) =>
  Math.max(1, Math.ceil(log.waitFor(key, max, now) / 60_000));

/**
 * Verifies a password for an account, counting wrong ones. `userId` is null for a username that
 * doesn't exist, which is counted the same way so the answer doesn't reveal which names exist.
 */
export async function checkPassword(
  ctx: Context,
  req: FastifyRequest,
  /** `signedIn` is for a member confirming their own password, whose browser is known by definition. */
  account: { username: string; userId: string | null; signedIn?: boolean },
  password: string,
  hash: string,
): Promise<boolean> {
  const limits = limitsOf(ctx);
  const now = Date.now();
  const network = wideNetworkOf(req.ip);
  const pair = `${account.username}\n${network}`;
  const known = !!account.signedIn || (!!account.userId && knowsBrowser(ctx, req, account.userId, hash));
  // A new browser where the account usually signs in. Unknown usernames have no such network.
  const familiar = !known && !!account.userId && knowsNetwork(ctx, account.userId, network, hash, now);

  if (!limits.network.reserve(pair, now, PER_NETWORK.max)) {
    lockedOut(ctx, account);
    const minutes = minutesUntil(limits.network, pair, PER_NETWORK.max, now);
    fail(429, `Too many wrong passwords for this account. Try again in about ${minutes} minutes, or use a passkey.`);
  }
  let reservedAccount = false;
  try {
    if (!known && !familiar) {
      if (!limits.account.reserve(account.username, now, PER_ACCOUNT.max)) {
        lockedOut(ctx, account);
        const minutes = minutesUntil(limits.account, account.username, PER_ACCOUNT.max, now);
        fail(
          429,
          `Too many wrong passwords for this account from new devices. Sign in on a device you've used before ` +
            `or from where you usually sign in, use a passkey, or try again in about ${minutes} minutes.`,
        );
      }
      reservedAccount = true;
    }
    const running = limits.running.get(network) ?? 0;
    if (running >= CONCURRENT_PER_NETWORK) fail(429, "Too many sign-ins from your network at once. Try again shortly.");
    limits.running.set(network, running + 1);
    try {
      const lane = known ? "known" : limits.anyAccount.count(network, now) >= SUSPECT_AFTER ? "suspect" : "fresh";
      const valid = await verifyPassword(password, hash, { lane });
      if (!valid) {
        limits.network.add(pair, Date.now());
        limits.anyAccount.add(network, Date.now());
        if (reservedAccount) limits.account.add(account.username, Date.now());
      }
      return valid;
    } finally {
      const left = (limits.running.get(network) ?? 1) - 1;
      if (left) limits.running.set(network, left);
      else limits.running.delete(network);
    }
  } finally {
    limits.network.release(pair);
    if (reservedAccount) limits.account.release(account.username);
  }
}
