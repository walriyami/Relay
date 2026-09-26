import { resolve } from "node:path";

export const DEFAULT_BACKUP_INTERVAL_HOURS = 24;
export const DEFAULT_BACKUP_KEEP = 7;

export type Config = {
  /** Data directory: relay.sqlite, blobs/, uploads/, thumbnails/, secret.key. */
  root: string;
  /** Public origin, e.g. https://relay.example.com. Unsafe requests must come from it. */
  origin: string;
  /** Where verified backup snapshots and their blob pool are written. */
  backupDir: string;
  /** Operator-controlled automatic backup schedule and retention. */
  backupIntervalHours: number;
  backupKeep: number;
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
  const root = resolve(env.RELAY_DATA || ".data");
  const backupIntervalHours = operatorInteger(
    env.RELAY_BACKUP_INTERVAL_HOURS,
    "RELAY_BACKUP_INTERVAL_HOURS",
    1,
    720,
    DEFAULT_BACKUP_INTERVAL_HOURS,
  );
  const backupKeep = operatorInteger(env.RELAY_BACKUP_KEEP, "RELAY_BACKUP_KEEP", 1, 365, DEFAULT_BACKUP_KEEP);
  return {
    root,
    origin: env.RELAY_ORIGIN || `http://localhost:${port}`,
    backupDir: resolve(env.RELAY_BACKUP_DIR || `${root}/backups`),
    backupIntervalHours,
    backupKeep,
    adminPassword: env.RELAY_ADMIN_PASSWORD,
    secret: env.RELAY_SECRET,
    trustProxy: (env.RELAY_TRUST_PROXY || "127.0.0.1,::1").split(",").map((s) => s.trim()),
    tabLeaseMs: 5 * 60_000,
    sweepMs: 60_000,
    logger: true,
    serveClient: true,
  };
}

function operatorInteger(value: string | undefined, name: string, min: number, max: number, fallback: number) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}
