import { createSocket } from "node:dgram";
import { resolve } from "node:path";
import nodeDataChannel from "node-datachannel";
import { lanAddresses, parseAddresses } from "./addresses.ts";
import { startHelper, type HelperOptions } from "./helper.ts";

// Logs the way Relay's server does: one JSON object per line.
const LEVELS = { info: 30, warn: 40, error: 50 } as const;
const log: HelperOptions["log"] = (level, msg, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ level: LEVELS[level], time: Date.now(), ...fields, msg })}\n`);

function config(env = process.env) {
  if (!env.RELAY_LOCAL) throw new Error("RELAY_LOCAL must name the directory shared with Relay.");
  const port = Number(env.RELAY_LOCAL_PORT || 3090);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("RELAY_LOCAL_PORT must be a UDP port number.");
  const fixed = env.RELAY_LOCAL_ADDRESSES ? parseAddresses(env.RELAY_LOCAL_ADDRESSES) : null;
  return { dir: resolve(env.RELAY_LOCAL), port, addresses: () => fixed ?? lanAddresses() };
}

/** Fails at startup, naming the port, rather than leaving every connection to time out. */
function checkPort(port: number) {
  return new Promise<void>((done, fail) => {
    const socket = createSocket("udp4");
    socket.once("error", (error: NodeJS.ErrnoException) =>
      fail(new Error(error.code === "EADDRINUSE" ? `UDP port ${port} is already in use.` : error.message)),
    );
    socket.bind(port, () => socket.close(() => done()));
  });
}

const options = config();
await checkPort(options.port);
nodeDataChannel.initLogger("Error", (_level, message) => log("error", message, { source: "libdatachannel" }));
const helper = await startHelper({ ...options, log });
const addresses = options.addresses();
if (addresses.length) log("info", `Direct transfers are ready at ${addresses.join(", ")} on UDP port ${options.port}.`);
else log("warn", "This host has no local network address yet; direct transfers start once it has one.");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    void helper.close().finally(() => {
      nodeDataChannel.cleanup();
      process.exit(0);
    });
  });
