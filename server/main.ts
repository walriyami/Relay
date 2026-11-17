import { buildApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { setupStateOf } from "./modules/setup/index.ts";
import { ensureSetupKey, setupKeyPath } from "./modules/setup/setup-key.ts";
import { shutdown } from "./shutdown.ts";

/**
 * Problems the owner can act on (a damaged or refused database, a second copy of Relay on the same
 * data) are explained in plain words, without a stack trace to dig through. Anything else crashes
 * as usual so its trace reaches the log.
 */
function explained(error: unknown) {
  const { code, message, detail } = error as { code?: unknown; message?: string; detail?: string };
  if (typeof code !== "string" || !code.startsWith("RELAY_")) return false;
  process.stderr.write(`\nRelay could not start.\n\n${message}\n${detail ? `\nDetails: ${detail}\n` : ""}\n`);
  return true;
}

const config = configFromEnv();
let built: Awaited<ReturnType<typeof buildApp>>;
try {
  built = await buildApp(config);
} catch (error) {
  if (!explained(error)) throw error;
  process.exit(1);
}
const { app, ctx } = built;
if (ctx.db.upgraded.length) app.log.info({ changes: ctx.db.upgraded }, "database brought up to date with schema.sql");
if (ctx.db.rebuiltStoredTypes) app.log.info("storage totals by file type rebuilt from the stored files");
const port = Number(process.env.PORT || 3090);
await app.listen({ port, host: process.env.HOST || "127.0.0.1" });
if (setupStateOf(ctx) !== "done") {
  // The owner reads the key here (walctl logs, docker logs, the terminal); only they see the log.
  const key =
    config.setupKey && setupStateOf(ctx) === "account"
      ? ` Setup key: ${ensureSetupKey(config.root)} (also saved in ${setupKeyPath(config.root)} until setup).`
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
    void shutdown(app).then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  });
