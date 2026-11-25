// Wrong guesses counted in the database (the `failures` table), so a restart forgives nobody.
// Each limit names its own `kind`; rows older than a day no longer count for any limit and are
// removed now and then.
import type { Context } from "../context.ts";

const DAY = 86_400_000;
/** How often old rows are cleared out. */
const PRUNE_MS = 60_000;

const pruned = new WeakMap<Context["db"], number>();

/** Counts a wrong guess under each of `keys` at once. */
export function recordFailure(ctx: Pick<Context, "db">, kind: string, keys: string[], now: number) {
  ctx.db.tx(() => {
    for (const key of keys) ctx.db.run("INSERT INTO failures(kind, key, time) VALUES(?, ?, ?)", kind, key, now);
  });
  const last = pruned.get(ctx.db) ?? 0;
  if (now - last >= PRUNE_MS || now < last) {
    pruned.set(ctx.db, now);
    ctx.db.run("DELETE FROM failures WHERE time <= ?", now - DAY);
  }
}

/** Wrong guesses counted under `key` after `since`. */
export const failuresSince = (ctx: Pick<Context, "db">, kind: string, key: string, since: number) =>
  ctx.db.value<number>("SELECT count(*) FROM failures WHERE kind = ? AND key = ? AND time > ?", kind, key, since) ?? 0;

/**
 * When the `max`-th newest wrong guess under `key` was, if there were that many after `since`: the
 * limit lifts once that one is out of the window.
 */
export const nthNewestFailure = (ctx: Pick<Context, "db">, kind: string, key: string, since: number, max: number) =>
  ctx.db.value<number>(
    "SELECT time FROM failures WHERE kind = ? AND key = ? AND time > ? ORDER BY time DESC LIMIT 1 OFFSET ?",
    kind,
    key,
    since,
    max - 1,
  );

/**
 * Failures within a sliding window (at most a day), counted per key (an address, a username, a
 * link). The counts are kept in the database; checks running right now are held in memory, so
 * parallel attempts can't slip past the cap while a slow check (a password) runs.
 */
export class FailureCounter {
  private readonly active = new Map<string, number>();
  private readonly ctx: Pick<Context, "db">;
  private readonly kind: string;
  private readonly windowMs: number;
  constructor(ctx: Pick<Context, "db">, kind: string, windowMs: number) {
    if (windowMs > DAY) throw new Error("Failures are kept for a day at most.");
    this.ctx = ctx;
    this.kind = kind;
    this.windowMs = windowMs;
  }

  add(key: string, now: number) {
    recordFailure(this.ctx, this.kind, [key], now);
  }

  /** Whether `key` has at least `max` failures in the window, reading no more than `max` rows. */
  atLeast(key: string, max: number, now: number) {
    return nthNewestFailure(this.ctx, this.kind, key, now - this.windowMs, max) !== undefined;
  }

  /** Reserves one concurrent check so parallel attempts cannot bypass the failure cap. */
  reserve(key: string, now: number, max: number) {
    const active = this.active.get(key) ?? 0;
    if (active >= max || this.atLeast(key, max - active, now)) return false;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    return true;
  }

  release(key: string) {
    const count = this.active.get(key) ?? 0;
    if (count <= 1) this.active.delete(key);
    else this.active.set(key, count - 1);
  }

  /** How long until `key` has fewer than `max` failures in the window again. */
  waitFor(key: string, max: number, now: number) {
    const time = nthNewestFailure(this.ctx, this.kind, key, now - this.windowMs, max);
    return time === undefined ? 0 : Math.max(0, time + this.windowMs - now);
  }
}
