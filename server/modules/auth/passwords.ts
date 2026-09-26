import type { Context } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { verifyPassword } from "../../lib/secrets.ts";
import { FailureLog } from "./limits.ts";

/** Wrong passwords per username, on top of the per-address limits: distributed guessing stays slow. */
const PER_USERNAME = { max: 20, windowMs: 3_600_000 };
const registry = new WeakMap<Context, FailureLog>();

/** Verifies a password for `username`, counting failures and refusing once the account's limit is hit. */
export async function checkPassword(ctx: Context, username: string, password: string, hash: string): Promise<boolean> {
  let failures = registry.get(ctx);
  if (!failures) registry.set(ctx, (failures = new FailureLog(PER_USERNAME.windowMs)));
  if (!failures.reserve(username, Date.now(), PER_USERNAME.max))
    fail(429, "Too many failed sign-in attempts for this account. Try again later.");
  try {
    const valid = await verifyPassword(password, hash);
    if (!valid) failures.add(username, Date.now());
    return valid;
  } finally {
    failures.release(username);
  }
}
