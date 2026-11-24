import { isIP } from "node:net";
import { resolve } from "node:path";
import { isAnnounceable } from "../local/addresses.ts";

export type Config = {
  /** Data directory: relay.sqlite, blobs/, uploads/, thumbnails/, secret.key. */
  root: string;
  sso?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    controlOrigin: string;
    appToken: string;
    projectId: string;
  };
  /**
   * Pins the public origin, e.g. https://relay.example.com: unsafe requests must come from it and
   * passkeys belong to it. Unset, only localhost and literal IP hosts are served (see lib/auth.ts).
   */
  origin?: string;
  /** Link/request token key. Without it a key is generated in <root>/secret.key. */
  secret?: string;
  /**
   * Proxies whose X-Forwarded-For is believed: addresses, CIDR ranges or host names, such as a
   * tunnel connector's container name (see lib/proxies.ts).
   */
  trustProxy: string[];
  /**
   * A header in which a trusted proxy names the visitor's own address, such as Cloudflare's
   * CF-Connecting-IP. Read only from trusted proxies (`trustProxy`); limits then count each
   * visitor rather than everyone behind the proxy as one. Lowercase; unset uses X-Forwarded-For.
   */
  clientIpHeader?: string;
  /**
   * Setup asks for a one-time key before anyone can create the administrator, so a fresh or reset
   * server can't be claimed by whoever opens it first. The key is printed in the server log and
   * kept in <root>/setup.key until setup. On unless RELAY_SETUP_KEY=false (a machine only you can reach).
   * That is ignored when RELAY_ORIGIN names a public web address: one wrong line there would hand
   * the server to its first visitor.
   */
  setupKey: boolean;
  /**
   * An administrator's username: at startup Relay logs a one-time link that sets a new password for
   * that account (see docs/hosting.md and modules/recovery). Unset or empty, there is none.
   */
  recoverAdmin?: string;
  /** How long a tab counts as open without its event stream or an upload request. */
  tabLeaseMs: number;
  /**
   * How long a transfer's unfinished uploads are kept once no page is sending them (the phone slept,
   * the page reloaded or closed), so they can continue. They count against capacity meanwhile.
   */
  pausedUploadMs: number;
  /** Interval of the maintenance sweep. */
  sweepMs: number;
  logger: boolean;
  /** Serves the built client from dist/ when present. */
  serveClient: boolean;
  /**
   * Direct transfers on the local network (see shared/local.ts): Relay runs the helper that
   * browsers connect to, on this UDP port. Unset, there are none. `addresses` are the ones browsers
   * are told to reach it at, when the host's own can't be seen from inside a container; unset, the
   * helper announces the private addresses it finds.
   */
  local?: { port: number; addresses?: string[] };
  /**
   * Push services Relay may post notifications to: host names (https, subdomains included) or exact
   * origins. Unset, the browsers' own services (server/modules/push). Tests point it at a local one.
   */
  pushServices?: string[];
};

export function configFromEnv(env = process.env): Config {
  const origin = env.RELAY_ORIGIN ? pinnedOrigin(env.RELAY_ORIGIN) : undefined;
  return {
    root: resolve(env.RELAY_DATA || ".data"),
    sso:
      env.WAL_SSO_ISSUER &&
      env.WAL_SSO_CLIENT_ID &&
      env.WAL_SSO_CLIENT_SECRET &&
      env.WAL_CONTROL_ORIGIN &&
      env.WAL_CONTROL_APP_TOKEN
        ? {
            issuer: env.WAL_SSO_ISSUER,
            clientId: env.WAL_SSO_CLIENT_ID,
            clientSecret: env.WAL_SSO_CLIENT_SECRET,
            controlOrigin: env.WAL_CONTROL_ORIGIN,
            appToken: env.WAL_CONTROL_APP_TOKEN,
            projectId: env.WAL_CONTROL_PROJECT_ID || "relay",
          }
        : undefined,
    origin,
    secret: env.RELAY_SECRET,
    trustProxy: (env.RELAY_TRUST_PROXY?.trim() || "127.0.0.1,::1")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    clientIpHeader: clientIpHeader(env.RELAY_CLIENT_IP_HEADER),
    setupKey: flag("RELAY_SETUP_KEY", env.RELAY_SETUP_KEY, true) || (!!origin && !privateOrigin(origin)),
    recoverAdmin: env.RELAY_RECOVER_ADMIN?.trim() || undefined,
    tabLeaseMs: 5 * 60_000,
    pausedUploadMs: 24 * 60 * 60_000,
    sweepMs: 60_000,
    logger: true,
    serveClient: true,
    local: flag("RELAY_DIRECT", env.RELAY_DIRECT, true)
      ? { port: udpPort(env.RELAY_DIRECT_PORT), ...directAddresses(env.RELAY_DIRECT_ADDRESSES) }
      : undefined,
  };
}

/** On for "true" or "1", off for "false" or "0", `fallback` when unset, or a startup error naming the variable. */
function flag(name: string, value: string | undefined, fallback: boolean) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "") return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false.`);
}

function clientIpHeader(value: string | undefined) {
  const name = value?.trim().toLowerCase();
  if (!name) return undefined;
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error("RELAY_CLIENT_IP_HEADER must be a header name, such as CF-Connecting-IP.");
  return name;
}

function udpPort(value: string | undefined) {
  const port = Number(value?.trim() || 3090);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("RELAY_DIRECT_PORT must be a UDP port number.");
  return port;
}

/** The addresses to announce, or nothing to let the helper find them; a startup error names a bad one. */
function directAddresses(value: string | undefined) {
  const addresses = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const address of addresses)
    if (!isAnnounceable(address))
      throw new Error(`RELAY_DIRECT_ADDRESSES must list private network addresses; "${address}" isn't one.`);
  return addresses.length ? { addresses: [...new Set(addresses)] } : {};
}

/** Whether an origin names this machine or a bare address rather than a public web name. */
function privateOrigin(origin: string) {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || isIP(host) !== 0;
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
