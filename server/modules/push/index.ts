// Push notifications, opt-in per device (client/lib/push.ts). Three things notify, and only these:
// something arrived for this device, a guest sent files to your request, and the first download
// through one of your links. Requests and links follow the member's Activity choices, like the bell.
// Messages are encrypted for the device (webpush.ts); sending is best effort and never holds up the
// change that caused it.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { api } from "../../../shared/api.ts";
import type { ActivityEvent } from "../../../shared/model.ts";
import { shownText } from "../../../shared/text.ts";
import type { Context, Push } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { route } from "../../lib/http.ts";
import { readPrefs } from "../auth/sessions.ts";
import { loadPushKeys, sendPush, validKeys, type PushKeys, type PushResult, type Subscription } from "./webpush.ts";

/** The browsers' push services. Subscriptions elsewhere are refused, so Relay only ever posts to these. */
export const PUSH_SERVICES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];
const DAY_S = 24 * 3600;
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

type Message = { title: string; body: string; url: string; tag: string };
type Row = Subscription & { device_id: string };

/** Whether Relay may post to this endpoint: https on a known push service, or an exact listed origin. */
export function allowedEndpoint(endpoint: string, services: string[]) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return services.some((service) =>
    service.includes("://")
      ? url.origin === service
      : url.protocol === "https:" && (url.hostname === service || url.hostname.endsWith(`.${service}`)),
  );
}

export function createPush(ctx: Context): Push {
  let keys: PushKeys | null = null;
  const pushKeys = () => (keys ??= loadPushKeys(ctx.config.root));
  const subject = ctx.config.origin?.startsWith("https:") ? ctx.config.origin : "mailto:relay@localhost";

  /** Devices of `owner` with notifications on and still signed in; one device when given. */
  const subscribers = (owner: string, device?: string) =>
    ctx.db.all<Row>(
      `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_subscriptions p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = ? AND u.disabled = 0 ${device ? "AND p.device_id = ?" : ""}
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = p.device_id AND s.expires > ?)`,
      ...(device ? [owner, device, Date.now()] : [owner, Date.now()]),
    );

  async function deliver(row: Row, message: Message, urgency: "normal" | "high"): Promise<PushResult> {
    try {
      const result = await sendPush(pushKeys(), subject, row, message, { ttl: DAY_S, urgency });
      if (result === "gone")
        ctx.db.run("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?", row.device_id, row.endpoint);
      else if (result === "failed") ctx.log.warn({ tag: message.tag.split(":")[0] }, "push notification refused");
      return result;
    } catch (error) {
      // Never log the endpoint: it is the device's address at the push service.
      ctx.log.warn({ err: (error as Error).name, tag: message.tag.split(":")[0] }, "push notification failed");
      return "failed";
    }
  }
  const notify = (rows: Row[], message: Message, urgency: "normal" | "high" = "normal") => {
    for (const row of rows) void deliver(row, message, urgency);
  };

  const wants = (owner: string, group: "requests" | "links") =>
    readPrefs(ctx.db.value<string>("SELECT prefs FROM users WHERE id = ?", owner) ?? "{}").activity[group];

  return {
    keys: () => pushKeys().publicKey,
    deliver,
    subscribers,
    delivered(deliveryId) {
      const row = ctx.db.get<{ owner: string; item: string; to_device: string; from_name: string | null }>(
        `SELECT d.owner, d.item, d.to_device, f.name AS from_name
         FROM deliveries d LEFT JOIN devices f ON f.id = d.from_device WHERE d.id = ? AND d.state = 'available'`,
        deliveryId,
      );
      if (!row) return;
      const rows = subscribers(row.owner, row.to_device);
      if (!rows.length) return;
      const name = ctx.library.summaries([row.item]).get(row.item)?.name || "An item";
      notify(
        rows,
        {
          title: `From ${shownText(row.from_name || "your other device")}`,
          body: `“${shownText(name)}” is waiting on this device.`,
          url: "/",
          tag: `delivery:${deliveryId}`,
        },
        "high",
      );
    },
    recorded(owner, entryId, event) {
      // Visitors cause these, so each costs a few lookups by key, and nothing without a device to tell.
      const rows = subscribers(owner);
      if (!rows.length) return;
      const message = messageFor(ctx, entryId, event);
      if (message && wants(owner, message.group)) notify(rows, message.message);
    },
  };
}

