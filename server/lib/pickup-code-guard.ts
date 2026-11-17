// Limits on guessing pickup and sign-in codes. Each network gets a few wrong tries; it never
// pauses code entry for anyone else. When many networks are guessing at once, each wider network
// (a /24, or an IPv6 /48) gets only a few wrong tries a day, so even a spread-out attack makes
// slow progress against codes that only work for a day. A right code from a network that hasn't
// been guessing always works. Counts live in memory; a restart forgives everyone.
import { isIPv4 } from "node:net";
import type { Context } from "../context.ts";
import { fail } from "./errors.ts";
import { addressKey } from "../modules/auth/limits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Wrong codes one network may enter: a few in a row, and a day's worth of typos. */
const BURST = { windowMs: 15 * MINUTE, max: 5 };
const DAILY = { windowMs: DAY, max: 20 };
/** Wrong codes from everywhere in an hour that mean someone is guessing. */
const ATTACK_THRESHOLD = 30;
/** While guessing goes on (and for this long after), each wider network gets `ATTACK_MAX` a day. */
const ATTACK_LINGER_MS = 6 * HOUR;
const ATTACK_MAX = 3;
/** Networks remembered at once; the quietest are forgotten first. */
const MAX_NETWORKS = 20_000;
/** When the administrator was last told about guessing; kept across restarts. */
export const ATTACK_SETTING = "pickupCodeAttackAt";

type Guard = {
  /** Wrong-code times per network, oldest first, and per wider network. */
  networks: Map<string, number[]>;
  wide: Map<string, number[]>;
  /** Wrong-code times from everywhere in the last hour. */
  recent: number[];
  attackUntil: number;
};

const guards = new WeakMap<Context, Guard>();
function guardOf(ctx: Context) {
  let guard = guards.get(ctx);
  if (!guard) guards.set(ctx, (guard = { networks: new Map(), wide: new Map(), recent: [], attackUntil: 0 }));
  return guard;
}

/** The wider network an address belongs to: its IPv4 /24 or IPv6 /48. */
export function wideNetworkOf(ip: string) {
  const key = addressKey(ip);
  if (isIPv4(key)) return key.split(".").slice(0, 3).join(".") + ".0/24";
  if (key.endsWith("::/64")) return key.split(":").slice(0, 3).join(":") + "::/48";
  return key;
}

const since = (times: number[] | undefined, from: number) => (times ?? []).filter((time) => time > from).length;

function remember(map: Map<string, number[]>, key: string, now: number) {
  const times = (map.get(key) ?? []).filter((time) => time > now - DAY);
  times.push(now);
  // Re-inserting keeps the map ordered by latest activity, so the first key is the quietest.
  map.delete(key);
  map.set(key, times.slice(-Math.max(DAILY.max, ATTACK_MAX) - 1));
  if (map.size > MAX_NETWORKS) map.delete(map.keys().next().value!);
}

/** Refuses a network that has used up its wrong tries, with how long until it may try again. */
export function checkCodeAttempt(ctx: Context, ip: string, now = Date.now()) {
  const guard = guardOf(ctx);
  const own = guard.networks.get(addressKey(ip)) ?? [];
  const waits: number[] = [];
  if (since(own, now - BURST.windowMs) >= BURST.max) waits.push(own.at(-BURST.max)! + BURST.windowMs - now);
  if (since(own, now - DAILY.windowMs) >= DAILY.max) waits.push(own.at(-DAILY.max)! + DAILY.windowMs - now);
  if (guard.attackUntil > now) {
    const wide = guard.wide.get(wideNetworkOf(ip)) ?? [];
    if (since(wide, now - DAY) >= ATTACK_MAX) waits.push(wide.at(-ATTACK_MAX)! + DAY - now);
  }
  if (!waits.length) return;
  const minutes = Math.max(1, Math.ceil(Math.max(...waits) / MINUTE));
  const wait = minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
  fail(429, `Too many wrong codes from your network. Try again in about ${wait}, or use the link instead.`);
}

/** Counts a wrong code. Returns true when this one started a guessing alert. */
export function recordCodeFailure(ctx: Context, ip: string, now = Date.now()) {
  const guard = guardOf(ctx);
  remember(guard.networks, addressKey(ip), now);
  remember(guard.wide, wideNetworkOf(ip), now);
  guard.recent = guard.recent.filter((time) => time > now - HOUR);
  guard.recent.push(now);
  if (guard.recent.length < ATTACK_THRESHOLD) return false;
  guard.recent = guard.recent.slice(-ATTACK_THRESHOLD);
  const started = guard.attackUntil <= now;
  guard.attackUntil = now + ATTACK_LINGER_MS;
  if (started) {
    ctx.log.warn(
      `Someone is guessing pickup codes (${ATTACK_THRESHOLD} wrong codes within an hour). ` +
        "Each network now gets a few tries a day; codes keep working for everyone else.",
    );
    ctx.db.setSetting(ATTACK_SETTING, String(now));
    ctx.events.broadcast("codes");
  }
  return started;
}

/** When Relay last saw someone guessing codes, for the administrator. */
export function lastCodeAttackAt(ctx: Context): number | null {
  const value = Number(ctx.db.setting(ATTACK_SETTING));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
