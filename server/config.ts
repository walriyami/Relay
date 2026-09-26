import { resolve } from "node:path";

export type Config = {
  /** Data directory: relay.sqlite, blobs/, uploads/, thumbnails/, secret.key. */
  root: string;
  /** Public origin, e.g. https://relay.example.com. Unsafe requests must come from it. */
  origin: string;
  /** Bootstrap password for the first administrator; used only when there are no users. */
  adminPassword?: string;
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
  const port = Number(env.PORT || 3090);
  return {
    root: resolve(env.RELAY_DATA || ".data"),
    origin: env.RELAY_ORIGIN || `http://localhost:${port}`,
    adminPassword: env.RELAY_ADMIN_PASSWORD,
    secret: env.RELAY_SECRET,
    trustProxy: (env.RELAY_TRUST_PROXY || "127.0.0.1,::1").split(",").map((s) => s.trim()),
    tabLeaseMs: 5 * 60_000,
    sweepMs: 60_000,
    logger: true,
    serveClient: true,
  };
}
