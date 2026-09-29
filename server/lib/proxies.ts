import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** How often host names are looked up again: a proxy's container gets a new address when it's recreated. */
const REFRESH_MS = 15_000;

type Log = { warn: (fields: object, message: string) => void; info: (fields: object, message: string) => void };

/**
 * The proxies Relay takes client addresses from (RELAY_TRUST_PROXY): addresses, CIDR ranges and
 * host names. A name, such as a tunnel connector's container name on a shared Docker network, is
 * trusted at whatever addresses it has at the time, and at none while it doesn't resolve.
 */
export class ProxyTrust {
  private readonly fixed = new BlockList();
  private readonly names: string[] = [];
  private resolved = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;
  private log: Log | undefined;
  private warned = false;

  constructor(entries: string[]) {
    for (const entry of entries) {
      const [address, bits, extra] = entry.split("/");
      const family = isIP(address);
      if (family && extra === undefined) {
        const type = family === 4 ? "ipv4" : "ipv6";
        if (bits === undefined) this.fixed.addAddress(address, type);
        else if (/^\d+$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128))
          this.fixed.addSubnet(address, Number(bits), type);
        else throw invalid(entry);
      } else if (bits === undefined && isHostName(entry)) this.names.push(entry.toLowerCase());
      else throw invalid(entry);
    }
  }

  /** For Fastify's `trustProxy`: whether the hop at `address` may report the one before it. */
  readonly trusts = (address: string | undefined): boolean => {
    // The direct-transfer helper's private socket has no peer address.
    if (!address) return false;
    const plain = unmapped(address);
    const family = isIP(plain);
    if (!family) return false;
    if (this.fixed.check(plain, family === 4 ? "ipv4" : "ipv6")) return true;
    for (const addresses of this.resolved.values()) if (addresses.has(plain)) return true;
    return false;
  };

  /**
   * Says once, for the first address that sends X-Forwarded-For without being trusted, that every
   * visitor through it counts as that one address: usually a proxy missing from RELAY_TRUST_PROXY.
   */
  checkForwarded(address: string | undefined, forwarded: unknown) {
    if (this.warned || forwarded === undefined || !address || this.trusts(address)) return;
    this.warned = true;
    this.log?.warn(
      { address: unmapped(address) },
      "a request came with X-Forwarded-For from an address RELAY_TRUST_PROXY doesn't list; if it's your proxy, add it, or everyone through it shares one address's limits",
    );
  }

  /** Looks the names up now, then keeps them current until `stop`. */
  async start(log: Log) {
    this.log = log;
    if (!this.names.length) return;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private async refresh() {
    await Promise.all(
      this.names.map(async (name) => {
        const before = this.resolved.get(name);
        let now: Set<string>;
        try {
          now = new Set((await lookup(name, { all: true, verbatim: true })).map((a) => unmapped(a.address)));
        } catch {
          now = new Set();
        }
        this.resolved.set(name, now);
        if (before && same(before, now)) return;
        if (now.size) this.log?.info({ proxy: name, addresses: [...now] }, "trusted proxy found");
        else
          this.log?.warn(
            { proxy: name },
            "a trusted proxy's name doesn't resolve; its requests count as its own until it does",
          );
      }),
    );
  }
}

function invalid(entry: string) {
  return new Error(`RELAY_TRUST_PROXY: "${entry}" is not an address, a CIDR range or a host name.`);
}

/** A DNS name, or a Docker container name, which may also have underscores. */
function isHostName(value: string) {
  return value.length <= 253 && /^[a-z0-9]([\w-]*[a-z0-9])?(\.[a-z0-9]([\w-]*[a-z0-9])?)*$/i.test(value);
}

/** 192.0.2.1 for ::ffff:192.0.2.1, as a dual-stack socket reports IPv4 peers. */
function unmapped(address: string) {
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address) ? address.slice(7) : address;
}

function same(a: Set<string>, b: Set<string>) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
