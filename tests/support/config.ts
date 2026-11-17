import type { Config } from "../../server/config.ts";
import { useTestPasswordCost } from "../../server/lib/secrets.ts";

// Every disposable instance hashes passwords cheaply; see useTestPasswordCost.
useTestPasswordCost();

/** Disposable-directory configuration for tests. Never point this at real data. */
export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    root,
    origin: "http://relay.test",
    secret: "test-secret-key-that-is-long-enough-000",
    trustProxy: ["127.0.0.1"],
    setupKey: false,
    tabLeaseMs: 5 * 60_000,
    pausedUploadMs: 24 * 60 * 60_000,
    sweepMs: 3_600_000,
    logger: false,
    serveClient: false,
    ...overrides,
  };
}
