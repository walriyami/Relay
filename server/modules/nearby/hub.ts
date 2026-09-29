import { isIPv4 } from "node:net";
import type { Context } from "../../context.ts";
import type { NearbyEvent } from "../../../shared/nearby.ts";
import { addressKey } from "../auth/limits.ts";
import { readPrefs } from "../auth/sessions.ts";
import type { Channel } from "../auth/streams.ts";

/** A device, or a guest, present in Nearby: reachable through its event stream. */
export type Endpoint = {
  /** The device's id, or the guest's. */
  id: string;
  kind: "device" | "guest";
  /** The device's member, or the member whose code the guest joined with. */
  userId: string;
  /** Where Relay saw it from; see `networkOf`. */
  network: string;
  channel: Channel;
};
type Entry = Endpoint & { release: () => void };
/** Enough of an endpoint to say whom it may reach. */
type Place = Omit<Endpoint, "channel">;

/**
 * The network an address is on, as far as Relay can tell: devices behind one router share their
 * public IPv4 address, or their IPv6 /64. Addresses on Relay's own networks (private, link-local,
 * loopback) are all one network, which is also how they look from inside a container.
 */
export function networkOf(ip: string): string {
  const key = addressKey(ip);
  if (isIPv4(key)) {
    const [a, b] = key.split(".").map(Number);
    const own =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    return own ? "local" : key;
  }
  // Unique local (fc00::/7), link-local (fe80::/10) and loopback (::1, in the /64 of zeros).
  if (/^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]|0:0:0:0):/.test(key)) return "local";
  return key;
}

/** Who is present in Nearby, and who may reach whom. In memory: presence doesn't outlive a stream. */
class Hub {
  private readonly endpoints = new Map<string, Entry>();
  private readonly ctx: Context;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  get(id: string): Endpoint | undefined {
    return this.endpoints.get(id);
  }

  all(): Iterable<Endpoint> {
    return this.endpoints.values();
  }

  /**
   * Makes an endpoint present until its stream ends. A device or guest is present through one
   * stream at a time: the one it registered last, so the tab it replaces is told.
   */
  attach(endpoint: Endpoint) {
    const prior = this.endpoints.get(endpoint.id);
    if (prior?.channel === endpoint.channel && prior.network === endpoint.network) return;
    if (prior) {
      this.endpoints.delete(prior.id);
      prior.release();
      if (prior.channel !== endpoint.channel) prior.channel.send("nearby", { type: "replaced" } satisfies NearbyEvent);
    }
    const entry: Entry = { ...endpoint, release: () => {} };
    this.endpoints.set(entry.id, entry);
    entry.release = endpoint.channel.onEnd(() => this.remove(entry));
    this.changed(entry);
  }

  private remove(entry: Entry) {
    if (this.endpoints.get(entry.id) !== entry) return;
    this.endpoints.delete(entry.id);
    entry.release();
    this.changed(entry);
  }

  /** Delivers to an endpoint that is present. */
  send(to: Endpoint, event: NearbyEvent) {
    to.channel.send("nearby", event);
  }

  /** Lets other members on the same network see this member's devices. */
  visible(userId: string) {
    const prefs = this.ctx.db.value<string>("SELECT prefs FROM users WHERE id = ?", userId);
    return prefs !== undefined && readPrefs(prefs).nearbyVisible;
  }

  /**
   * May `a` and `b` connect? A member's own devices always; guests and the devices of the member
   * whose code they joined with; two members' devices when both are visible on the same network.
   */
  related(a: Place, b: Place) {
    if (a.id === b.id || (a.kind === "guest" && b.kind === "guest")) return false;
    if (a.userId === b.userId) return true;
    if (a.kind === "guest" || b.kind === "guest") return false;
    return a.network === b.network && this.visible(a.userId) && this.visible(b.userId);
  }

  /** Something about a member changed (visibility, a device's name) that others may be showing. */
  userChanged(userId: string) {
    const users = new Set([userId]);
    for (const own of this.endpoints.values())
      if (own.userId === userId && own.kind === "device")
        for (const other of this.endpoints.values())
          if (other.kind === "device" && other.network === own.network) users.add(other.userId);
    for (const user of users) this.ctx.events.publish(user, "nearby");
    this.tellGuests(userId);
  }

  /** Guests of this member hear it on their own streams; they have no member stream to change. */
  tellGuests(userId: string) {
    for (const guest of this.endpoints.values())
      if (guest.kind === "guest" && guest.userId === userId) this.send(guest, { type: "peers" });
  }

  private changed(entry: Endpoint) {
    const users = new Set([entry.userId]);
    if (entry.kind === "device") {
      for (const other of this.endpoints.values())
        if (other.kind === "device" && other.network === entry.network) users.add(other.userId);
      this.tellGuests(entry.userId);
    }
    for (const user of users) this.ctx.events.publish(user, "nearby");
  }
}

const registry = new WeakMap<Context, Hub>();
export function hubOf(ctx: Context): Hub {
  let hub = registry.get(ctx);
  if (!hub) registry.set(ctx, (hub = new Hub(ctx)));
  return hub;
}
