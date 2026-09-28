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
      ctx.db.run(
        "INSERT INTO activity(id, owner, kind, by_device, created, data) VALUES(?, ?, ?, ?, ?, ?)",
        uuidv7(),
        owner,
        event.kind,
        by,
        Date.now(),
        JSON.stringify(event),
      );
      ctx.events.publish(owner, "activity");
    },
    sweep(now) {
      return ctx.db.deleteBatched("activity", "created <= ?", now - ACTIVITY_DAYS * DAY_MS);
    },
  };
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
          .map((row): ActivityEntry => ({
            ...(JSON.parse(row.data) as ActivityEvent),
            id: row.id,
            created: row.created,
            self: row.by_device === member.deviceId,
          }))
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
