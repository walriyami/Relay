import { resolve } from "node:path";

export type Config = {
  /** Data directory: relay.sqlite, blobs/, uploads/, thumbnails/, secret.key. */
  root: string;
  /**
   * Pins the public origin, e.g. https://relay.example.com: unsafe requests must come from it and
   * passkeys belong to it. Unset, Relay serves whatever host it is opened at (see lib/auth.ts).
   */
  origin?: string;
  /** Link/request token key. Without it a key is generated in <root>/secret.key. */
  secret?: string;
  trustProxy: string[];
  /** How long a tab's transfers survive without its event stream. */
  tabLeaseMs: number;
  /** Interval of the maintenance sweep. */
  sweepMs: number;
  logger: boolean;
  /** Serves the built client from dist/ when present. */
  serveClient: boolean;
};

export function configFromEnv(env = process.env): Config {
  return {
    root: resolve(env.RELAY_DATA || ".data"),
    origin: env.RELAY_ORIGIN ? pinnedOrigin(env.RELAY_ORIGIN) : undefined,
    secret: env.RELAY_SECRET,
    trustProxy: (env.RELAY_TRUST_PROXY || "127.0.0.1,::1").split(",").map((s) => s.trim()),
    tabLeaseMs: 5 * 60_000,
    sweepMs: 60_000,
    logger: true,
    serveClient: true,
  };
}

/** "https://relay.example.com" exactly as browsers send it in Origin, or a startup error naming the variable. */
function pinnedOrigin(value: string) {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // Reported below.
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username)
    throw new Error(`RELAY_ORIGIN must be a web address such as https://relay.example.com, with no path.`);
  return url.origin;
}
