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
// RELAY_TEST_LOCAL=<UDP port> adds direct transfers, as tests/browser/direct.spec.ts needs: the helper
// Relay runs, which browsers on this machine reach the way they would at home.
const localPort = Number(process.env.RELAY_TEST_LOCAL || 0);
const built = await buildApp(
  testConfig(root, {
    origin: `http://localhost:${port}`,
    serveClient: true,
    ...(localPort ? { local: { port: localPort } } : {}),
  }),
);
const { app } = built;
await setUp(built, PASSWORD);
await app.ready();
// Listening only once browsers can connect, so a page's first try doesn't meet a helper still starting.
for (const started = Date.now(); built.ctx.local && built.ctx.local.state !== "ready";) {
  if (Date.now() - started > 15_000) throw new Error("The direct-transfer helper didn't start.");
  await new Promise((resolve) => setTimeout(resolve, 50));
}
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
