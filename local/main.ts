// The direct-transfer helper's process. Relay starts it (see server/modules/local) with the private
// directory the two share, the UDP port to use and any addresses to announce (RELAY_DIRECT_ADDRESSES), hears from it over their IPC channel, and runs
// it until Relay stops it or goes away itself.
import { createSocket } from "node:dgram";
import nodeDataChannel from "node-datachannel";
import type { HelperMessage } from "../shared/local.ts";
import { lanAddresses } from "./addresses.ts";
import { startHelper, type HelperOptions } from "./helper.ts";

const send = (message: HelperMessage, then = () => {}) => {
  if (process.connected) process.send!(message, then);
  else then();
};
const log: HelperOptions["log"] = (level, msg, fields) => send({ type: "log", level, msg, fields });

/** Fails at startup, naming the port, rather than leaving every connection to fail. */
function checkPort(port: number) {
  return new Promise<void>((done, fail) => {
    const socket = createSocket("udp4");
    socket.once("error", (error: NodeJS.ErrnoException) =>
      fail(new Error(error.code === "EADDRINUSE" ? `UDP port ${port} is already in use.` : error.message)),
    );
    socket.bind(port, () => socket.close(() => done()));
  });
}

const dir = process.argv[2];
const port = Number(process.argv[3]);
// Fixed addresses stand in for the host's when Relay runs in a container that can't see them.
const fixed = (process.argv[4] ?? "").split(",").filter(Boolean);
if (!process.send || !dir || !Number.isInteger(port)) {
  process.stderr.write("The direct-transfer helper is started by Relay.\n");
  process.exit(1);
}
// Relay decides when this stops; an interrupt meant for the whole terminal reaches Relay too.
process.on("SIGINT", () => {});

try {
  await checkPort(port);
} catch (error) {
  send({ type: "failed", reason: (error as Error).message }, () => process.exit(1));
  await new Promise(() => {});
}
nodeDataChannel.initLogger("Error", (_level, message) => log("error", message, { source: "libdatachannel" }));
// Otherwise addresses are looked up for every connection, so a host that changes networks needs no restart.
const helper = await startHelper({ dir, port, addresses: () => (fixed.length ? fixed : lanAddresses()), log });
send({ type: "ready" });

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void helper.close().finally(() => {
    nodeDataChannel.cleanup();
    process.exit(0);
  });
};
process.once("SIGTERM", stop);
// Relay went away without stopping it.
process.once("disconnect", stop);
