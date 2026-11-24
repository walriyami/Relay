// Limits on guessing pickup and sign-in codes. Each network gets a few wrong tries; it never
// pauses code entry for anyone else. When many networks are guessing at once, each wider network
// (a /24, or an IPv6 /48) gets only a few wrong tries a day, so even a spread-out attack makes
// slow progress against codes that only work for a day. A right code from a network that hasn't
// been guessing works, unless 20,000 networks are guessing at once: then networks beyond those
// share one small allowance, and a link still works where a code doesn't. Counts live in memory;
// a restart forgives everyone.
import type { Context } from "../context.ts";
import { fail } from "./errors.ts";
import { addressKey, wideNetworkOf } from "../modules/auth/limits.ts";

export { wideNetworkOf };

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
/** Networks remembered at once. Past this, the rest share one count (see `slot`). */
const MAX_NETWORKS = 20_000;
/** Where networks that don't fit are counted, all together. */
const OVERFLOW = "overflow";
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

const since = (times: number[] | undefined, from: number) => (times ?? []).filter((time) => time > from).length;

/**
 * The key a network's wrong codes are counted under. A network is forgotten only once its wrong
 * codes no longer count (a day). If the map is full of networks still guessing, a new one shares
 * the overflow count instead: forgetting the quietest would let someone with more networks than
 * fit wipe their own earlier guesses and start again.
 */
function slot(map: Map<string, number[]>, key: string, now: number) {
  if (map.has(key) || map.size < MAX_NETWORKS) return key;
  // The map is ordered by latest activity, so the first key is the quietest.
  const [quietest, times] = map.entries().next().value!;
  if (times.at(-1)! > now - DAY) return OVERFLOW;
  map.delete(quietest);
  return key;
}

function remember(map: Map<string, number[]>, network: string, now: number) {
  const key = slot(map, network, now);
  const times = (map.get(key) ?? []).filter((time) => time > now - DAY);
  times.push(now);
  // Re-inserting keeps the map ordered by latest activity.
  map.delete(key);
  map.set(key, times.slice(-Math.max(DAILY.max, ATTACK_MAX) - 1));
}

/** Refuses a network that has used up its wrong tries, with how long until it may try again. */
export function checkCodeAttempt(ctx: Context, ip: string, now = Date.now()) {
  const guard = guardOf(ctx);
  const own = guard.networks.get(slot(guard.networks, addressKey(ip), now)) ?? [];
  const waits: number[] = [];
  if (since(own, now - BURST.windowMs) >= BURST.max) waits.push(own.at(-BURST.max)! + BURST.windowMs - now);
  if (since(own, now - DAILY.windowMs) >= DAILY.max) waits.push(own.at(-DAILY.max)! + DAILY.windowMs - now);
  if (guard.attackUntil > now) {
    const wide = guard.wide.get(slot(guard.wide, wideNetworkOf(ip), now)) ?? [];
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
