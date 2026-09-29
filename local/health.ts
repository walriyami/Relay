// Container health check: the helper answers on its socket.
import { request } from "node:http";
import { join } from "node:path";
import { SOCKETS } from "../shared/local.ts";

const req = request(
  { socketPath: join(process.env.RELAY_LOCAL ?? "", SOCKETS.helper), path: "/status", timeout: 3000 },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1),
);
req.on("timeout", () => req.destroy());
req.on("error", () => process.exit(1));
req.end();
