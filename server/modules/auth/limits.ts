import type { FastifyRequest } from "fastify";
import { isIPv4, isIPv6 } from "node:net";

/**
 * The rate-limit bucket of an address. One IPv6 host typically controls a whole /64, so IPv6
 * addresses are grouped by their first four groups; IPv4 (also when IPv6-mapped) stays per address.
 */
export function addressKey(ip: string): string {
  let address = ip.split("%")[0];
  // Normalize an embedded dotted IPv4 tail to its two hexadecimal groups first.
  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted && isIPv4(dotted[2])) {
    const bytes = dotted[2].split(".").map(Number);
    address = `${dotted[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  if (!isIPv6(address)) return address;
  const [head, tail] = address.toLowerCase().split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = groups(tail);
  const full =
    tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const values = full.map((group) => parseInt(group, 16));
  // IPv4-mapped IPv6 addresses share the same bucket as the equivalent IPv4 caller.
  if (values.slice(0, 5).every((group) => group === 0) && values[5] === 0xffff) {
    const first = values[6];
    const second = values[7];
    return `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
  }
  return `${values
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** A per-route rate limit bucketed by `addressKey`. */
export const perAddress = (max: number, timeWindow: string) => ({
  max,
  timeWindow,
  keyGenerator: (req: FastifyRequest) => addressKey(req.ip),
});

/** Failures within a sliding window, counted overall and per key (an address, a username). */
export class FailureLog {
  private readonly entries: { time: number; key: string }[] = [];
  private readonly perKey = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly windowMs: number;
  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  private prune(now: number) {
    while (this.entries.length && this.entries[0].time <= now - this.windowMs) {
      const { key } = this.entries.shift()!;
      const left = this.perKey.get(key)! - 1;
      if (left) this.perKey.set(key, left);
      else this.perKey.delete(key);
    }
  }

  add(key: string, now: number) {
    this.prune(now);
    this.entries.push({ time: now, key });
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
  }

  count(key: string, now: number) {
    this.prune(now);
    return this.perKey.get(key) ?? 0;
  }

  /** Reserves one concurrent password check so parallel attempts cannot bypass the failure cap. */
  reserve(key: string, now: number, max: number) {
    this.prune(now);
    if ((this.perKey.get(key) ?? 0) + (this.active.get(key) ?? 0) >= max) return false;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    return true;
  }

  release(key: string) {
    const count = this.active.get(key) ?? 0;
    if (count <= 1) this.active.delete(key);
    else this.active.set(key, count - 1);
  }

  total(now: number) {
    this.prune(now);
    return this.entries.length;
  }
}
