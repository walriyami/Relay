import { buildApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { setupStateOf } from "./modules/setup/index.ts";
import { setupKeyPath } from "./modules/setup/setup-key.ts";

const config = configFromEnv();
const { app, ctx } = await buildApp(config);
const port = Number(process.env.PORT || 3090);
await app.listen({ port, host: process.env.HOST || "127.0.0.1" });
if (setupStateOf(ctx) !== "done") {
  const key =
    config.setupKey && setupStateOf(ctx) === "account"
      ? ` The setup key is stored at ${setupKeyPath(config.root)}.`
      : "";
  app.log.info(
    `Relay is ready to be set up. Open ${config.origin ?? `http://localhost:${port}`} in your browser to continue.${key}`,
  );
}
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  });
