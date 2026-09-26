import type { Context } from "../context.ts";
import { fail } from "./errors.ts";
import { FailureLog } from "../modules/auth/limits.ts";

const WINDOW_MS = 60_000;
const MAX_FAILURES = 60;
const MAX_PER_ADDRESS = 10;
const logs = new WeakMap<Context, FailureLog>();

function logFor(ctx: Context) {
  let log = logs.get(ctx);
  if (!log) logs.set(ctx, (log = new FailureLog(WINDOW_MS)));
  return log;
}

/** Starts one attempt against either public pickup-code endpoint using a shared process-wide budget. */
export function checkPickupCodeAttempt(ctx: Context, address: string, now = Date.now()) {
  const log = logFor(ctx);
  if (log.count(address, now) >= MAX_PER_ADDRESS || log.total(now) >= MAX_FAILURES)
    fail(429, "Too many incorrect codes. Try again in a minute.");
}

/** Records a failed attempt; the preceding check plus synchronous request handlers makes this atomic. */
export function recordPickupCodeFailure(ctx: Context, address: string, now = Date.now()) {
  const log = logFor(ctx);
  if (log.total(now) >= MAX_FAILURES) fail(429, "Too many incorrect codes. Try again in a minute.");
  log.add(address, now);
}
