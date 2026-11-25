// Work that costs far more than browsing, such as checking every file of an archive on disk before
// it starts, runs only a few at a time for each member and on the server, so one member asking
// again and again can't slow Relay for everyone. Browsing never waits on these places.
import type { FastifyReply } from "fastify";
import type { Context } from "../context.ts";
import { fail } from "./errors.ts";

/** One member's archives being prepared at once. */
export const JOBS_PER_MEMBER = 2;
/** Archives being prepared at once on the whole server. */
export const JOBS_TOTAL = 4;
export const MEMBER_BUSY = "Your other downloads are still being prepared. Try again once they start.";
export const SERVER_BUSY = "Relay is busy preparing other downloads. Try again in a moment.";

const running = new WeakMap<Context, Map<string, number>>();

/**
 * Runs `work` holding one of `member`'s places and one of the server's, or refuses with 503 and
 * Retry-After when either is taken. The places are given back when `work` ends, however it ends.
 */
export async function preparing<T>(ctx: Context, reply: FastifyReply, member: string, work: () => Promise<T>) {
  let held = running.get(ctx);
  if (!held) running.set(ctx, (held = new Map<string, number>()));
  const places = [
    { key: `member:${member}`, max: JOBS_PER_MEMBER, message: MEMBER_BUSY },
    { key: "all", max: JOBS_TOTAL, message: SERVER_BUSY },
  ];
  const taken = places.find((place) => (held.get(place.key) ?? 0) >= place.max);
  if (taken) {
    reply.header("Retry-After", "5");
    fail(503, taken.message);
  }
  for (const { key } of places) held.set(key, (held.get(key) ?? 0) + 1);
  try {
    return await work();
  } finally {
    for (const { key } of places) {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    }
  }
}
