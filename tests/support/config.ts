import { join } from "node:path";
import { DEFAULT_BACKUP_INTERVAL_HOURS, DEFAULT_BACKUP_KEEP, type Config } from "../../server/config.ts";

/** Disposable-directory configuration for tests. Never point this at real data. */
export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    root,
    origin: "http://relay.test",
    backupDir: join(root, "backups"),
    backupIntervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
    backupKeep: DEFAULT_BACKUP_KEEP,
    adminPassword: "Test-admin-password-only",
    secret: "test-secret-key-that-is-long-enough-000",
    trustProxy: ["127.0.0.1"],
    tabLeaseMs: 5 * 60_000,
    sweepMs: 3_600_000,
    logger: false,
    serveClient: false,
    ...overrides,
  };
}
