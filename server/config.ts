import { resolve } from "node:path";

export type Config = {
  /** Data directory: relay.sqlite, blobs/, uploads/, thumbnails/, secret.key. */
  root: string;
  /**
   * Pins the public origin, e.g. https://relay.example.com: unsafe requests must come from it and
   * passkeys belong to it. Unset, only localhost and literal IP hosts are served (see lib/auth.ts).
   */
  origin?: string;
  /** Link/request token key. Without it a key is generated in <root>/secret.key. */
  secret?: string;
  trustProxy: string[];
  /**
   * Setup asks for a one-time key from <root>/setup.key before anyone can create the administrator,
   * for a server reachable by others before it's set up. Off unless RELAY_SETUP_KEY=true.
   */
  setupKey: boolean;
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
    setupKey: flag("RELAY_SETUP_KEY", env.RELAY_SETUP_KEY),
    tabLeaseMs: 5 * 60_000,
    sweepMs: 60_000,
    logger: true,
    serveClient: true,
  };
}

/** On for "true" or "1", off when unset, "false" or "0", or a startup error naming the variable. */
function flag(name: string, value: string | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "" || normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false.`);
}

/** "https://relay.example.com" exactly as browsers send it in Origin, or a startup error naming the variable. */
function pinnedOrigin(value: string) {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // Reported below.
  }
  if (
    !url ||
    !/^https?:$/.test(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`RELAY_ORIGIN must be a web address such as https://relay.example.com, with no path.`);
  return url.origin;
}
