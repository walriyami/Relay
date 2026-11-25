// Limits on guessing pickup and sign-in codes. They never pause code entry for everyone; each one
// holds back only the network sending the wrong codes:
//
// - An address (an IPv4 address, or an IPv6 /64) gets a few wrong codes in a row and a day's worth
//   of typos.
// - So does its network (an IPv4 /24, or an IPv6 /56: about one home, office or provider customer),
//   always, so many addresses in one network can't add up to more.
// - When many wrong codes arrive from everywhere, within an hour or within a day, someone is
//   guessing: the administrator is told, and while it goes on each network gets only a few wrong
//   codes a day, each IPv6 /48 a few more.
// - However many networks someone uses, all of them together get a fixed number of wrong codes a
//   day. Once that is spent, codes are paused for everyone who isn't signed in until the oldest of
//   them is a day old; signed-in members still have their own network's limits.
//
// A locked network is refused even a right code, so a lock can't be used to test guesses; a link
// or QR code still works there. Counts live in the database, so a restart forgives nobody.
import type { Context } from "../context.ts";
import { fail } from "./errors.ts";
import { addressKey, wideNetworkOf } from "../modules/auth/limits.ts";
import { failuresSince, nthNewestFailure, recordFailure } from "./failures.ts";

export { wideNetworkOf };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Wrong codes one address may enter: a few in a row, and a day's worth of typos. */
const BURST = { windowMs: 15 * MINUTE, max: 5 };
const DAILY = { windowMs: DAY, max: 20 };
/** Wrong codes one network may enter in a day, however many addresses it uses. */
const NETWORK_DAILY = 20;
/** Wrong codes from everywhere that mean someone is guessing: within an hour, or within a day. */
const ALARM = [
  { windowMs: HOUR, max: 30, label: "within an hour" },
  { windowMs: DAY, max: 50, label: "within a day" },
];
/** While guessing goes on (and for this long after), networks get only a few wrong codes a day. */
const ATTACK_LINGER_MS = 6 * HOUR;
const ATTACK_NETWORK_MAX = 3;
/** …and an IPv6 /48, which holds 256 networks, a few more between them. */
const ATTACK_BLOCK_MAX = 10;
/**
 * Wrong codes from everywhere in a day after which only signed-in members may enter codes. A
 * guesser with many networks gets at most this many tries a day in all: with a million codes, each
 * working code has about a 1 in 3,300 chance a day of being found.
 */
const EVERYONE_DAILY = 300;

const KIND = "code";
/** When the administrator was last told about guessing. */
export const ATTACK_SETTING = "pickupCodeAttackAt";
/** Until when networks get only a few wrong codes a day. */
const ATTACK_UNTIL_SETTING = "pickupCodeAttackUntil";

/** An address's network: its IPv4 /24, or its IPv6 /56. */
export function codeNetworkOf(ip: string) {
  const key = addressKey(ip);
  if (!key.endsWith("::/64")) return wideNetworkOf(ip);
  const groups = key.slice(0, -5).split(":");
  return `${groups.slice(0, 3).join(":")}:${(parseInt(groups[3], 16) & 0xff00).toString(16)}::/56`;
}

/** What a wrong code from `ip` counts against: its address, network, IPv6 /48 and everyone's total. */
function keysOf(ip: string) {
  const address = `address:${addressKey(ip)}`;
  const network = `network:${codeNetworkOf(ip)}`;
  const block = addressKey(ip).endsWith("::/64") ? `block:${wideNetworkOf(ip)}` : null;
  return { address, network, block };
}

const attackUntil = (ctx: Context) => Number(ctx.db.setting(ATTACK_UNTIL_SETTING)) || 0;

const waitText = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  return minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
};

/**
 * Refuses a network that has used up its wrong tries, with how long until it may try again.
 * `signedIn` is for a member entering a code, who isn't held to the day's total for everyone.
 */
export function checkCodeAttempt(ctx: Context, ip: string, now = Date.now(), { signedIn = false } = {}) {
  if (!signedIn) {
    const oldest = nthNewestFailure(ctx, KIND, "all", now - DAY, EVERYONE_DAILY);
    if (oldest !== undefined)
      fail(
        429,
        `Codes are paused for now because many wrong codes have been entered. The link or QR code you were sent ` +
          `still works, or try the code again in about ${waitText(oldest + DAY - now)}.`,
      );
  }
  const { address, network, block } = keysOf(ip);
  const limits: { key: string; windowMs: number; max: number }[] = [
    { key: address, ...BURST },
    { key: address, ...DAILY },
    { key: network, windowMs: DAY, max: NETWORK_DAILY },
  ];
  if (attackUntil(ctx) > now) {
    limits.push({ key: network, windowMs: DAY, max: ATTACK_NETWORK_MAX });
    if (block) limits.push({ key: block, windowMs: DAY, max: ATTACK_BLOCK_MAX });
  }
  const waits = limits.flatMap(({ key, windowMs, max }) => {
    const time = nthNewestFailure(ctx, KIND, key, now - windowMs, max);
    return time === undefined ? [] : [time + windowMs - now];
  });
  if (!waits.length) return;
  fail(
    429,
    `Too many wrong codes were entered from your network, so codes are paused here for about ${waitText(Math.max(...waits))}. ` +
      "The link or QR code you were sent still works.",
  );
}

/** Counts a wrong code. Returns true when this one started a guessing alert. */
export function recordCodeFailure(ctx: Context, ip: string, now = Date.now()) {
  const { address, network, block } = keysOf(ip);
  recordFailure(ctx, KIND, [address, network, ...(block ? [block] : []), "all"], now);
  if (failuresSince(ctx, KIND, "all", now - DAY) === EVERYONE_DAILY)
    ctx.log.warn(
      `${EVERYONE_DAILY} wrong codes were entered within a day, so codes are paused for anyone who isn't signed in ` +
        "until the oldest is a day old. Links and QR codes keep working.",
    );
  const alarm = ALARM.find(({ windowMs, max }) => failuresSince(ctx, KIND, "all", now - windowMs) >= max);
  if (!alarm) return false;
  const started = attackUntil(ctx) <= now;
  ctx.db.setSetting(ATTACK_UNTIL_SETTING, String(now + ATTACK_LINGER_MS));
  if (started) {
    ctx.log.warn(
      `Someone is guessing pickup codes (${alarm.max} wrong codes ${alarm.label}). ` +
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
