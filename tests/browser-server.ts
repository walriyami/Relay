import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeDataChannel from "node-datachannel";
import { buildApp } from "../server/app.ts";
import { lanAddresses } from "../local/addresses.ts";
import { startHelper } from "../local/helper.ts";
import { testConfig } from "./support/config.ts";
import { setUp } from "./support/harness.ts";

/** The administrator's password in browser tests; see tests/browser/helpers.ts. */
const PASSWORD = "Browser-test-password-only";

const root = await mkdtemp(join(tmpdir(), "relay-browser-"));
const port = Number(process.env.RELAY_TEST_PORT || 3091);
// RELAY_TEST_LOCAL=<UDP port> adds direct transfers, as tests/browser/direct.spec.ts needs: a helper
// that browsers on this machine reach at its own network address, the way they would at home.
const localPort = Number(process.env.RELAY_TEST_LOCAL || 0);
const local = localPort ? join(root, "local") : undefined;
const built = await buildApp(
  testConfig(root, { origin: `http://localhost:${port}`, serveClient: true, ...(local ? { local } : {}) }),
);
const { app } = built;
await setUp(built, PASSWORD);
await app.listen({ host: "localhost", port });
const helper = local
  ? await startHelper({
      dir: local,
      port: localPort,
      addresses: () => (lanAddresses().length ? lanAddresses() : ["127.0.0.1"]),
      log: (level, msg, fields) => console.error(level, msg, fields ?? ""),
    })
  : null;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(
    signal,
    () =>
      void (helper?.close() ?? Promise.resolve())
        .then(() => app.close())
        .then(() => rm(root, { recursive: true, force: true }))
        .then(() => {
          if (helper) nodeDataChannel.cleanup();
          process.exit(0);
        }),
  );
