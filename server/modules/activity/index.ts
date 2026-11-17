// The account's activity feed. Modules record events inside their own transactions; members read
// the entries their preferences ask for. Deliveries have their own list, and the client shows both.
import type { FastifyInstance } from "fastify";
import { api } from "../../../shared/api.ts";
import { uuidv7 } from "../../../shared/ids.ts";
import {
  ACTIVITY_GROUPS,
  type ActivityEntry,
  type ActivityEvent,
  type ActivityFeed,
  type ActivityKind,
} from "../../../shared/model.ts";
import type { Activity, Context } from "../../context.ts";
import { route } from "../../lib/http.ts";
import { DAY_MS } from "../../lib/time.ts";
import { readPrefs } from "../auth/sessions.ts";

/** Entries older than this are deleted by the sweep. */
export const ACTIVITY_DAYS = 90;
/** The feed shows at most this many entries. */
export const ACTIVITY_LIMIT = 100;

export function createActivity(ctx: Context): Activity {
  return {
    record(owner, event, by = null) {
      const id = uuidv7();
      if (event.kind === "signin") event = { ...event, familiar: familiarDevice(ctx, owner, event.deviceId) };
      ctx.db.run(
        "INSERT INTO activity(id, owner, kind, by_device, created, data) VALUES(?, ?, ?, ?, ?, ?)",
        id,
        owner,
        event.kind,
        by,
        Date.now(),
        JSON.stringify(event),
      );
      ctx.events.publish(owner, "activity");
      const recorded = event;
      ctx.db.afterCommit(() => ctx.push.recorded(owner, id, recorded));
    },
    sweep(now) {
      return ctx.db.deleteBatched("activity", "created <= ?", now - ACTIVITY_DAYS * DAY_MS);
    },
  };
}

/**
 * Whether an entry deserves the bell's badge. Routine things stay in the list without one, so the
 * badge keeps meaning "look": a sign-in from a kind of device the account hasn't used before, a
 * password or passkey change, files sent to a request, a download through a link, a new member.
 */
export function isNews(event: ActivityEvent) {
  switch (event.kind) {
    case "signin":
      // Recorded before `familiar` existed: treated as routine rather than flooding the badge.
      return event.familiar === false && event.method !== "setup" && event.method !== "invitation";
    case "link":
      return event.action === "downloaded";
    default:
      return true;
  }
}

/**
 * A new sign-in is familiar when the account has signed in before on the same kind of device with
 * the same browser name ("Chrome on Mac", ignoring the " 2" that tells open ones apart), or when it
 * is the account's very first device. Renamed devices are not matched; at worst that badges once.
 */
function familiarDevice(ctx: Context, owner: string, deviceId: string) {
  const device = ctx.db.get<{ name: string; kind: string }>("SELECT name, kind FROM devices WHERE id = ?", deviceId);
  if (!device) return true;
  const others = ctx.db.all<{ name: string }>(
    "SELECT name FROM devices WHERE user_id = ? AND id != ? AND kind = ?",
    owner,
    deviceId,
    device.kind,
  );
  const base = (name: string) => name.replace(/ \d+$/, "").toLowerCase();
  if (!ctx.db.get("SELECT 1 FROM devices WHERE user_id = ? AND id != ?", owner, deviceId)) return true;
  return others.some((other) => base(other.name) === base(device.name));
}

export function registerActivity(app: FastifyInstance, ctx: Context) {
  route(app, ctx, api.activity.list, ({ member }): ActivityFeed => {
    const user = ctx.db.get<{ prefs: string; activity_seen: number }>(
      "SELECT prefs, activity_seen FROM users WHERE id = ?",
      member.userId,
    )!;
    const wanted = readPrefs(user.prefs).activity;
    const kinds = (Object.keys(ACTIVITY_GROUPS) as ActivityKind[]).filter((kind) => wanted[ACTIVITY_GROUPS[kind]]);
    const entries = kinds.length
      ? ctx.db
          .all<{ id: string; created: number; by_device: string | null; data: string }>(
            `SELECT id, created, by_device, data FROM activity WHERE owner = ? AND kind IN (${kinds.map(() => "?").join(", ")})
             ORDER BY created DESC, id DESC LIMIT ?`,
            member.userId,
            ...kinds,
            ACTIVITY_LIMIT,
          )
          .map((row): ActivityEntry => {
            const event = JSON.parse(row.data) as ActivityEvent;
            const self = row.by_device === member.deviceId;
            return { ...event, id: row.id, created: row.created, self, news: !self && isNews(event) };
          })
      : [];
    return { entries, seen: user.activity_seen };
  });

  // Seeing the feed on one device marks it seen on all of them. Never moves back, nor past now.
  route(app, ctx, api.activity.seen, ({ member, body }) => {
    const until = Math.min(body.until, Date.now());
    if (
      ctx.db.run("UPDATE users SET activity_seen = ? WHERE id = ? AND activity_seen < ?", until, member.userId, until)
        .changes
    )
      ctx.events.publish(member.userId, "activity");
    return { ok: true as const };
  });
}