function messageFor(
  ctx: Context,
  entryId: string,
  event: ActivityEvent,
): { group: "requests" | "links"; message: Message } | null {
  // Recorded inside a transaction that may still have rolled back.
  if (!ctx.db.get("SELECT 1 FROM activity WHERE id = ?", entryId)) return null;
  if (event.kind === "upload") {
    const textOnly = !event.files && event.text;
    const what = event.files ? `${plural(event.files, "file")}${event.text ? " and text" : ""}` : "text";
    return {
      group: "requests",
      message: {
        title: `New ${textOnly ? "text" : "files"} for “${shownText(event.request)}”`,
        body: `${shownText(event.sender || "Someone")} sent ${what}.`,
        url: `/requests/${encodeURIComponent(event.requestId)}`,
        tag: `request:${event.requestId}`,
      },
    };
  }
  if (event.kind === "link" && event.action === "downloaded") {
    // Only the link's first download: later ones are in Activity and on the link. The link's own
    // count keeps everyone who ever downloaded, unlike its visits, of which the oldest are forgotten.
    const downloads = ctx.db.value<number>("SELECT downloads FROM links WHERE id = ?", event.linkId);
    if (downloads !== 1) return null;
    return {
      group: "links",
      message: {
        title: `“${shownText(event.item)}” was downloaded`,
        body: `Someone on ${shownText(event.device)} downloaded it with your link. Later downloads show in Activity.`,
        url: `/links/${encodeURIComponent(event.linkId)}`,
        tag: `link:${event.linkId}`,
      },
    };
  }
  return null;
}

const sameText = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};

export function registerPush(app: FastifyInstance, ctx: Context) {
  const services = ctx.config.pushServices ?? PUSH_SERVICES;

  route(app, ctx, api.push.status, ({ member }) => ({
    key: ctx.push.keys(),
    subscribed: !!ctx.db.get("SELECT 1 FROM push_subscriptions WHERE device_id = ?", member.deviceId),
  }));

  route(app, ctx, api.push.subscribe, ({ member, body }) => {
    if (!allowedEndpoint(body.endpoint, services))
      fail(400, "This browser’s notification service isn’t supported. Try Chrome, Edge, Firefox or Safari.");
    if (!validKeys(body.keys.p256dh, body.keys.auth)) fail(400, "This browser sent an unusable notification key.");
    ctx.db.tx(() => {
      // The same browser signed in again keeps one subscription: the newest. Its endpoint alone isn't
      // proof of that, since it could be learned elsewhere, so another account's subscription moves
      // only to a browser that also holds its keys, which never leave the browser that made them.
      const held = ctx.db.get<{ user_id: string; p256dh: string; auth: string }>(
        "SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ? AND device_id != ?",
        body.endpoint,
        member.deviceId,
      );
      if (
        held &&
        held.user_id !== member.userId &&
        !(sameText(held.p256dh, body.keys.p256dh) && sameText(held.auth, body.keys.auth))
      )
        fail(409, "This browser’s notification address belongs to another account.");
      ctx.db.run(
        "DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id != ?",
        body.endpoint,
        member.deviceId,
      );
      ctx.db.run(
        `INSERT INTO push_subscriptions(device_id, user_id, endpoint, p256dh, auth, created) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
           auth = excluded.auth, created = excluded.created`,
        member.deviceId,
        member.userId,
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        Date.now(),
      );
    });
    return { ok: true as const };
  });

  route(app, ctx, api.push.unsubscribe, ({ member }) => {
    ctx.db.run("DELETE FROM push_subscriptions WHERE device_id = ?", member.deviceId);
    return { ok: true as const };
  });

  route(app, ctx, api.push.test, async ({ member }) => {
    const [row] = ctx.push.subscribers(member.userId, member.deviceId);
    if (!row) fail(409, "Notifications aren’t on for this device. Turn them on first.");
    const result = await ctx.push.deliver(
      row,
      {
        title: "Notifications are on",
        body: "Relay will tell this device when something arrives for you.",
        url: "/settings#s-notify",
        tag: "test",
      },
      "normal",
    );
    return { sent: result === "sent" };
  });
}
