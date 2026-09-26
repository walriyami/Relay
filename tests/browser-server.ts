import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { testConfig } from "./support/config.ts";
import { setUp } from "./support/harness.ts";

/** The administrator's password in browser tests; see tests/browser/helpers.ts. */
const PASSWORD = "Browser-test-password-only";

const root = await mkdtemp(join(tmpdir(), "relay-browser-"));
const port = Number(process.env.RELAY_TEST_PORT || 3091);
const built = await buildApp(testConfig(root, { origin: `http://localhost:${port}`, serveClient: true }));
const { app } = built;
await setUp(built, PASSWORD);
await app.listen({ host: "localhost", port });
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(
    signal,
    () =>
      void app
        .close()
        .then(() => rm(root, { recursive: true, force: true }))
        .then(() => process.exit(0)),
  );
