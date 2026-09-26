import { buildApp } from "./app.ts";
import { configFromEnv } from "./config.ts";

const config = configFromEnv();
const { app } = await buildApp(config);
await app.listen({ port: Number(process.env.PORT || 3090), host: process.env.HOST || "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
