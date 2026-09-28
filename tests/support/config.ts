import type { Config } from "../../server/config.ts";

/** Disposable-directory configuration for tests. Never point this at real data. */
export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  return {
    root,
    origin: "http://relay.test",
    secret: "test-secret-key-that-is-long-enough-000",
    trustProxy: ["127.0.0.1"],
    setupKey: false,
    tabLeaseMs: 5 * 60_000,
    sweepMs: 3_600_000,
    logger: false,
    serveClient: false,
    ...overrides,
  };
}
