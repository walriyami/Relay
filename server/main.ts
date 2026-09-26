import { buildApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { setupStateOf } from "./modules/setup/index.ts";

const config = configFromEnv();
const { app, ctx } = await buildApp(config);
const port = Number(process.env.PORT || 3090);
await app.listen({ port, host: process.env.HOST || "127.0.0.1" });
if (setupStateOf(ctx) !== "done")
  app.log.info(
    `Relay is ready to be set up. Open ${config.origin ?? `http://localhost:${port}`} in your browser to create the administrator account.`,
  );
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
